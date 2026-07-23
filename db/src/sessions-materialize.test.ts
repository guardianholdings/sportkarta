import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { materializeSessions } from './sessions/materialize.js';

/**
 * The rolling 8-week materializer (docs/ROADMAP.md §6, Stage 4.1).
 *
 * Two things are being proven. First that the window really is 8 weeks and
 * really does roll. Second — and this is the one that matters operationally —
 * that running it again changes nothing: it is an INSERT ... ON CONFLICT DO
 * NOTHING against a UNIQUE index, so any cadence, any number of workers and any
 * retry converge on the same rows.
 *
 * There is also a cross-engine check here that JS and PostgreSQL agree about
 * Europe/Sofia. lib/src/recurrence/dst.test.ts proves the engine correct against
 * Node's ICU; this proves the two tz databases in the system say the same thing,
 * which is what the occurrence trigger enforces in production.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const ORGANIZER_ID = 'e2e_materialize_org';
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

describe.skipIf(!hasDb)('session materialization (requires running database)', () => {
  let pool: pg.Pool;
  let client: pg.Client;
  let facilityId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const facility = await client.query<{ id: string }>(
      `SELECT id FROM facilities ORDER BY created_at, id LIMIT 1`,
    );
    facilityId = facility.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
    await pool.end();
  });

  beforeEach(async () => {
    await cleanup();
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Организатор', 'materialize@example.org')`,
      [ORGANIZER_ID],
    );
  });

  async function cleanup(): Promise<void> {
    // play_sessions cascades to occurrences, RSVPs and check-ins.
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1`, [ORGANIZER_ID]);
    await client.query(`DELETE FROM users WHERE id = $1`, [ORGANIZER_ID]);
  }

  async function createSeries(
    startsAtLocal: string,
    rrule: string | null,
    options: { durationMinutes?: number; capacity?: number | null } = {},
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, rrule, duration_minutes, capacity)
       VALUES ($1::uuid, 'basketball', $2, 'Баскетбол', $3::timestamp, $4, $5, $6)
       RETURNING id`,
      [
        facilityId,
        ORGANIZER_ID,
        startsAtLocal,
        rrule,
        options.durationMinutes ?? 90,
        options.capacity ?? null,
      ],
    );
    return result.rows[0]?.id ?? '';
  }

  async function occurrencesOf(
    sessionId: string,
  ): Promise<{ startsAt: string; local: string; status: string; resolution: string }[]> {
    const result = await client.query<{
      starts_at: Date;
      local: string;
      status: string;
      dst_resolution: string;
    }>(
      `SELECT starts_at,
              to_char(starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS local,
              status, dst_resolution
         FROM play_session_occurrences WHERE session_id = $1::uuid ORDER BY starts_at`,
      [sessionId],
    );
    return result.rows.map((row) => ({
      startsAt: row.starts_at.toISOString(),
      local: row.local,
      status: row.status,
      resolution: row.dst_resolution,
    }));
  }

  it('materializes exactly the 8-week window and no further', async () => {
    const now = new Date('2026-01-05T09:00:00Z');
    const sessionId = await createSeries('2026-01-06T18:00:00', 'FREQ=WEEKLY');
    const report = await materializeSessions(pool, { now, sessionId });

    expect(report.failures).toEqual([]);
    const occurrences = await occurrencesOf(sessionId);
    // Weekly from Jan 6 across 8 weeks + the 1-day lookback: 8 Tuesdays.
    expect(occurrences).toHaveLength(8);
    const horizon = now.getTime() + 8 * WEEK_MS;
    for (const occurrence of occurrences) {
      expect(new Date(occurrence.startsAt).getTime()).toBeLessThan(horizon);
      expect(occurrence.local.endsWith('T18:00:00')).toBe(true);
    }
  });

  it('is idempotent — a second run creates nothing', async () => {
    const now = new Date('2026-01-05T09:00:00Z');
    const sessionId = await createSeries('2026-01-06T18:00:00', 'FREQ=WEEKLY');
    const first = await materializeSessions(pool, { now, sessionId });
    const second = await materializeSessions(pool, { now, sessionId });
    const third = await materializeSessions(pool, { now, sessionId });

    expect(first.occurrencesCreated).toBe(8);
    expect(second.occurrencesCreated).toBe(0);
    expect(third.occurrencesCreated).toBe(0);
    expect(second.occurrencesRemoved).toBe(0);
    expect(second.occurrencesCancelled).toBe(0);
  });

  it('rolls forward, adding only the newly-visible occurrences', async () => {
    const sessionId = await createSeries('2026-01-06T18:00:00', 'FREQ=WEEKLY');
    await materializeSessions(pool, { now: new Date('2026-01-05T09:00:00Z'), sessionId });
    const before = await occurrencesOf(sessionId);

    // A week later the horizon has moved a week: exactly one more Tuesday.
    const later = await materializeSessions(pool, {
      now: new Date('2026-01-12T09:00:00Z'),
      sessionId,
    });
    const after = await occurrencesOf(sessionId);

    expect(later.occurrencesCreated).toBe(1);
    expect(after).toHaveLength(before.length + 1);
    // Nothing already materialized was touched.
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it('carries the local wall clock unchanged across the spring transition', async () => {
    // 2026-03-29 is the spring transition. A Sunday 19:00 series spanning it.
    const sessionId = await createSeries('2026-03-08T19:00:00', 'FREQ=WEEKLY');
    await materializeSessions(pool, { now: new Date('2026-03-07T09:00:00Z'), sessionId });
    const occurrences = await occurrencesOf(sessionId);

    expect(occurrences.length).toBeGreaterThan(4);
    for (const occurrence of occurrences) {
      expect(occurrence.local.endsWith('T19:00:00')).toBe(true);
      expect(occurrence.resolution).toBe('exact');
    }
    // The UTC instants are NOT a constant stride apart — which is the whole
    // point, and what the trigger independently confirms on every insert.
    const strides = occurrences
      .slice(1)
      .map(
        (o, i) =>
          new Date(o.startsAt).getTime() -
          new Date((occurrences[i] as (typeof occurrences)[0]).startsAt).getTime(),
      );
    expect(new Set(strides).size).toBe(2);
    expect(strides).toContain(WEEK_MS);
    expect(strides).toContain(WEEK_MS - 60 * 60 * 1000);
  });

  it('agrees with PostgreSQL about Europe/Sofia (property)', async () => {
    // The engine writes starts_at from Node's ICU; the trigger checks it against
    // PostgreSQL's tzdata. If they ever disagreed, every insert here would fail.
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30'),
        fc.constantFrom('2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'),
        fc.integer({ min: 0, max: 23 }),
        async (springDay, autumnDay, hour) => {
          const clock = `${String(hour).padStart(2, '0')}:00:00`;
          for (const day of [springDay, autumnDay]) {
            const sessionId = await createSeries(`${day}T${clock}`, null);
            await materializeSessions(pool, {
              now: new Date(`${day}T00:00:00Z`),
              sessionId,
            });
            const [occurrence] = await occurrencesOf(sessionId);
            expect(occurrence).toBeDefined();
            const row = occurrence as NonNullable<typeof occurrence>;
            // Postgres computed nothing here — it VERIFIED what Node wrote, so
            // reaching this line at all is the cross-engine assertion.
            if (row.resolution === 'gap_shifted') {
              // The only case where the stored clock differs from the requested
              // one: that reading does not exist in Sofia, so it moved forward.
              expect(row.local).not.toBe(`${day}T${clock}`);
            } else {
              // Both 'exact' and 'fold_first' land on the requested reading —
              // the repeated October hour is a real reading, just an ambiguous
              // one, and the engine takes the earlier of its two instants.
              expect(['exact', 'fold_first']).toContain(row.resolution);
              expect(row.local).toBe(`${day}T${clock}`);
            }
            await client.query(`DELETE FROM play_sessions WHERE id = $1::uuid`, [sessionId]);
          }
        },
      ),
      { numRuns: 12 },
    );
  });

  it('reconciles an edited rule: removes empty orphans, cancels ones with RSVPs', async () => {
    // Dates deliberately in the real future: the RSVP guard is a trigger and
    // uses the server's now(), not the injected one.
    const now = new Date('2027-01-05T09:00:00Z');
    const sessionId = await createSeries('2027-01-06T18:00:00', 'FREQ=WEEKLY;BYDAY=TU,TH');
    await materializeSessions(pool, { now });
    const before = await occurrencesOf(sessionId);
    expect(before.length).toBeGreaterThan(10);

    // Somebody signs up for a Thursday, which the edit is about to drop.
    const thursday = await client.query<{ id: string }>(
      `SELECT id FROM play_session_occurrences
        WHERE session_id = $1::uuid AND EXTRACT(ISODOW FROM starts_at_local) = 4
        ORDER BY starts_at LIMIT 1`,
      [sessionId],
    );
    const attendeeId = 'e2e_materialize_attendee';
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Участник', 'mat-attendee@example.org')
       ON CONFLICT (id) DO NOTHING`,
      [attendeeId],
    );
    await client.query(
      `INSERT INTO play_session_rsvps (occurrence_id, user_id) VALUES ($1::uuid, $2)`,
      [thursday.rows[0]?.id, attendeeId],
    );

    // Drop Thursdays.
    await client.query(
      `UPDATE play_sessions SET rrule = 'FREQ=WEEKLY;BYDAY=TU', materialized_through = NULL
        WHERE id = $1::uuid`,
      [sessionId],
    );
    const report = await materializeSessions(pool, { now, sessionId });

    const after = await occurrencesOf(sessionId);
    // The RSVP'd Thursday survives as a cancelled row — deleting it would have
    // silently un-invited someone expecting to play.
    const cancelled = after.filter((o) => o.status === 'cancelled');
    expect(cancelled).toHaveLength(1);
    expect(report.occurrencesCancelled).toBe(1);
    expect(report.occurrencesRemoved).toBeGreaterThan(0);
    // Every surviving scheduled occurrence is a Tuesday.
    for (const occurrence of after.filter((o) => o.status === 'scheduled')) {
      expect(new Date(`${occurrence.local}Z`).getUTCDay()).toBe(2);
    }
    await client.query(`DELETE FROM users WHERE id = $1`, [attendeeId]);
  });

  it('never reconciles away an occurrence that already happened', async () => {
    // play_session_checkins cascades from the occurrence, so deleting one that
    // has already taken place destroys the attendance record with it — and
    // migration 0008 promises the past is never rewritten. The expansion window
    // reaches a day back so a new series still gets today's occurrence; the
    // RECONCILE window must not.
    const sessionId = await createSeries('2026-07-01T18:00:00', 'FREQ=DAILY');
    const attendeeId = 'e2e_materialize_past';
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Играч', 'mat-past@example.org')
       ON CONFLICT (id) DO NOTHING`,
      [attendeeId],
    );
    // An occurrence that started two hours ago, with somebody checked in.
    const past = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       VALUES ($1::uuid, now() - interval '2 hours', now() - interval '30 minutes',
               (now() - interval '2 hours') AT TIME ZONE 'Europe/Sofia')
       RETURNING id`,
      [sessionId],
    );
    await client.query(
      `INSERT INTO play_session_checkins (occurrence_id, user_id, method) VALUES ($1::uuid, $2, 'self')`,
      [past.rows[0]?.id, attendeeId],
    );

    // That occurrence is not on the rule's grid, so reconciliation would target
    // it if the lower bound were the expansion window's.
    await materializeSessions(pool, { now: new Date(), sessionId });

    const survivor = await client.query<{ status: string; n: string }>(
      `SELECT o.status, (SELECT count(*) FROM play_session_checkins c WHERE c.occurrence_id = o.id) AS n
         FROM play_session_occurrences o WHERE o.id = $1::uuid`,
      [past.rows[0]?.id],
    );
    expect(survivor.rows[0]?.status).toBe('scheduled');
    expect(Number(survivor.rows[0]?.n)).toBe(1);
    await client.query(`DELETE FROM users WHERE id = $1`, [attendeeId]);
  });

  it('does not leave a permanently-failing series at the head of the queue', async () => {
    // The scan is ordered by materialized_through NULLS FIRST. A rule the engine
    // cannot expand fails identically every hour, so leaving it NULL would park
    // it at the front of every batch forever and starve working series out of
    // the LIMIT.
    const sessionId = await createSeries('2026-01-06T18:00:00', null);
    await client.query(`ALTER TABLE play_sessions DROP CONSTRAINT play_sessions_rrule_supported`);
    try {
      await client.query(`UPDATE play_sessions SET rrule = 'FREQ=MONTHLY' WHERE id = $1::uuid`, [
        sessionId,
      ]);
      const report = await materializeSessions(pool, {
        now: new Date('2026-01-05T09:00:00Z'),
        sessionId,
      });
      expect(report.failures).toEqual([{ sessionId, code: 'rrule_unsupported_freq' }]);
      // Reported as failed, but no longer first in line.
      const row = await client.query<{ materialized_through: Date | null }>(
        `SELECT materialized_through FROM play_sessions WHERE id = $1::uuid`,
        [sessionId],
      );
      expect(row.rows[0]?.materialized_through).not.toBeNull();
    } finally {
      await client.query(`DELETE FROM play_sessions WHERE id = $1::uuid`, [sessionId]);
      await client.query(
        `ALTER TABLE play_sessions ADD CONSTRAINT play_sessions_rrule_supported
           CHECK ("rrule" IS NULL OR "rrule" ~ '^FREQ=(DAILY|WEEKLY)(;(INTERVAL=[1-9][0-9]{0,2}|COUNT=[1-9][0-9]{0,2}|UNTIL=[0-9]{4}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]Z|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*|WKST=MO))*$')`,
      );
    }
  });

  it('never resurrects a cancelled occurrence', async () => {
    const now = new Date('2026-01-05T09:00:00Z');
    const sessionId = await createSeries('2026-01-06T18:00:00', 'FREQ=WEEKLY');
    await materializeSessions(pool, { now });
    await client.query(
      `UPDATE play_session_occurrences
          SET status='cancelled', cancelled_at=now(), cancellation_scope='occurrence'
        WHERE session_id = $1::uuid
          AND starts_at = (SELECT min(starts_at) FROM play_session_occurrences WHERE session_id = $1::uuid)`,
      [sessionId],
    );

    const report = await materializeSessions(pool, { now, sessionId });
    expect(report.occurrencesCreated).toBe(0);
    const occurrences = await occurrencesOf(sessionId);
    expect(occurrences.filter((o) => o.status === 'cancelled')).toHaveLength(1);
  });

  it('skips a cancelled series entirely', async () => {
    const now = new Date('2026-01-05T09:00:00Z');
    const sessionId = await createSeries('2026-01-06T18:00:00', 'FREQ=WEEKLY');
    await client.query(`UPDATE play_sessions SET status='cancelled' WHERE id = $1::uuid`, [
      sessionId,
    ]);
    const report = await materializeSessions(pool, { now, sessionId });
    expect(report.seriesProcessed).toBe(0);
    expect(await occurrencesOf(sessionId)).toEqual([]);
  });

  it('materializes a one-off series as exactly one occurrence', async () => {
    const sessionId = await createSeries('2026-01-10T10:30:00', null);
    await materializeSessions(pool, { now: new Date('2026-01-05T09:00:00Z'), sessionId });
    const occurrences = await occurrencesOf(sessionId);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.local).toBe('2026-01-10T10:30:00');
  });

  it('reports a failing series without stopping the run', async () => {
    const good = await createSeries('2026-01-06T18:00:00', 'FREQ=WEEKLY');
    const bad = await createSeries('2026-01-06T18:00:00', null);

    // A rule the CHECK would refuse, written while the CHECK is off: the shape
    // of a row restored from an older schema, or a grammar widened in SQL before
    // the engine caught up. The run must report it and carry on, not abort.
    await client.query(`ALTER TABLE play_sessions DROP CONSTRAINT play_sessions_rrule_supported`);
    try {
      await client.query(`UPDATE play_sessions SET rrule = 'FREQ=MONTHLY' WHERE id = $1::uuid`, [
        bad,
      ]);
      const report = await materializeSessions(pool, { now: new Date('2026-01-05T09:00:00Z') });
      expect(report.failures).toEqual([{ sessionId: bad, code: 'rrule_unsupported_freq' }]);
      expect(report.seriesProcessed).toBe(1);
      expect(await occurrencesOf(good)).toHaveLength(8);
    } finally {
      // Restore the constraint whatever happened, or every later test in the
      // file would run against a schema this one quietly weakened.
      await client.query(`DELETE FROM play_sessions WHERE id = $1::uuid`, [bad]);
      await client.query(
        `ALTER TABLE play_sessions ADD CONSTRAINT play_sessions_rrule_supported
           CHECK ("rrule" IS NULL OR "rrule" ~ '^FREQ=(DAILY|WEEKLY)(;(INTERVAL=[1-9][0-9]{0,2}|COUNT=[1-9][0-9]{0,2}|UNTIL=[0-9]{4}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]Z|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*|WKST=MO))*$')`,
      );
    }
  });
});
