import { expandRrule, parseWall, formatWall, type Occurrence } from '@sportkarta/lib/recurrence';
import type pg from 'pg';

/**
 * Rolling 8-week occurrence materialization (docs/ROADMAP.md §6, Stage 4.1).
 *
 * Runs as the pg-boss job `session.materialize` (apps/worker), hourly, so the
 * window rolls forward on its own. Sits beside stats.ts and is called by the
 * worker the same way refreshStats is.
 *
 * Three properties make it safe to run at any cadence, from any number of
 * workers, on any schedule:
 *
 *  1. IDEMPOTENT. Inserts are ON CONFLICT (session_id, starts_at) DO NOTHING
 *     against a UNIQUE index — the same argument as points_ledger. A re-run
 *     creates nothing, and a cancelled occurrence is never resurrected.
 *  2. WINDOW-STABLE. expandRrule over [a,c) equals [a,b) ∪ [b,c) (proven in
 *     lib/src/recurrence/dst.test.ts), so topping up incrementally can neither
 *     duplicate nor lose an occurrence.
 *  3. ISOLATED PER SERIES. One transaction each, so a series whose rule the
 *     engine rejects fails alone and is reported, rather than stopping the run.
 *
 * The lock on the series row is taken FIRST and deliberately: GDPR erasure
 * touches play_sessions (the organizer_id SET NULL) and then, through the
 * cancel cascade, play_session_occurrences. Taking the same two in the same
 * order here means this job and an erasure cannot deadlock — and if they could,
 * the victim might be the erasure, which must never fail.
 */

/** The rolling window, in weeks. Stage 4.1's "rolling 8-week window". */
export const HORIZON_WEEKS = 8;

/**
 * How far back the window starts. A series created moments ago should still get
 * today's occurrence, and an occurrence in progress should not be reconciled
 * away underneath the people at it.
 */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface MaterializeOptions {
  /** Injectable for tests; defaults to the wall clock. */
  now?: Date;
  horizonWeeks?: number;
  /** Materialize one series only — used right after create/update. */
  sessionId?: string;
  /** Cap on series per run, so one run cannot hold a connection forever. */
  limit?: number;
}

export interface MaterializeFailure {
  sessionId: string;
  /** A RecurrenceError code, or 'unknown'. Never the message: no PII in logs. */
  code: string;
}

export interface MaterializeReport {
  seriesProcessed: number;
  occurrencesCreated: number;
  /** Orphans that had RSVPs, so they were cancelled rather than removed. */
  occurrencesCancelled: number;
  /** Orphans nobody had signed up for. */
  occurrencesRemoved: number;
  failures: MaterializeFailure[];
}

interface SeriesRow {
  id: string;
  starts_at_local: string;
  timezone: string;
  rrule: string | null;
  duration_minutes: number;
}

export async function materializeSessions(
  pool: pg.Pool,
  options: MaterializeOptions = {},
): Promise<MaterializeReport> {
  const now = options.now ?? new Date();
  const horizon = new Date(now.getTime() + (options.horizonWeeks ?? HORIZON_WEEKS) * WEEK_MS);
  const from = new Date(now.getTime() - LOOKBACK_MS);

  const report: MaterializeReport = {
    seriesProcessed: 0,
    occurrencesCreated: 0,
    occurrencesCancelled: 0,
    occurrencesRemoved: 0,
    failures: [],
  };

  for (const sessionId of await pendingSeriesIds(pool, horizon, options)) {
    try {
      // A series cancelled between the scan and the lock is skipped, not
      // processed — the count means "series actually expanded".
      if (await materializeOne(pool, sessionId, from, horizon, report)) {
        report.seriesProcessed += 1;
      }
    } catch (error: unknown) {
      // One bad rule must not stop the run. The code is a slug, never the
      // message — a message could carry a session title, which is user text.
      report.failures.push({ sessionId, code: errorCode(error) });
    }
  }

  return report;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown';
}

