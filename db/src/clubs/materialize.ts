import { expandRrule, formatWall, parseWall, type Occurrence } from '@sportkarta/lib/recurrence';
import type pg from 'pg';

import { HORIZON_WEEKS } from '../sessions/materialize.js';

/**
 * Rolling occurrence materialization for CLUB classes (0042) — the pg-boss job
 * `club.materialize`, hourly and right after a class is created or edited.
 *
 * The same engine and the same three properties as db/src/sessions/
 * materialize.ts, whose header argues them: IDEMPOTENT (ON CONFLICT
 * (class_id, starts_at) DO NOTHING), WINDOW-STABLE (expandRrule over [a,c) is
 * [a,b) ∪ [b,c)), ISOLATED PER CLASS (one transaction each; a bad rule fails
 * alone and is reported by code, never by message — a class title is user
 * text).
 *
 * Reconciling an edited rule never touches an occurrence that has started, and
 * never deletes one with a booking or a check-in: those are cancelled instead,
 * so the attendance record survives — and the report NAMES the cancelled ones
 * somebody was booked on (`cancelledOccurrenceIds`), because that is the only
 * way the worker can tell the bookers (it enqueues `class_cancelled` for them).
 *
 * The dates the rule STILL has are reconciled too:
 *   - a duration edit reaches the occurrences already on the calendar
 *     (`ends_at`, and with it the room's claim);
 *   - a date this job cancelled for an earlier edit (scope 'series') and that
 *     the rule has again — the time was changed back — is put back on ONLY
 *     when nobody is booked on it and nobody was told it is off: a booker who
 *     was told keeps believing it, and the notice ledger sends a date's
 *     cancellation to a person once (its key is the occurrence and the
 *     member — lib/src/clubs/vocab.ts `dedupeKey`), so a date brought back
 *     after its notice could never announce a second cancellation to them.
 *     Those dates stay off. A date the office cancelled by hand (scope
 *     'occurrence') is a decision and is never brought back, and a cancelled
 *     CLASS never gets here at all (only a scheduled class is materialized).
 *
 * A class in a ROOM (0048) claims it per occurrence, so the order matters:
 * the reconcile runs FIRST (a class moved from 18:00 to 18:30 must let go of
 * its 18:00 claims before claiming 18:30), and each occurrence is inserted,
 * re-timed or put back on under its own savepoint — one that collides with a
 * booking or a closure is skipped and reported (`conflicts`), never allowed to
 * stall the whole class.
 */

const LOOKBACK_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface ClubMaterializeOptions {
  now?: Date;
  horizonWeeks?: number;
  classId?: string;
  limit?: number;
}

export interface ClubMaterializeReport {
  classesProcessed: number;
  occurrencesCreated: number;
  occurrencesCancelled: number;
  occurrencesRemoved: number;
  /** Dates an earlier edit had cancelled, back in the rule and on again. */
  occurrencesReinstated: number;
  /** Occurrences whose end followed the class's edited duration. */
  occurrencesRetimed: number;
  /**
   * Of the cancelled, those somebody was booked on — the bookers are owed a
   * `class_cancelled` notice, which the caller enqueues. Ids only.
   */
  cancelledOccurrenceIds: string[];
  /**
   * Occurrences not created — or not given their new end, or not put back on —
   * because their room was taken (0048).
   */
  conflicts: { classId: string; startsAt: string }[];
  failures: { classId: string; code: string }[];
}

