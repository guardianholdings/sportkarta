import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Cancellation semantics and the GDPR path (docs/ROADMAP.md §6, Stage 4.1).
 *
 * Three claims, all enforced in SQL rather than in application code:
 *
 *  1. Cancelling a SERIES cancels its FUTURE occurrences and leaves past ones
 *     alone — they happened, and rewriting them would erase attendance history.
 *  2. Cancelling ONE occurrence leaves the series running.
 *  3. Erasing the organiser's account cancels their series through the foreign
 *     key alone (SET NULL → trigger), never deletes it, and never destroys
 *     other people's check-ins. And — the load-bearing one — the erasure itself
 *     cannot be blocked by any of this.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const ORGANIZER_ID = 'e2e_cancel_org';
const ATTENDEE_ID = 'e2e_cancel_attendee';
/**
 * Erasure leaves the series with organizer_id NULL, so cleanup cannot find it
 * by organiser. Vitest runs test files in parallel against the one dev
 * database, so it is matched by a title only this suite writes rather than by
 * "unowned", which would delete another suite's rows mid-test.
 */
const TITLE = 'e2e-cancel Футбол';

describe.skipIf(!hasDb)('play session cancellation (requires running database)', () => {
  let client: pg.Client;
  let facilityId: string;

  beforeAll(async () => {
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
  });

  beforeEach(async () => {
    await cleanup();
    await client.query(
      `INSERT INTO users (id, display_name, email) VALUES
         ($1, 'Организатор', 'cancel-org@example.org'),
         ($2, 'Играч', 'cancel-attendee@example.org')`,
      [ORGANIZER_ID, ATTENDEE_ID],
    );
  });

  async function cleanup(): Promise<void> {
    await client.query(
      `DELETE FROM play_sessions WHERE organizer_id = ANY($1::text[]) OR title = $2`,
      [[ORGANIZER_ID, ATTENDEE_ID], TITLE],
    );
    await client.query(`DELETE FROM account_deletions WHERE user_id = ANY($1::text[])`, [
      [ORGANIZER_ID, ATTENDEE_ID],
    ]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
      [ORGANIZER_ID, ATTENDEE_ID],
    ]);
  }

  /** A series with one past and one future occurrence. */
  async function seriesWithHistory(): Promise<{
    sessionId: string;
    pastId: string;
    futureId: string;
  }> {
    const session = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, rrule, duration_minutes)
       VALUES ($1::uuid, 'football', $2, $3, '2020-01-07T19:00:00'::timestamp,
               'FREQ=WEEKLY', 90)
       RETURNING id`,
      [facilityId, ORGANIZER_ID, TITLE],
    );
    const sessionId = session.rows[0]?.id ?? '';

    const past = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       VALUES ($1::uuid, '2020-01-07T17:00:00Z', '2020-01-07T18:30:00Z',
               '2020-01-07T19:00:00'::timestamp)
       RETURNING id`,
      [sessionId],
    );
    const future = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       VALUES ($1::uuid, '2027-01-05T17:00:00Z', '2027-01-05T18:30:00Z',
               '2027-01-05T19:00:00'::timestamp)
       RETURNING id`,
      [sessionId],
    );
    return {
      sessionId,
      pastId: past.rows[0]?.id ?? '',
      futureId: future.rows[0]?.id ?? '',
    };
  }

  async function statusOf(occurrenceId: string): Promise<{ status: string; scope: string | null }> {
    const result = await client.query<{ status: string; cancellation_scope: string | null }>(
      `SELECT status, cancellation_scope FROM play_session_occurrences WHERE id = $1::uuid`,
      [occurrenceId],
    );
    const row = result.rows[0];
    return { status: row?.status ?? 'missing', scope: row?.cancellation_scope ?? null };
  }

  it('cancelling a series cancels future occurrences only', async () => {
    const { sessionId, pastId, futureId } = await seriesWithHistory();
    await client.query(`UPDATE play_sessions SET status='cancelled' WHERE id = $1::uuid`, [
      sessionId,
    ]);

    expect(await statusOf(futureId)).toEqual({ status: 'cancelled', scope: 'series' });
    // The past is not rewritten.
    expect(await statusOf(pastId)).toEqual({ status: 'scheduled', scope: null });
  });

  it('cancelling one occurrence leaves the series and its other dates alone', async () => {
    const { sessionId, futureId } = await seriesWithHistory();
    const second = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       VALUES ($1::uuid, '2027-01-12T17:00:00Z', '2027-01-12T18:30:00Z',
               '2027-01-12T19:00:00'::timestamp)
       RETURNING id`,
      [sessionId],
    );
    await client.query(
      `UPDATE play_session_occurrences
          SET status='cancelled', cancelled_at=now(), cancellation_scope='occurrence'
        WHERE id = $1::uuid`,
      [futureId],
    );

    expect(await statusOf(futureId)).toEqual({ status: 'cancelled', scope: 'occurrence' });
    expect(await statusOf(second.rows[0]?.id ?? '')).toEqual({ status: 'scheduled', scope: null });
    const series = await client.query<{ status: string }>(
      `SELECT status FROM play_sessions WHERE id = $1::uuid`,
      [sessionId],
    );
    expect(series.rows[0]?.status).toBe('scheduled');
  });

  describe('erasing the organiser', () => {
    it('cancels the series without deleting it, and keeps attendance history', async () => {
      const { sessionId, pastId, futureId } = await seriesWithHistory();
      // Somebody else played at the past session and is going to the next one.
      await client.query(
        `INSERT INTO play_session_checkins (occurrence_id, user_id, method)
         VALUES ($1::uuid, $2, 'self')`,
        [pastId, ATTENDEE_ID],
      );
      await client.query(
        `INSERT INTO play_session_rsvps (occurrence_id, user_id) VALUES ($1::uuid, $2)`,
        [futureId, ATTENDEE_ID],
      );

      // The whole erasure, in one statement, exactly as account-deletion.ts runs it.
      await expect(
        client.query(`DELETE FROM users WHERE id = $1`, [ORGANIZER_ID]),
      ).resolves.toBeTruthy();

      const series = await client.query<{ status: string; organizer_id: string | null }>(
        `SELECT status, organizer_id FROM play_sessions WHERE id = $1::uuid`,
        [sessionId],
      );
      // The series survives, cancelled and unowned — the organiser is gone but
      // the record of what happened is not the organiser's to take with them.
      expect(series.rows[0]).toEqual({ status: 'cancelled', organizer_id: null });
      expect(await statusOf(futureId)).toEqual({ status: 'cancelled', scope: 'series' });
      expect(await statusOf(pastId)).toEqual({ status: 'scheduled', scope: null });

      // The other person's check-in is untouched. A CASCADE on organizer_id
      // would have destroyed it to erase somebody else.
      const checkins = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM play_session_checkins WHERE user_id = $1`,
        [ATTENDEE_ID],
      );
      expect(Number(checkins.rows[0]?.n)).toBe(1);
    });

    it('cannot be blocked by a cancelled series, a full waitlist or stale tz data', async () => {
      // The failure mode this guards: an unconditional local-clock trigger would
      // re-verify every future occurrence during the cancellation cascade, which
      // runs INSIDE the DELETE. New tzdata would then make erasure impossible.
      const { sessionId, futureId } = await seriesWithHistory();
      await client.query(
        `INSERT INTO play_session_rsvps (occurrence_id, user_id) VALUES ($1::uuid, $2)`,
        [futureId, ATTENDEE_ID],
      );
      // Corrupt the local clock the way a tzdata change effectively would.
      // try/finally so a failure cannot leave the trigger off for later tests.
      await client.query(
        `ALTER TABLE play_session_occurrences DISABLE TRIGGER play_session_occurrences_verify_local_update`,
      );
      try {
        await client.query(
          `UPDATE play_session_occurrences SET starts_at_local = '1999-01-01T00:00:00'::timestamp
            WHERE id = $1::uuid`,
          [futureId],
        );
      } finally {
        await client.query(
          `ALTER TABLE play_session_occurrences ENABLE TRIGGER play_session_occurrences_verify_local_update`,
        );
      }

      await expect(
        client.query(`DELETE FROM users WHERE id = $1`, [ORGANIZER_ID]),
      ).resolves.toBeTruthy();
      expect(await statusOf(futureId)).toEqual({ status: 'cancelled', scope: 'series' });

      // And erasing the attendee afterwards takes their RSVP with it, while the
      // (now unowned) series stays.
      await expect(
        client.query(`DELETE FROM users WHERE id = $1`, [ATTENDEE_ID]),
      ).resolves.toBeTruthy();
      const remaining = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM play_session_rsvps WHERE occurrence_id = $1::uuid`,
        [futureId],
      );
      expect(Number(remaining.rows[0]?.n)).toBe(0);
      const series = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM play_sessions WHERE id = $1::uuid`,
        [sessionId],
      );
      expect(Number(series.rows[0]?.n)).toBe(1);
    });

    it('leaves an already-cancelled series alone rather than re-cascading', async () => {
      const { sessionId, futureId } = await seriesWithHistory();
      await client.query(
        `UPDATE play_session_occurrences
            SET status='cancelled', cancelled_at=now(), cancellation_scope='occurrence'
          WHERE id = $1::uuid`,
        [futureId],
      );
      await client.query(`UPDATE play_sessions SET status='cancelled' WHERE id = $1::uuid`, [
        sessionId,
      ]);
      // The occurrence keeps the scope it was cancelled with: "this week is off"
      // is a different fact from "the series ended", and the later series-level
      // cancellation must not overwrite the earlier record.
      expect(await statusOf(futureId)).toEqual({ status: 'cancelled', scope: 'occurrence' });
    });
  });

  it('records the play-layer counters on the erasure tombstone', async () => {
    const { pastId, futureId } = await seriesWithHistory();
    await client.query(
      `INSERT INTO play_session_checkins (occurrence_id, user_id, method) VALUES ($1::uuid, $2, 'self')`,
      [pastId, ATTENDEE_ID],
    );
    await client.query(
      `INSERT INTO play_session_rsvps (occurrence_id, user_id) VALUES ($1::uuid, $2)`,
      [futureId, ATTENDEE_ID],
    );

    // The counts account-deletion.ts takes before deleting.
    const counts = await client.query<{ rsvps: string; checkins: string; sessions: string }>(
      `SELECT
         (SELECT count(*) FROM play_session_rsvps WHERE user_id = $1) AS rsvps,
         (SELECT count(*) FROM play_session_checkins WHERE user_id = $1) AS checkins,
         (SELECT count(*) FROM play_sessions WHERE organizer_id = $2 AND status = 'scheduled') AS sessions`,
      [ATTENDEE_ID, ORGANIZER_ID],
    );
    expect(Number(counts.rows[0]?.rsvps)).toBe(1);
    expect(Number(counts.rows[0]?.checkins)).toBe(1);
    expect(Number(counts.rows[0]?.sessions)).toBe(1);

    await client.query(
      `INSERT INTO account_deletions (user_id, rsvps_erased, checkins_erased, sessions_cancelled)
       VALUES ($1, 1, 1, 0)`,
      [ATTENDEE_ID],
    );
    await expect(
      client.query(`INSERT INTO account_deletions (user_id, rsvps_erased) VALUES ($1, -1)`, [
        ATTENDEE_ID,
      ]),
    ).rejects.toThrow('counts_non_negative');
  });
});
