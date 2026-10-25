import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupClubFixtures,
  failure,
  makeClub,
  makeMember,
  makeOccurrence,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * Club classes, bookings and the waitlist (0042) — the play-session engine's
 * guarantees, re-proved for a club's own timetable:
 *
 *   * position is DERIVED (club_booking_positions), so over-booking is
 *     impossible and a cancellation promotes the next person with no code;
 *   * the occurrence capacity overrides the class's;
 *   * a member books themselves only inside the class's booking window, while
 *     the desk (booked_by set) may book outside it;
 *   * cancelling a class cancels its future occurrences.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club schedule (requires running database)', () => {
  let client: pg.Client;
  let club: ClubFixture;
  const members: string[] = [];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await cleanupClubFixtures(client);
    await client.end();
  });

  beforeEach(async () => {
    await cleanupClubFixtures(client);
    club = await makeClub(client, 'schedule');
    members.length = 0;
    for (const name of ['А', 'Б', 'В', 'Г', 'Д']) {
      members.push(await makeMember(client, club.clubId, `Член ${name}`));
    }
  });

  async function book(occurrenceId: string, memberId: string, byDesk = true): Promise<void> {
    await client.query(
      `INSERT INTO club_bookings (club_id, occurrence_id, member_id, booked_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (occurrence_id, member_id) DO UPDATE
         SET state = 'active', cancelled_at = NULL, seq = nextval('club_booking_seq'),
             booked_by = EXCLUDED.booked_by
       WHERE club_bookings.state <> 'active'`,
      [club.clubId, occurrenceId, memberId, byDesk ? club.ownerId : null],
    );
  }

  async function cancel(occurrenceId: string, memberId: string): Promise<void> {
    await client.query(
      `UPDATE club_bookings SET state = 'cancelled', cancelled_at = now()
        WHERE occurrence_id = $1 AND member_id = $2 AND state = 'active'`,
      [occurrenceId, memberId],
    );
  }

  async function going(occurrenceId: string): Promise<string[]> {
    const rows = await client.query<{ member_id: string }>(
      `SELECT member_id FROM club_booking_positions
        WHERE club_id = $1 AND occurrence_id = $2 AND booking_status = 'going'
        ORDER BY position`,
      [club.clubId, occurrenceId],
    );
    return rows.rows.map((r) => r.member_id);
  }

  it('promotes the first waitlisted member when someone cancels', async () => {
    const { occurrenceId } = await makeOccurrence(client, club, { capacity: 2 });
    for (const m of members.slice(0, 4)) await book(occurrenceId, m);
    expect(await going(occurrenceId)).toEqual(members.slice(0, 2));
    await cancel(occurrenceId, members[0] as string);
    expect(await going(occurrenceId)).toEqual([members[1], members[2]]);
    // Re-booking draws a FRESH ticket: back of the queue.
    await book(occurrenceId, members[0] as string);
    const positions = await client.query<{ member_id: string }>(
      `SELECT member_id FROM club_booking_positions WHERE occurrence_id = $1 ORDER BY position`,
      [occurrenceId],
    );
    expect(positions.rows.at(-1)?.member_id).toBe(members[0]);
  });

  it('lets the occurrence override the class capacity', async () => {
    const { occurrenceId } = await makeOccurrence(client, club, { capacity: 1 });
    for (const m of members.slice(0, 3)) await book(occurrenceId, m);
    expect(await going(occurrenceId)).toHaveLength(1);
    await client.query(`UPDATE club_class_occurrences SET capacity = 3 WHERE id = $1`, [
      occurrenceId,
    ]);
    expect(await going(occurrenceId)).toHaveLength(3);
  });

  it('never seats more than capacity, for any sequence of bookings and cancellations', async () => {
    const { occurrenceId } = await makeOccurrence(client, club, { capacity: 3 });
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 0, max: 4 })), { maxLength: 25 }),
        async (ops) => {
          await client.query(`DELETE FROM club_bookings WHERE occurrence_id = $1`, [occurrenceId]);
          for (const [isBook, index] of ops) {
            const memberId = members[index] as string;
            if (isBook) await book(occurrenceId, memberId);
            else await cancel(occurrenceId, memberId);
          }
          const rows = await client.query<{ n: number; seated: number }>(
            `SELECT count(*)::int AS n,
                    count(*) FILTER (WHERE booking_status = 'going')::int AS seated
               FROM club_booking_positions WHERE occurrence_id = $1`,
            [occurrenceId],
          );
          const { n, seated } = rows.rows[0] ?? { n: 0, seated: 0 };
          expect(seated).toBe(Math.min(n, 3));
        },
      ),
      { numRuns: 25 },
    );
  });

  it('opens self-booking only inside the booking window; the desk may book early', async () => {
    // 10 days ahead with a 48-hour window: closed for the member, open to the desk.
    const { occurrenceId } = await makeOccurrence(client, club, {
      daysAhead: 10,
      bookingOpensHours: 48,
    });
    const self = await failure(book(occurrenceId, members[0] as string, false));
    expect(self.constraint).toBe('club_bookings_window_open');
    await book(occurrenceId, members[1] as string, true);

    const soon = await makeOccurrence(client, club, { daysAhead: 1, bookingOpensHours: 48 });
    await book(soon.occurrenceId, members[0] as string, false);
  });

  it('cancelling a class cancels its future occurrences and blocks new bookings', async () => {
    const { classId, occurrenceId } = await makeOccurrence(client, club);
    await book(occurrenceId, members[0] as string);
    await client.query(`UPDATE club_classes SET status = 'cancelled' WHERE id = $1`, [classId]);
    const occurrence = await client.query(
      `SELECT status, cancellation_scope FROM club_class_occurrences WHERE id = $1`,
      [occurrenceId],
    );
    expect(occurrence.rows[0]).toEqual({ status: 'cancelled', cancellation_scope: 'series' });
    const late = await failure(book(occurrenceId, members[1] as string));
    expect(late.constraint).toBe('club_bookings_occurrence_scheduled');
    // The existing booking is not removed: it is who the cancellation mail goes to.
    expect(await going(occurrenceId)).toEqual([members[0]]);
  });

  it('refuses an occurrence whose wall clock disagrees with its instant', async () => {
    const { classId } = await makeOccurrence(client, club);
    const result = await failure(
      client.query(
        `INSERT INTO club_class_occurrences (club_id, class_id, starts_at, ends_at, starts_at_local)
         VALUES ($1, $2, now() + interval '3 days', now() + interval '3 days 1 hour',
                 (now() + interval '3 days')::timestamp + interval '5 hours')`,
        [club.clubId, classId],
      ),
    );
    expect(result.message).toMatch(/local clock/);
  });

  it('draws a fresh ticket in SQL when a cancelled booking is re-activated', async () => {
    const { occurrenceId } = await makeOccurrence(client, club, { capacity: 1 });
    await book(occurrenceId, members[0] as string);
    await book(occurrenceId, members[1] as string);
    await cancel(occurrenceId, members[0] as string);
    // The writer sends no seq at all: the trigger issues the new ticket.
    await client.query(
      `UPDATE club_bookings SET state = 'active', cancelled_at = NULL
        WHERE occurrence_id = $1 AND member_id = $2`,
      [occurrenceId, members[0]],
    );
    expect(await going(occurrenceId)).toEqual([members[1]]);
  });
});
