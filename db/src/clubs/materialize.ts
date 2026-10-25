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
 * so the bookers are told and the attendance record survives.
 *
 * A class in a ROOM (0048) claims it per occurrence, so the order matters:
 * the reconcile runs FIRST (a class moved from 18:00 to 18:30 must let go of
 * its 18:00 claims before claiming 18:30), and each new occurrence is inserted
 * under its own savepoint — one that collides with a booking or a closure is
 * skipped and reported (`conflicts`), never allowed to stall the whole class.
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
  /** Occurrences not created because their room was taken (0048). */
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
    const cancelled = await client.query(
      `UPDATE club_class_occurrences o
          SET status = 'cancelled', cancelled_at = now(), cancellation_scope = 'series'
        WHERE o.class_id = $1::uuid AND o.status = 'scheduled'
          AND o.starts_at >= greatest($2::timestamptz, now()) AND o.starts_at < $3::timestamptz
          AND o.starts_at <> ALL($4::timestamptz[])
          AND (EXISTS (SELECT 1 FROM club_bookings b WHERE b.occurrence_id = o.id AND b.state = 'active')
               OR EXISTS (SELECT 1 FROM club_checkins c WHERE c.occurrence_id = o.id))`,
      bounds,
    );
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