async function pendingSeriesIds(
  pool: pg.Pool,
  horizon: Date,
  options: MaterializeOptions,
): Promise<string[]> {
  if (options.sessionId) return [options.sessionId];
  // NULLS FIRST matches play_sessions_materialize_idx: never-materialized series
  // are the ones a member is waiting on.
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM play_sessions
      WHERE status = 'scheduled'
        AND (materialized_through IS NULL OR materialized_through < $1)
      ORDER BY materialized_through ASC NULLS FIRST
      LIMIT $2`,
    [horizon.toISOString(), options.limit ?? 500],
  );
  return result.rows.map((row) => row.id);
}

/** Returns false when the series was gone or already cancelled: nothing to do. */
async function materializeOne(
  pool: pg.Pool,
  sessionId: string,
  from: Date,
  horizon: Date,
  report: MaterializeReport,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FOR NO KEY UPDATE, not FOR UPDATE: this does not change the key, and the
    // weaker lock still serialises two materializer runs against each other
    // while staying compatible with the foreign keys pointing at this row.
    // starts_at_local is read as TEXT on purpose — node-postgres parses
    // `timestamp without time zone` through the host's system timezone, which
    // would make the same row mean different instants on a CI box and a laptop.
    const series = await client.query<SeriesRow>(
      `SELECT id,
              to_char(starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
              timezone, rrule, duration_minutes
         FROM play_sessions
        WHERE id = $1 AND status = 'scheduled'
        FOR NO KEY UPDATE`,
      [sessionId],
    );
    const row = series.rows[0];
    if (!row) {
      // Cancelled or deleted between the scan and here — nothing to do, and
      // deliberately not an error.
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
      // A rule this engine cannot expand will fail identically every hour. The
      // scan is ordered by materialized_through NULLS FIRST, so leaving it NULL
      // would park the broken series permanently at the head of the batch and,
      // with enough of them, starve every working series out of the LIMIT.
      // Stamping the horizon sends it to the back instead. It is not "done":
      // the failure is still reported, and editing the series sets
      // materialized_through back to NULL (updateSession), so a fix is picked
      // up immediately.
      await client.query(`UPDATE play_sessions SET materialized_through = $2 WHERE id = $1`, [
        sessionId,
        horizon.toISOString(),
      ]);
      await client.query('COMMIT');
      throw error;
    }

    report.occurrencesCreated += await insertOccurrences(client, sessionId, occurrences);
    const reconciled = await reconcileOrphans(client, sessionId, occurrences, from, horizon);
    report.occurrencesCancelled += reconciled.cancelled;
    report.occurrencesRemoved += reconciled.removed;

    await client.query(`UPDATE play_sessions SET materialized_through = $2 WHERE id = $1`, [
      sessionId,
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

async function insertOccurrences(
  client: pg.PoolClient,
  sessionId: string,
  occurrences: Occurrence[],
): Promise<number> {
  if (occurrences.length === 0) return 0;
  const result = await client.query(
    `INSERT INTO play_session_occurrences
       (session_id, starts_at, ends_at, starts_at_local, dst_resolution)
     SELECT $1::uuid, o.starts_at, o.ends_at, o.starts_at_local,
            o.dst_resolution::play_session_dst_resolution
       FROM unnest($2::timestamptz[], $3::timestamptz[], $4::timestamp[], $5::text[])
         AS o(starts_at, ends_at, starts_at_local, dst_resolution)
     ON CONFLICT (session_id, starts_at) DO NOTHING`,
    [
      sessionId,
      occurrences.map((o) => o.startsAt.toISOString()),
      occurrences.map((o) => o.endsAt.toISOString()),
      occurrences.map((o) => formatWall(o.wall)),
      occurrences.map((o) => o.resolution),
    ],
  );
  return result.rowCount ?? 0;
}

/**
 * Occurrences inside the window that the rule no longer produces — the result
 * of an edited rule, a shortened UNTIL, or a changed start time.
 *
 * Ones nobody signed up for are removed outright. Ones with active RSVPs are
 * CANCELLED instead, because deleting them would silently un-invite people who
 * are expecting to play: a cancelled row is what the notification is addressed
 * to. Cancelling first and deleting second is what keeps the two disjoint.
 *
 * TWO BOUNDS DO REAL WORK HERE. The lower bound is `now()`, not the expansion
 * window's `from`: the window reaches a day into the past so a just-created
 * series still gets today's occurrence, but reconciliation must never touch an
 * occurrence that has already started. Editing a rule would otherwise DELETE a
 * session that happened this morning — and `play_session_checkins` cascades, so
 * it would take the attendance record with it. The `EXISTS` guard covers
 * check-ins as well as RSVPs for the same reason, belt and braces.
 */
async function reconcileOrphans(
  client: pg.PoolClient,
  sessionId: string,
  occurrences: Occurrence[],
  from: Date,
  horizon: Date,
): Promise<{ cancelled: number; removed: number }> {
  const keep = occurrences.map((o) => o.startsAt.toISOString());
  const bounds = [sessionId, from.toISOString(), horizon.toISOString(), keep];

  const cancelled = await client.query(
    `UPDATE play_session_occurrences o
        SET status = 'cancelled', cancelled_at = now(), cancellation_scope = 'series'
      WHERE o.session_id = $1::uuid
        AND o.status = 'scheduled'
        AND o.starts_at >= greatest($2::timestamptz, now())
        AND o.starts_at < $3::timestamptz
        AND o.starts_at <> ALL($4::timestamptz[])
        AND (EXISTS (SELECT 1 FROM play_session_rsvps r
                      WHERE r.occurrence_id = o.id AND r.state = 'active')
             OR EXISTS (SELECT 1 FROM play_session_checkins c
                         WHERE c.occurrence_id = o.id))`,
    bounds,
  );

  const removed = await client.query(
    `DELETE FROM play_session_occurrences o
      WHERE o.session_id = $1::uuid
        AND o.status = 'scheduled'
        AND o.starts_at >= greatest($2::timestamptz, now())
        AND o.starts_at < $3::timestamptz
        AND o.starts_at <> ALL($4::timestamptz[])
        AND NOT EXISTS (SELECT 1 FROM play_session_checkins c
                         WHERE c.occurrence_id = o.id)`,
    bounds,
  );

  return { cancelled: cancelled.rowCount ?? 0, removed: removed.rowCount ?? 0 };
}
