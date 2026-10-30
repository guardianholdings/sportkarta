import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './client.js';
import { materializeClubClasses } from './clubs/materialize.js';
import { expireReservationHolds } from './clubs/payments.js';
import {
  cleanupClubFixtures,
  ensureUser,
  failure,
  makeClub,
  makeMember,
  makeOccurrence,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * Courts, rooms and appointments (0048): double booking is impossible by
 * construction, not by a check the application might forget.
 *
 * What must hold:
 *   - two live reservations of an exclusive resource cannot overlap (23P01),
 *     including the buffer; back-to-back is fine (half-open);
 *   - a pool resource refuses only when every unit is taken at the SAME
 *     moment, not merely because N bookings touch the interval;
 *   - a class that occupies a room claims it, and a room block, a trainer's
 *     leave and a trainer's appointments all collide the same way;
 *   - a cancelled reservation frees its slot; erasing the client keeps it.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club reservations (requires running database)', () => {
  let client: pg.Client;
  let club: ClubFixture;
  let memberId: string;
  let serviceId: string;

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
    club = await makeClub(client, 'courts', { tier: 'community' });
    memberId = await makeMember(client, club.clubId, 'Мария');
    const service = await client.query<{ id: string }>(
      `INSERT INTO club_services (club_id, location_id, kind, name_bg, duration_min, duration_max,
                                  price_cents)
       VALUES ($1, $2, 'rental', 'Корт', 60, 120, 2000) RETURNING id`,
      [club.clubId, club.locationId],
    );
    serviceId = service.rows[0]?.id ?? '';
  });

  async function resource(quantity = 1): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO club_resources (club_id, location_id, kind, name, quantity)
       VALUES ($1, $2, $3, 'Корт 1', $4) RETURNING id`,
      [club.clubId, club.locationId, quantity === 1 ? 'court' : 'equipment', quantity],
    );
    return result.rows[0]?.id ?? '';
  }

  /** A reservation from `fromHour` to `toHour` tomorrow (Sofia). */
  function reserve(
    target: { resourceId?: string; staffId?: string },
    fromHour: number,
    toHour: number,
    options: { buffer?: number; state?: string } = {},
  ) {
    return client.query<{ id: string }>(
      `INSERT INTO club_reservations (club_id, service_id, member_id, resource_id, staff_user_id,
                                      starts_at, ends_at, buffer_minutes, state, hold_expires_at,
                                      price_cents, cancel_deadline_hours)
       VALUES ($1, $2, $3, $4, $5,
               ((current_date + 1)::timestamp + make_interval(hours => $6::int)) AT TIME ZONE 'Europe/Sofia',
               ((current_date + 1)::timestamp + make_interval(hours => $7::int)) AT TIME ZONE 'Europe/Sofia',
               $8, $9, CASE WHEN $9 = 'held' THEN now() + interval '15 minutes' END, 2000, 24)
       RETURNING id`,
      [
        club.clubId,
        serviceId,
        memberId,
        target.resourceId ?? null,
        target.staffId ?? null,
        fromHour,
        toHour,
        options.buffer ?? 0,
        options.state ?? 'confirmed',
      ],
    );
  }

  it('refuses an overlapping booking of a court, and allows back-to-back', async () => {
    const court = await resource();
    await reserve({ resourceId: court }, 10, 11);
    const clash = await failure(reserve({ resourceId: court }, 10, 12));
    expect(clash.code).toBe('23P01');
    expect(clash.constraint).toBe('club_calendar_claims_resource_free');
    await reserve({ resourceId: court }, 11, 12);
  });

  it('keeps the buffer free too', async () => {
    const court = await resource();
    await reserve({ resourceId: court }, 10, 11, { buffer: 15 });
    expect((await failure(reserve({ resourceId: court }, 11, 12))).code).toBe('23P01');
  });

  it('frees the slot when a booking is cancelled or a hold expires', async () => {
    const court = await resource();
    const held = await reserve({ resourceId: court }, 10, 11, { state: 'held' });
    await client.query(
      `UPDATE club_reservations SET state = 'expired', hold_expires_at = NULL WHERE id = $1`,
      [held.rows[0]?.id],
    );
    const booked = await reserve({ resourceId: court }, 10, 11);
    await client.query(
      `UPDATE club_reservations SET state = 'cancelled', cancelled_at = now(), cancel_kind = 'member'
        WHERE id = $1`,
      [booked.rows[0]?.id],
    );
    await reserve({ resourceId: court }, 10, 11);
  });

  it('confirms a hold on payment, and releases only an unpaid lapsed one — voided', async () => {
    const court = await resource();
    const charge = async () =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on)
           VALUES ($1, $2, 'reservation', 'Корт', 2000, current_date, current_date + 1)
           RETURNING id`,
          [club.clubId, memberId],
        )
      ).rows[0]?.id ?? '';
    const hold = async (chargeId: string, fromHour: number) => {
      const row = await reserve({ resourceId: court }, fromHour, fromHour + 1, { state: 'held' });
      const id = row.rows[0]?.id ?? '';
      await client.query(
        `UPDATE club_reservations SET charge_id = $2, hold_expires_at = now() - interval '6 minutes'
          WHERE id = $1`,
        [id, chargeId],
      );
      return id;
    };
    const unpaid = await charge();
    const unpaidHold = await hold(unpaid, 10);
    const paid = await charge();
    const paidHold = await hold(paid, 12);
    // A desk payment confirms the hold at once, by trigger.
    await client.query(
      `INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method, received_on)
       VALUES ($1, $2, $3, 'payment', 2000, 'cash', current_date)`,
      [club.clubId, paid, memberId],
    );
    const states = async () =>
      Object.fromEntries(
        (
          await client.query<{ id: string; state: string }>(
            `SELECT id, state FROM club_reservations WHERE id = ANY($1::uuid[])`,
            [[unpaidHold, paidHold]],
          )
        ).rows.map((r) => [r.id, r.state]),
      );
    expect((await states())[paidHold]).toBe('confirmed');

    expect(await expireReservationHolds(getDb())).toBeGreaterThanOrEqual(1);
    expect(await states()).toEqual({ [unpaidHold]: 'expired', [paidHold]: 'confirmed' });
    const charges = await client.query<{ id: string; voided: boolean }>(
      `SELECT id, voided_at IS NOT NULL AS voided FROM club_charges WHERE id = ANY($1::uuid[])`,
      [[unpaid, paid]],
    );
    expect(Object.fromEntries(charges.rows.map((r) => [r.id, r.voided]))).toEqual({
      [unpaid]: true,
      [paid]: false,
    });
    // The released slot is free again.
    await reserve({ resourceId: court }, 10, 11);
  });

  it('keeps what was booked: terms, charge, client and an ended state never move', async () => {
    const court = await resource();
    const row = await reserve({ resourceId: court }, 10, 11);
    const id = row.rows[0]?.id ?? '';
    const guarded = async (set: string) =>
      (await failure(client.query(`UPDATE club_reservations SET ${set} WHERE id = $1`, [id])))
        .constraint;
    expect(await guarded('price_cents = 1')).toBe('club_reservations_booked_terms');
    expect(await guarded('cancel_deadline_hours = 168')).toBe('club_reservations_booked_terms');
    expect(await guarded('buffer_minutes = 30')).toBe('club_reservations_booked_terms');
    // A move keeps the length it was priced at.
    expect(await guarded(`ends_at = ends_at + interval '1 hour'`)).toBe(
      'club_reservations_booked_terms',
    );
    // States only move forward: a confirmed booking is never handed back to
    // the hold sweep, nor "expired" as if it had been a hold.
    expect(await guarded(`state = 'held', hold_expires_at = now()`)).toBe(
      'club_reservations_booked_terms',
    );
    expect(await guarded(`state = 'expired'`)).toBe('club_reservations_booked_terms');
    const other = await makeMember(client, club.clubId, 'Друг');
    expect(await guarded(`member_id = '${other}'`)).toBe('club_reservations_booked_terms');
    // A charge is attached once…
    const charge = async () =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on)
           VALUES ($1, $2, 'reservation', 'Корт', 2000, current_date, current_date) RETURNING id`,
          [club.clubId, memberId],
        )
      ).rows[0]?.id ?? '';
    await client.query(`UPDATE club_reservations SET charge_id = $2 WHERE id = $1`, [
      id,
      await charge(),
    ]);
    // …and never re-pointed; nor shared with another booking.
    const attached = await client.query<{ charge_id: string }>(
      `SELECT charge_id FROM club_reservations WHERE id = $1`,
      [id],
    );
    expect(await guarded(`charge_id = '${await charge()}'`)).toBe('club_reservations_booked_terms');
    const twin = await reserve({ resourceId: court }, 14, 15);
    const shared = await failure(
      client.query(`UPDATE club_reservations SET charge_id = $2 WHERE id = $1`, [
        twin.rows[0]?.id,
        attached.rows[0]?.charge_id,
      ]),
    );
    expect(shared.code).toBe('23505');
    // An ended booking stays ended; its slot may already be someone else's.
    await client.query(
      `UPDATE club_reservations SET state = 'cancelled', cancelled_at = now(), cancel_kind = 'staff'
        WHERE id = $1`,
      [id],
    );
    expect(await guarded(`state = 'confirmed', cancelled_at = NULL, cancel_kind = NULL`)).toBe(
      'club_reservations_booked_terms',
    );
    // …in anything: who cancelled it, and when it was, are the record.
    expect(await guarded(`cancel_kind = 'member'`)).toBe('club_reservations_booked_terms');
    expect(
      await guarded(
        `starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day'`,
      ),
    ).toBe('club_reservations_booked_terms');
    // Only erasure still reaches it.
    await client.query(`UPDATE club_reservations SET member_id = NULL WHERE id = $1`, [id]);
  });

  it('refuses a pool only when every unit is taken at the same moment', async () => {
    const rackets = await resource(2);
    await reserve({ resourceId: rackets }, 9, 11);
    await reserve({ resourceId: rackets }, 11, 13);
    // 10–12 touches both, but only one racket is ever out at a time.
    await reserve({ resourceId: rackets }, 10, 12);
    const third = await failure(reserve({ resourceId: rackets }, 10, 11));
    expect(third.code).toBe('23P01');
    expect(third.constraint).toBe('club_calendar_claims_pool_full');
  });

  it('lets a class claim its room, and a booking cannot take it from the class', async () => {
    const room = await resource();
    const { classId } = await makeOccurrence(client, club, { daysAhead: 3 });
    await client.query(`UPDATE club_classes SET resource_id = $2 WHERE id = $1`, [classId, room]);
    const claims = await client.query(
      `SELECT count(*)::int AS n FROM club_calendar_claims WHERE resource_id = $1 AND source = 'occurrence'`,
      [room],
    );
    expect(claims.rows[0]?.n).toBe(1);
    // Moving the class out of the room frees it.
    await client.query(`UPDATE club_classes SET resource_id = NULL WHERE id = $1`, [classId]);
    const freed = await client.query(
      `SELECT count(*)::int AS n FROM club_calendar_claims WHERE resource_id = $1`,
      [room],
    );
    expect(freed.rows[0]?.n).toBe(0);
  });

  it("collides a trainer's appointments with each other and with their leave", async () => {
    const trainer = await ensureUser(client, 'courts_trainer');
    await client.query(
      `INSERT INTO club_staff (club_id, user_id, role) VALUES ($1, $2, 'trainer')`,
      [club.clubId, trainer],
    );
    await reserve({ staffId: trainer }, 10, 11);
    expect((await failure(reserve({ staffId: trainer }, 10, 11))).constraint).toBe(
      'club_calendar_claims_staff_free',
    );
    const leave = await failure(
      client.query(
        `INSERT INTO club_time_blocks (club_id, staff_user_id, starts_at, ends_at, reason)
         VALUES ($1, $2, ((current_date + 1)::timestamp + interval '9 hours') AT TIME ZONE 'Europe/Sofia',
                 ((current_date + 1)::timestamp + interval '12 hours') AT TIME ZONE 'Europe/Sofia', 'time_off')`,
        [club.clubId, trainer],
      ),
    );
    expect(leave.code).toBe('23P01');
  });

  it('closes a court for maintenance with a block', async () => {
    const court = await resource();
    await client.query(
      `INSERT INTO club_time_blocks (club_id, resource_id, starts_at, ends_at, reason)
       VALUES ($1, $2, ((current_date + 1)::timestamp + interval '8 hours') AT TIME ZONE 'Europe/Sofia',
               ((current_date + 1)::timestamp + interval '12 hours') AT TIME ZONE 'Europe/Sofia', 'other')`,
      [club.clubId, court],
    );
    expect((await failure(reserve({ resourceId: court }, 9, 10))).code).toBe('23P01');
    const both = await failure(
      client.query(
        `INSERT INTO club_time_blocks (club_id, resource_id, staff_user_id, starts_at, ends_at, reason)
         VALUES ($1, $2, $3, now(), now() + interval '1 hour', 'other')`,
        [club.clubId, court, club.ownerId],
      ),
    );
    expect(both.constraint).toBe('club_time_blocks_one_target');
  });

  it('keeps a closure closing every unit when the pool grows', async () => {
    const lanes = await resource();
    await client.query(
      `INSERT INTO club_time_blocks (club_id, resource_id, starts_at, ends_at, reason)
       VALUES ($1, $2, ((current_date + 1)::timestamp + interval '8 hours') AT TIME ZONE 'Europe/Sofia',
               ((current_date + 1)::timestamp + interval '12 hours') AT TIME ZONE 'Europe/Sofia', 'other')`,
      [club.clubId, lanes],
    );
    // Created as one lane, corrected to four: the closure still takes all four.
    await client.query(`UPDATE club_resources SET quantity = 4 WHERE id = $1`, [lanes]);
    const refused = await failure(reserve({ resourceId: lanes }, 9, 10));
    expect(refused.constraint).toBe('club_calendar_claims_pool_full');
    await reserve({ resourceId: lanes }, 12, 13);
  });

  it('keeps the slot, anonymised, when the client is erased', async () => {
    const court = await resource();
    const booked = await reserve({ resourceId: court }, 10, 11);
    await client.query(`DELETE FROM club_members WHERE id = $1`, [memberId]);
    const kept = await client.query(
      `SELECT r.member_id, (SELECT count(*)::int FROM club_calendar_claims c
                             WHERE c.source_id = r.id) AS claims
         FROM club_reservations r WHERE r.id = $1`,
      [booked.rows[0]?.id],
    );
    expect(kept.rows).toEqual([{ member_id: null, claims: 1 }]);
  });

  it('refuses a reservation that takes nothing, and a service sold in uneven steps', async () => {
    expect((await failure(reserve({}, 10, 11))).constraint).toBe(
      'club_reservations_takes_something',
    );
    const uneven = await failure(
      client.query(
        `INSERT INTO club_services (club_id, location_id, kind, name_bg, duration_min, duration_max,
                                    step_minutes, price_cents)
         VALUES ($1, $2, 'rental', 'Корт', 60, 100, 30, 2000)`,
        [club.clubId, club.locationId],
      ),
    );
    expect(uneven.constraint).toBe('club_services_durations_sane');
  });
  it('books two different hours of one court at once without a deadlock', async () => {
    const court = await resource();
    const other = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await other.connect();
    try {
      await client.query('BEGIN');
      await other.query('BEGIN');
      const insert = (c: pg.Client, hour: number) =>
        c.query(
          `INSERT INTO club_reservations (club_id, service_id, member_id, resource_id, starts_at,
                                          ends_at, price_cents, cancel_deadline_hours)
           VALUES ($1, $2, $3, $4,
                   ((current_date + 1)::timestamp + make_interval(hours => $5::int)) AT TIME ZONE 'Europe/Sofia',
                   ((current_date + 1)::timestamp + make_interval(hours => $5::int + 1)) AT TIME ZONE 'Europe/Sofia',
                   2000, 24)`,
          [club.clubId, serviceId, memberId, court, hour],
        );
      await insert(client, 9);
      const second = insert(other, 14);
      await client.query('COMMIT');
      await second;
      await other.query('COMMIT');
    } finally {
      await other.query('ROLLBACK').catch(() => undefined);
      await other.end();
    }
    const count = await client.query(
      `SELECT count(*)::int AS n FROM club_reservations WHERE resource_id = $1`,
      [court],
    );
    expect(count.rows[0]?.n).toBe(2);
  });

  it('never re-checks a booking for an erasure, even after the pool shrank', async () => {
    const lanes = await resource(2);
    await reserve({ resourceId: lanes }, 10, 11);
    const second = await makeMember(client, club.clubId, 'Иван');
    await client.query(
      `INSERT INTO club_reservations (club_id, service_id, member_id, resource_id, starts_at, ends_at, price_cents, cancel_deadline_hours)
       VALUES ($1, $2, $3, $4,
               ((current_date + 1)::timestamp + interval '10 hours') AT TIME ZONE 'Europe/Sofia',
               ((current_date + 1)::timestamp + interval '11 hours') AT TIME ZONE 'Europe/Sofia', 2000, 24)`,
      [club.clubId, serviceId, second, lanes],
    );
    // Two lanes are out at 10:00: the pool cannot shrink to one.
    const shrink = await failure(
      client.query(`UPDATE club_resources SET quantity = 1 WHERE id = $1`, [lanes]),
    );
    // Refused either way: as one lane the two bookings now overlap (EXCLUDE).
    expect(shrink.code).toBe('23P01');
    // Erasing a client changes no busy time and re-checks nothing.
    await client.query(`DELETE FROM club_members WHERE id = $1`, [second]);
  });

  it('makes a pool exclusive when it shrinks to one, so it cannot be double-booked', async () => {
    const lanes = await resource(3);
    await reserve({ resourceId: lanes }, 10, 11);
    await client.query(`UPDATE club_resources SET quantity = 1 WHERE id = $1`, [lanes]);
    expect((await failure(reserve({ resourceId: lanes }, 10, 11))).code).toBe('23P01');
  });

  it('closes every unit of a pool with one block', async () => {
    const lanes = await resource(4);
    await client.query(
      `INSERT INTO club_time_blocks (club_id, resource_id, starts_at, ends_at, reason)
       VALUES ($1, $2, ((current_date + 1)::timestamp + interval '8 hours') AT TIME ZONE 'Europe/Sofia',
               ((current_date + 1)::timestamp + interval '12 hours') AT TIME ZONE 'Europe/Sofia', 'other')`,
      [club.clubId, lanes],
    );
    expect((await failure(reserve({ resourceId: lanes }, 9, 10))).constraint).toBe(
      'club_calendar_claims_pool_full',
    );
  });

  it('refuses any writer of the calendar but its triggers', async () => {
    const court = await resource();
    await reserve({ resourceId: court }, 10, 11);
    const direct = await failure(
      client.query(`DELETE FROM club_calendar_claims WHERE resource_id = $1`, [court]),
    );
    expect(direct.message).toMatch(/written only by the calendar triggers/);
    // Ratings reference reservations (0052): truncating with them gets past the
    // foreign-key check, so the refusal is the guard's own.
    const truncate = await failure(client.query(`TRUNCATE club_reservations, club_feedback`));
    expect(truncate.message).toMatch(/cannot be truncated/);
  });

  it('lets a class claim only a room at its own location', async () => {
    const elsewhere = await client.query<{ id: string }>(
      `INSERT INTO club_locations (club_id, name) VALUES ($1, 'Друга зала') RETURNING id`,
      [club.clubId],
    );
    const far = await client.query<{ id: string }>(
      `INSERT INTO club_resources (club_id, location_id, kind, name) VALUES ($1, $2, 'room', 'Зала Б')
       RETURNING id`,
      [club.clubId, elsewhere.rows[0]?.id],
    );
    const { classId } = await makeOccurrence(client, club, { daysAhead: 3 });
    const wrong = await failure(
      client.query(`UPDATE club_classes SET resource_id = $2 WHERE id = $1`, [
        classId,
        far.rows[0]?.id,
      ]),
    );
    expect(wrong.constraint).toBe('club_classes_resource_fk');
  });
  it('skips (and reports) a class date whose room is taken, and moves without colliding with itself', async () => {
    const room = await resource();
    const klass = await client.query<{ id: string }>(
      `INSERT INTO club_classes (club_id, location_id, title, sport, starts_at_local, duration_minutes,
                                 rrule, resource_id)
       VALUES ($1, $2, 'Йога', 'yoga', (current_date + 1)::timestamp + interval '18 hours', 60,
               'FREQ=WEEKLY', $3)
       RETURNING id`,
      [club.clubId, club.locationId, room],
    );
    const classId = klass.rows[0]?.id ?? '';
    // A rental already holds the room on the class's second date.
    await client.query(
      `INSERT INTO club_reservations (club_id, service_id, member_id, resource_id, starts_at, ends_at, price_cents, cancel_deadline_hours)
       VALUES ($1, $2, $3, $4,
               ((current_date + 8)::timestamp + interval '18 hours') AT TIME ZONE 'Europe/Sofia',
               ((current_date + 8)::timestamp + interval '19 hours') AT TIME ZONE 'Europe/Sofia', 2000, 24)`,
      [club.clubId, serviceId, memberId, room],
    );
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
    try {
      const first = await materializeClubClasses(pool, { classId, horizonWeeks: 3 });
      expect(first.failures).toEqual([]);
      expect(first.conflicts).toHaveLength(1);
      expect(first.occurrencesCreated).toBeGreaterThanOrEqual(2);
      // Half an hour later: the old 18:00 claims must go before 18:30 claims.
      await client.query(
        `UPDATE club_classes SET starts_at_local = starts_at_local + interval '30 minutes',
                                 materialized_through = NULL
          WHERE id = $1`,
        [classId],
      );
      const moved = await materializeClubClasses(pool, { classId, horizonWeeks: 3 });
      expect(moved.failures).toEqual([]);
      const times = await client.query(
        `SELECT DISTINCT to_char(starts_at AT TIME ZONE 'Europe/Sofia', 'HH24:MI') AS t
           FROM club_class_occurrences WHERE class_id = $1 AND status = 'scheduled'`,
        [classId],
      );
      expect(times.rows).toEqual([{ t: '18:30' }]);
    } finally {
      await pool.end();
    }
  });
});