interface ClassRow {
  id: string;
  club_id: string;
  starts_at_local: string;
  timezone: string;
  rrule: string | null;
  duration_minutes: number;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

export async function materializeClubClasses(
  pool: pg.Pool,
  options: ClubMaterializeOptions = {},
): Promise<ClubMaterializeReport> {
  const now = options.now ?? new Date();
  const horizon = new Date(now.getTime() + (options.horizonWeeks ?? HORIZON_WEEKS) * WEEK_MS);
  const from = new Date(now.getTime() - LOOKBACK_MS);
  const report: ClubMaterializeReport = {
    classesProcessed: 0,
    occurrencesCreated: 0,
    occurrencesCancelled: 0,
    occurrencesRemoved: 0,
    occurrencesReinstated: 0,
    occurrencesRetimed: 0,
    cancelledOccurrenceIds: [],
    conflicts: [],
    failures: [],
  };

  const ids = options.classId
    ? [options.classId]
    : (
        await pool.query<{ id: string }>(
          `SELECT k.id FROM club_classes k
             JOIN clubs c ON c.id = k.club_id
            WHERE k.status = 'scheduled' AND c.status IN ('active', 'pending')
              AND (k.materialized_through IS NULL OR k.materialized_through < $1)
            ORDER BY k.materialized_through ASC NULLS FIRST
            LIMIT $2`,
          [horizon.toISOString(), options.limit ?? 500],
        )
      ).rows.map((row) => row.id);

  for (const classId of ids) {
    try {
      if (await materializeOne(pool, classId, from, horizon, report)) report.classesProcessed += 1;
    } catch (error: unknown) {
      report.failures.push({ classId, code: errorCode(error) });
    }
  }
  return report;
}

async function materializeOne(
  pool: pg.Pool,
  classId: string,
  from: Date,
  horizon: Date,
  report: ClubMaterializeReport,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Read as TEXT: node-postgres would parse a `timestamp` through the host
    // timezone (the sessions materializer's warning).
    const found = await client.query<ClassRow>(
      `SELECT id, club_id,
              to_char(starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
              timezone, rrule, duration_minutes
         FROM club_classes
        WHERE id = $1 AND status = 'scheduled'
        FOR NO KEY UPDATE`,
      [classId],
    );
    const row = found.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return false;
    }

    let occurrences: Occurrence[];
    try {
      occurrences = expandRrule(
        {
          dtstart: parseWall(row.starts_at_local),
          timeZone: row.timezone,
          durationMinutes: row.duration_minutes,
          rrule: row.rrule,
        },
        { from, to: horizon },
      );
    } catch (error: unknown) {
      // Park a rule the engine rejects at the back of the queue (see the
      // sessions materializer); editing the class resets materialized_through.
      await client.query(`UPDATE club_classes SET materialized_through = $2 WHERE id = $1`, [
        classId,
        horizon.toISOString(),
      ]);
      await client.query('COMMIT');
      throw error;
    }

    const keep = occurrences.map((o) => o.startsAt.toISOString());
    const bounds = [classId, from.toISOString(), horizon.toISOString(), keep];
    const cancelled = await client.query<{ id: string; booked: boolean }>(
      `UPDATE club_class_occurrences o
          SET status = 'cancelled', cancelled_at = now(), cancellation_scope = 'series'
        WHERE o.class_id = $1::uuid AND o.status = 'scheduled'
          AND o.starts_at >= greatest($2::timestamptz, now()) AND o.starts_at < $3::timestamptz
          AND o.starts_at <> ALL($4::timestamptz[])
          AND (EXISTS (SELECT 1 FROM club_bookings b WHERE b.occurrence_id = o.id AND b.state = 'active')
               OR EXISTS (SELECT 1 FROM club_checkins c WHERE c.occurrence_id = o.id))
        RETURNING o.id,
                  EXISTS (SELECT 1 FROM club_bookings b
                           WHERE b.occurrence_id = o.id AND b.state = 'active') AS booked`,
      bounds,
    );
    // Only a date somebody is booked on is anybody's news (one kept for its
    // check-in alone has nobody to tell).
    for (const gone of cancelled.rows) {
      if (gone.booked) report.cancelledOccurrenceIds.push(gone.id);
    }
    const removed = await client.query(
      `DELETE FROM club_class_occurrences o
        WHERE o.class_id = $1::uuid AND o.status = 'scheduled'
          AND o.starts_at >= greatest($2::timestamptz, now()) AND o.starts_at < $3::timestamptz
          AND o.starts_at <> ALL($4::timestamptz[])
          AND NOT EXISTS (SELECT 1 FROM club_checkins c WHERE c.occurrence_id = o.id)`,
      bounds,
    );
    report.occurrencesCancelled += cancelled.rowCount ?? 0;
    report.occurrencesRemoved += removed.rowCount ?? 0;

