import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * RSVP ordering and the waitlist (docs/ROADMAP.md §6, Stage 4.1).
 *
 * The claim under test is a design claim, not a code claim: because position is
 * derived (`row_number()` over the active rows, ordered by an arrival ticket)
 * and never stored, over-booking is IMPOSSIBLE and promotion needs no code.
 * There is no counter to race on, so the properties below have to hold for any
 * interleaving of joins and withdrawals, including concurrent ones.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const ORGANIZER_ID = 'e2e_waitlist_org';
const MEMBER_IDS = ['e2e_wl_a', 'e2e_wl_b', 'e2e_wl_c', 'e2e_wl_d', 'e2e_wl_e'];

interface PositionRow {
  user_id: string;
  position: string;
  rsvp_status: string;
}

describe.skipIf(!hasDb)('play session waitlist (requires running database)', () => {
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
      `INSERT INTO users (id, display_name, email) VALUES ($1, 'Организатор', 'waitlist@example.org')`,
      [ORGANIZER_ID],
    );
    for (const [index, id] of MEMBER_IDS.entries()) {
      await client.query(`INSERT INTO users (id, display_name, email) VALUES ($1, 'Играч', $2)`, [
        id,
        `waitlist-${String(index)}@example.org`,
      ]);
    }
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1`, [ORGANIZER_ID]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
      [ORGANIZER_ID, ...MEMBER_IDS],
    ]);
  }

  /** A single future occurrence with the given capacity. */
  async function makeOccurrence(capacity: number | null): Promise<string> {
    const session = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes, capacity)
       VALUES ($1::uuid, 'volleyball', $2, 'Волейбол', '2027-05-04T19:00:00'::timestamp, 90, $3)
       RETURNING id`,
      [facilityId, ORGANIZER_ID, capacity],
    );
    const sessionId = session.rows[0]?.id;
    const occurrence = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       VALUES ($1::uuid, '2027-05-04T16:00:00Z', '2027-05-04T17:30:00Z',
               '2027-05-04T19:00:00'::timestamp)
       RETURNING id`,
      [sessionId],
    );
    return occurrence.rows[0]?.id ?? '';
  }

  /** The production RSVP statement, verbatim in shape (lib/sessions/rsvp.ts). */
  async function join(occurrenceId: string, userId: string): Promise<void> {
    await client.query(
      `INSERT INTO play_session_rsvps (occurrence_id, user_id)
       VALUES ($1::uuid, $2)
       ON CONFLICT (occurrence_id, user_id) DO UPDATE
         SET state = 'active', withdrawn_at = NULL, updated_at = now(),
             seq = CASE WHEN play_session_rsvps.state = 'withdrawn'
                        THEN nextval('play_session_rsvp_seq')
                        ELSE play_session_rsvps.seq END`,
      [occurrenceId, userId],
    );
  }

  async function leave(occurrenceId: string, userId: string): Promise<void> {
    await client.query(
      `UPDATE play_session_rsvps SET state='withdrawn', withdrawn_at=now(), updated_at=now()
        WHERE occurrence_id = $1::uuid AND user_id = $2 AND state = 'active'`,
      [occurrenceId, userId],
    );
  }

  async function positions(occurrenceId: string): Promise<PositionRow[]> {
    const result = await client.query<PositionRow>(
      `SELECT user_id, position, rsvp_status FROM play_session_rsvp_positions
        WHERE occurrence_id = $1::uuid ORDER BY position`,
      [occurrenceId],
    );
    return result.rows;
  }

  it('orders by arrival and marks exactly `capacity` as going', async () => {
    const occurrenceId = await makeOccurrence(2);
    for (const id of MEMBER_IDS.slice(0, 4)) await join(occurrenceId, id);

    const rows = await positions(occurrenceId);
    expect(rows.map((r) => r.user_id)).toEqual(MEMBER_IDS.slice(0, 4));
    expect(rows.map((r) => r.rsvp_status)).toEqual(['going', 'going', 'waitlisted', 'waitlisted']);
  });

  it('promotes the next person on a withdrawal, with no code running', async () => {
    const occurrenceId = await makeOccurrence(2);
    for (const id of MEMBER_IDS.slice(0, 4)) await join(occurrenceId, id);

    // The first person drops out. Nothing is executed against the waitlist —
    // the row_number simply shifts.
    await leave(occurrenceId, MEMBER_IDS[0] as string);

    const rows = await positions(occurrenceId);
    expect(rows.map((r) => r.user_id)).toEqual(MEMBER_IDS.slice(1, 4));
    expect(rows.map((r) => r.rsvp_status)).toEqual(['going', 'going', 'waitlisted']);
  });

  it('sends a re-joiner to the BACK of the queue', async () => {
    const occurrenceId = await makeOccurrence(2);
    for (const id of MEMBER_IDS.slice(0, 3)) await join(occurrenceId, id);
    await leave(occurrenceId, MEMBER_IDS[0] as string);
    await join(occurrenceId, MEMBER_IDS[0] as string);

    const rows = await positions(occurrenceId);
    // Leaving and coming back must not jump the person who has been waiting.
    expect(rows.map((r) => r.user_id)).toEqual([MEMBER_IDS[1], MEMBER_IDS[2], MEMBER_IDS[0]]);
    expect(rows.map((r) => r.rsvp_status)).toEqual(['going', 'going', 'waitlisted']);
  });

  it('is idempotent for a repeated join — same position, no ticket redraw', async () => {
    const occurrenceId = await makeOccurrence(2);
    await join(occurrenceId, MEMBER_IDS[0] as string);
    await join(occurrenceId, MEMBER_IDS[1] as string);
    const before = await positions(occurrenceId);
    // A double-submitted form must not push someone to the back of their own
    // queue — only an explicit withdrawal redraws the ticket.
    await join(occurrenceId, MEMBER_IDS[0] as string);
    expect(await positions(occurrenceId)).toEqual(before);
  });

  it('treats NULL capacity as unlimited', async () => {
    const occurrenceId = await makeOccurrence(null);
    for (const id of MEMBER_IDS) await join(occurrenceId, id);
    const rows = await positions(occurrenceId);
    expect(rows).toHaveLength(MEMBER_IDS.length);
    expect(rows.every((r) => r.rsvp_status === 'going')).toBe(true);
  });

  it('cannot over-book under concurrent joins from separate connections', async () => {
    const occurrenceId = await makeOccurrence(2);
    const clients = await Promise.all(
      MEMBER_IDS.map(async () => {
        const extra = new pg.Client({ connectionString: process.env.DATABASE_URL });
        await extra.connect();
        return extra;
      }),
    );
    try {
      // Five people hit "join" at the same instant on a session with two places.
      await Promise.all(
        clients.map((c, index) =>
          c.query(`INSERT INTO play_session_rsvps (occurrence_id, user_id) VALUES ($1::uuid, $2)`, [
            occurrenceId,
            MEMBER_IDS[index],
          ]),
        ),
      );
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }

    const rows = await positions(occurrenceId);
    expect(rows).toHaveLength(5);
    // Exactly two going — not three, not "it depends". There was no counter to
    // race on: everyone took a ticket and the ordering decided.
    expect(rows.filter((r) => r.rsvp_status === 'going')).toHaveLength(2);
    expect(rows.map((r) => Number(r.position))).toEqual([1, 2, 3, 4, 5]);
  });

  it('holds for any interleaving of joins and withdrawals (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(
            fc.integer({ min: 0, max: MEMBER_IDS.length - 1 }),
            fc.constantFrom<'join' | 'leave'>('join', 'leave'),
          ),
          { minLength: 1, maxLength: 14 },
        ),
        fc.integer({ min: 1, max: 4 }),
        async (operations, capacity) => {
          try {
            await runInterleaving(operations, capacity);
          } finally {
            // In a finally so a shrinking run always starts from clean state.
            await client.query(`DELETE FROM play_sessions WHERE organizer_id = $1`, [ORGANIZER_ID]);
          }
        },
      ),
      { numRuns: 20 },
    );

    async function runInterleaving(
      operations: [number, 'join' | 'leave'][],
      capacity: number,
    ): Promise<void> {
      const occurrenceId = await makeOccurrence(capacity);
      // A model of what the database should say, maintained independently.
      const queue: string[] = [];
      for (const [index, operation] of operations) {
        const userId = MEMBER_IDS[index] as string;
        if (operation === 'join') {
          await join(occurrenceId, userId);
          if (!queue.includes(userId)) queue.push(userId);
        } else {
          await leave(occurrenceId, userId);
          const at = queue.indexOf(userId);
          if (at >= 0) queue.splice(at, 1);
        }
      }

      const rows = await positions(occurrenceId);
      // Arrival order, with a re-joiner at the back — exactly the model.
      expect(rows.map((r) => r.user_id)).toEqual(queue);
      // Positions are always a contiguous 1..n with no gaps, whatever
      // withdrawals happened in the middle.
      expect(rows.map((r) => Number(r.position))).toEqual(queue.map((_, position) => position + 1));
      // And never more than `capacity` people are going.
      const going = rows.filter((r) => r.rsvp_status === 'going');
      expect(going).toHaveLength(Math.min(capacity, queue.length));
    }
  });

  it('refuses a new RSVP once the occurrence is cancelled, but allows withdrawing', async () => {
    const occurrenceId = await makeOccurrence(4);
    await join(occurrenceId, MEMBER_IDS[0] as string);
    await client.query(
      `UPDATE play_session_occurrences
          SET status='cancelled', cancelled_at=now(), cancellation_scope='occurrence'
        WHERE id = $1::uuid`,
      [occurrenceId],
    );

    await expect(join(occurrenceId, MEMBER_IDS[1] as string)).rejects.toThrow(
      /cannot RSVP to a cancelled occurrence/,
    );
    // The existing RSVP is untouched — it is who the cancellation notice goes
    // to — and that person can still withdraw.
    expect(await positions(occurrenceId)).toHaveLength(1);
    await leave(occurrenceId, MEMBER_IDS[0] as string);
    expect(await positions(occurrenceId)).toHaveLength(0);
  });

  it('refuses an RSVP to an occurrence that already started', async () => {
    const session = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes)
       VALUES ($1::uuid, 'volleyball', $2, 'Минал', '2020-05-04T19:00:00'::timestamp, 90)
       RETURNING id`,
      [facilityId, ORGANIZER_ID],
    );
    const occurrence = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       VALUES ($1::uuid, '2020-05-04T16:00:00Z', '2020-05-04T17:30:00Z',
               '2020-05-04T19:00:00'::timestamp)
       RETURNING id`,
      [session.rows[0]?.id],
    );
    await expect(join(occurrence.rows[0]?.id ?? '', MEMBER_IDS[0] as string)).rejects.toThrow(
      /already started/,
    );
  });

  it('keeps the arrival ticket unique per occurrence', async () => {
    // The ordering must be TOTAL: a tie would let two people swap between
    // "going" and "waitlisted" from one query plan to the next.
    const occurrenceId = await makeOccurrence(1);
    await join(occurrenceId, MEMBER_IDS[0] as string);
    const seq = await client.query<{ seq: string }>(
      `SELECT seq FROM play_session_rsvps WHERE occurrence_id = $1::uuid`,
      [occurrenceId],
    );
    await expect(
      client.query(
        `INSERT INTO play_session_rsvps (occurrence_id, user_id, seq) VALUES ($1::uuid, $2, $3)`,
        [occurrenceId, MEMBER_IDS[1], seq.rows[0]?.seq],
      ),
    ).rejects.toThrow(/play_session_rsvps_queue_idx/);
  });
});