    // The dates the rule still has, not yet begun, that no longer agree with
    // it (see the header): a scheduled one whose end is not the class's
    // duration any more, and one an earlier edit cancelled that nobody is
    // booked on and nobody was told about. Row by row under a savepoint —
    // putting a date back on, or making it longer, re-claims its room, and a
    // room taken at one date must skip that date, not the class.
    const stale = await client.query<{ id: string; starts_at: Date; reinstate: boolean }>(
      `SELECT o.id, o.starts_at, (o.status = 'cancelled') AS reinstate
         FROM club_class_occurrences o
         JOIN unnest($4::timestamptz[], $5::timestamptz[]) AS w(s, e) ON w.s = o.starts_at
        WHERE o.class_id = $1::uuid
          AND o.starts_at >= greatest($2::timestamptz, now()) AND o.starts_at < $3::timestamptz
          AND ((o.status = 'scheduled' AND o.ends_at <> w.e)
               OR (o.status = 'cancelled' AND o.cancellation_scope = 'series'
                   AND NOT EXISTS (SELECT 1 FROM club_bookings b
                                    WHERE b.occurrence_id = o.id AND b.state = 'active')
                   AND NOT EXISTS (SELECT 1 FROM club_bookings b
                                     JOIN club_notifications n
                                       ON n.club_id = b.club_id
                                      AND n.dedupe_key = 'class_cancelled:' || b.occurrence_id::text
                                                         || ':' || b.member_id::text
                                    WHERE b.occurrence_id = o.id)))
        ORDER BY o.starts_at`,
      [...bounds, occurrences.map((o) => o.endsAt.toISOString())],
    );
    const endOf = new Map(occurrences.map((o) => [o.startsAt.getTime(), o.endsAt.toISOString()]));
    for (const row of stale.rows) {
      const startsAt = new Date(row.starts_at);
      const endsAt = endOf.get(startsAt.getTime());
      if (!endsAt) continue;
      await client.query('SAVEPOINT occurrence');
      try {
        await client.query(
          `UPDATE club_class_occurrences
              SET status = 'scheduled', cancelled_at = NULL, cancellation_scope = NULL,
                  ends_at = $2::timestamptz
            WHERE id = $1::uuid`,
          [row.id, endsAt],
        );
        await client.query('RELEASE SAVEPOINT occurrence');
        if (row.reinstate) report.occurrencesReinstated += 1;
        else report.occurrencesRetimed += 1;
      } catch (error: unknown) {
        await client.query('ROLLBACK TO SAVEPOINT occurrence');
        if (errorCode(error) !== '23P01') throw error;
        report.conflicts.push({ classId, startsAt: startsAt.toISOString() });
      }
    }

    // After the reconcile (see the header): one savepoint per occurrence, so a
    // room taken at one date skips that date and reports it.
    for (const o of occurrences) {
      await client.query('SAVEPOINT occurrence');
      try {
        const inserted = await client.query(
          `INSERT INTO club_class_occurrences
             (club_id, class_id, starts_at, ends_at, starts_at_local, dst_resolution)
           VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, $5::timestamp, $6)
           ON CONFLICT (class_id, starts_at) DO NOTHING`,
          [
            row.club_id,
            classId,
            o.startsAt.toISOString(),
            o.endsAt.toISOString(),
            formatWall(o.wall),
            o.resolution,
          ],
        );
        await client.query('RELEASE SAVEPOINT occurrence');
        report.occurrencesCreated += inserted.rowCount ?? 0;
      } catch (error: unknown) {
        await client.query('ROLLBACK TO SAVEPOINT occurrence');
        if (errorCode(error) !== '23P01') throw error;
        report.conflicts.push({ classId, startsAt: o.startsAt.toISOString() });
      }
    }

    await client.query(`UPDATE club_classes SET materialized_through = $2 WHERE id = $1`, [
      classId,
      horizon.toISOString(),
    ]);
    await client.query('COMMIT');
    return true;
  } catch (error: unknown) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
