import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './client.js';
import {
  expireEventHolds,
  lockEvent,
  promoteEventWaitlist,
  releaseLapsedEventHolds,
} from './clubs/events.js';
import {
  cleanupClubFixtures,
  ensureUser,
  failure,
  makeClub,
  makeMember,
  purgeClub,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * Events and their places (0053) — what the database itself guarantees:
 *
 *   * a seat is taken only while the event and the ticket have room, never
 *     ahead of somebody waiting for the same ticket, and only at a published
 *     event, on a live ticket; a capacity never drops below the seats taken;
 *   * a place starts alive, with its arrival ticket drawn by the database;
 *     what was registered never changes and states only move forward; one
 *     live place per person; one charge per place, of kind 'event';
 *   * a payment confirms a held place wherever it is taken;
 *   * an event goes draft → published → cancelled, never back; a published
 *     event closes its court — and only its own trigger writes that closure;
 *   * a lapsed hold is released (its charge voided) and the line moves into
 *     the seat, in arrival order;
 *   * erasure keeps the seat anonymised, and the purge empties every table.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('club events and places (requires running database)', () => {
  let client: pg.Client;
  let club: ClubFixture;
  let anna: string;
  let boris: string;
  let vera: string;

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
    club = await makeClub(client, 'events');
    anna = await makeMember(client, club.clubId, 'Анна');
    boris = await makeMember(client, club.clubId, 'Борис');
    vera = await makeMember(client, club.clubId, 'Вера');
  });

  async function event(
    fields: {
      capacity?: number | null;
      status?: 'draft' | 'published';
      resourceId?: string | null;
      payment?: string;
      fromHour?: number;
      toHour?: number;
    } = {},
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO club_events (club_id, kind, title_bg, location_id, resource_id, starts_at,
                                ends_at, capacity, payment, status)
       VALUES ($1, 'camp', 'Лагер', $2, $3,
               date_trunc('day', now()) + interval '2 days' + make_interval(hours => $4::int),
               date_trunc('day', now()) + interval '2 days' + make_interval(hours => $5::int),
               $6, $7, $8)
       RETURNING id`,
      [
        club.clubId,
        club.locationId,
        fields.resourceId ?? null,
        fields.fromHour ?? 9,
        fields.toHour ?? 17,
        fields.capacity === undefined ? 2 : fields.capacity,
        fields.payment ?? 'desk',
        fields.status ?? 'published',
      ],
    );
    return result.rows[0]?.id ?? '';
  }

  async function ticket(
    eventId: string,
    fields: { capacity?: number | null; priceCents?: number } = {},
  ): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO club_event_tickets (club_id, event_id, name_bg, price_cents, capacity)
       VALUES ($1, $2, 'Билет', $3, $4) RETURNING id`,
      [club.clubId, eventId, fields.priceCents ?? 0, fields.capacity ?? null],
    );
    return result.rows[0]?.id ?? '';
  }

  async function eventCharge(memberId: string, kind = 'event'): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on)
       VALUES ($1, $2, $3, 'Лагер', 2000, current_date, current_date) RETURNING id`,
      [club.clubId, memberId, kind],
    );
    return result.rows[0]?.id ?? '';
  }

  function place(
    eventId: string,
    ticketId: string,
    memberId: string,
    state: string,
    extra: { chargeId?: string | null; hold?: string | null; seq?: number } = {},
  ) {
    return client.query<{ id: string; seq: string }>(
      `INSERT INTO club_event_registrations (club_id, event_id, ticket_id, member_id, state,
                                             hold_expires_at, price_cents, cancel_deadline_hours,
                                             charge_id, seq)
       VALUES ($1, $2, $3, $4, $5, now() + $6::interval, 2000, 48, $7,
               coalesce($8::bigint, nextval('club_event_registration_seq')))
       RETURNING id, seq`,
      [
        club.clubId,
        eventId,
        ticketId,
        memberId,
        state,
        extra.hold ?? null,
        extra.chargeId ?? null,
        extra.seq ?? null,
      ],
    );
  }

  async function placeId(...args: Parameters<typeof place>): Promise<string> {
    return (await place(...args)).rows[0]?.id ?? '';
  }

  async function stateOf(id: string): Promise<string> {
    const result = await client.query<{ state: string }>(
      `SELECT state FROM club_event_registrations WHERE id = $1`,
      [id],
    );
    return result.rows[0]?.state ?? '';
  }

  async function cancel(id: string, by = 'member'): Promise<void> {
    await client.query(
      `UPDATE club_event_registrations SET state = 'cancelled', cancelled_at = now(),
              cancel_kind = $2 WHERE id = $1`,
      [id, by],
    );
  }

  describe('seats', () => {
    it('gives a seat only while the event and the ticket have room', async () => {
      const ev = await event({ capacity: 2 });
      const open = await ticket(ev);
      await place(ev, open, anna, 'confirmed');
      await place(ev, open, boris, 'confirmed');
      expect(await failure(place(ev, open, vera, 'confirmed'))).toMatchObject({
        constraint: 'club_event_registrations_full',
      });
      // In line is always possible.
      await place(ev, open, vera, 'waitlisted');

      const big = await event({ capacity: null });
      const small = await ticket(big, { capacity: 1 });
      await place(big, small, anna, 'confirmed');
      expect(await failure(place(big, small, boris, 'held', { hold: '1 hour' }))).toMatchObject({
        constraint: 'club_event_registrations_full',
      });
    });

    it('never seats a newcomer ahead of somebody waiting for the same ticket', async () => {
      const ev = await event({ capacity: 1 });
      const t = await ticket(ev);
      const first = await placeId(ev, t, anna, 'confirmed');
      await place(ev, t, boris, 'waitlisted');
      await cancel(first);
      expect(await failure(place(ev, t, vera, 'confirmed'))).toMatchObject({
        constraint: 'club_event_registrations_line_first',
      });
    });

    it('takes registrations only at a published event, on a live ticket', async () => {
      const draft = await event({ status: 'draft' });
      const t = await ticket(draft);
      expect(await failure(place(draft, t, anna, 'waitlisted'))).toMatchObject({
        constraint: 'club_event_registrations_event_open',
      });
      const ev = await event();
      const gone = await ticket(ev);
      await client.query(`UPDATE club_event_tickets SET archived_at = now() WHERE id = $1`, [gone]);
      expect(await failure(place(ev, gone, anna, 'confirmed'))).toMatchObject({
        constraint: 'club_event_registrations_ticket_live',
      });
    });

    it('never lets a capacity drop below the seats taken', async () => {
      const ev = await event({ capacity: 3 });
      const t = await ticket(ev, { capacity: 3 });
      await place(ev, t, anna, 'confirmed');
      await place(ev, t, boris, 'confirmed');
      expect(
        await failure(client.query(`UPDATE club_events SET capacity = 1 WHERE id = $1`, [ev])),
      ).toMatchObject({ constraint: 'club_events_capacity_taken' });
      expect(
        await failure(
          client.query(`UPDATE club_event_tickets SET capacity = 1 WHERE id = $1`, [t]),
        ),
      ).toMatchObject({ constraint: 'club_events_capacity_taken' });
      await client.query(`UPDATE club_events SET capacity = 2 WHERE id = $1`, [ev]);
    });
  });

  describe('places', () => {
    it('starts alive, draws its own arrival ticket, and keeps one live place per person', async () => {
      const ev = await event({ capacity: null });
      const t = await ticket(ev);
      expect(await failure(place(ev, t, anna, 'expired'))).toMatchObject({
        constraint: 'club_event_registrations_terms',
      });
      const forged = await place(ev, t, anna, 'confirmed', { seq: 1 });
      expect(Number(forged.rows[0]?.seq)).toBeGreaterThan(1);
      expect(await failure(place(ev, t, anna, 'waitlisted'))).toMatchObject({
        constraint: 'club_event_registrations_one_live',
      });
      await cancel(forged.rows[0]?.id ?? '');
      // Given up, it may be taken again — with a fresh arrival ticket.
      const again = await place(ev, t, anna, 'confirmed');
      expect(Number(again.rows[0]?.seq)).toBeGreaterThan(Number(forged.rows[0]?.seq));
    });

    it('never changes what was registered, and moves states forward only', async () => {
      const ev = await event({ capacity: null });
      const t = await ticket(ev);
      const id = await placeId(ev, t, anna, 'confirmed');
      expect(
        await failure(
          client.query(`UPDATE club_event_registrations SET price_cents = 1 WHERE id = $1`, [id]),
        ),
      ).toMatchObject({ constraint: 'club_event_registrations_terms' });
      expect(
        await failure(
          client.query(`UPDATE club_event_registrations SET state = 'waitlisted' WHERE id = $1`, [
            id,
          ]),
        ),
      ).toMatchObject({ constraint: 'club_event_registrations_terms' });
      await client.query(
        `UPDATE club_event_registrations SET state = 'late_cancelled', cancelled_at = now(),
                cancel_kind = 'member' WHERE id = $1`,
        [id],
      );
      expect(
        await failure(
          client.query(
            `UPDATE club_event_registrations SET state = 'cancelled', cancel_kind = 'staff'
              WHERE id = $1`,
            [id],
          ),
        ),
      ).toMatchObject({ constraint: 'club_event_registrations_terms' });
    });

    it('pays one place per charge, and only with an event charge', async () => {
      const ev = await event({ capacity: null });
      const t = await ticket(ev, { priceCents: 2000 });
      const shared = await eventCharge(anna);
      await place(ev, t, anna, 'confirmed', { chargeId: shared });
      expect(await failure(place(ev, t, boris, 'confirmed', { chargeId: shared }))).toMatchObject({
        constraint: 'club_event_registrations_charge_unique',
      });
      const fee = await eventCharge(boris, 'fee');
      expect(await failure(place(ev, t, boris, 'confirmed', { chargeId: fee }))).toMatchObject({
        constraint: 'club_event_registrations_charge_kind',
      });
    });

    it('confirms a held place when its charge is paid, wherever', async () => {
      const ev = await event({ capacity: 1 });
      const t = await ticket(ev, { priceCents: 2000 });
      const charge = await eventCharge(anna);
      const id = await placeId(ev, t, anna, 'held', { chargeId: charge, hold: '30 minutes' });
      const holds = await client.query(
        `SELECT source FROM club_charge_holds WHERE charge_id = $1`,
        [charge],
      );
      expect(holds.rows).toEqual([{ source: 'event' }]);
      await client.query(
        `INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                    received_on)
         VALUES ($1, $2, $3, 'payment', 2000, 'cash', current_date)`,
        [club.clubId, charge, anna],
      );
      expect(await stateOf(id)).toBe('confirmed');
    });
  });

  describe('the event', () => {
    it('goes draft → published → cancelled, never back', async () => {
      const ev = await event({ status: 'draft' });
      await client.query(`UPDATE club_events SET status = 'published' WHERE id = $1`, [ev]);
      expect(
        await failure(client.query(`UPDATE club_events SET status = 'draft' WHERE id = $1`, [ev])),
      ).toMatchObject({ constraint: 'club_events_status_flow' });
      await client.query(
        `UPDATE club_events SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
        [ev],
      );
      expect(
        await failure(
          client.query(
            `UPDATE club_events SET status = 'published', cancelled_at = NULL WHERE id = $1`,
            [ev],
          ),
        ),
      ).toMatchObject({ constraint: 'club_events_status_flow' });
    });

    it('closes its court while published, and only it writes that closure', async () => {
      const court = await client.query<{ id: string }>(
        `INSERT INTO club_resources (club_id, location_id, kind, name)
         VALUES ($1, $2, 'court', 'Корт') RETURNING id`,
        [club.clubId, club.locationId],
      );
      const resourceId = court.rows[0]?.id ?? '';
      const first = await event({ resourceId });
      const block = await client.query<{ id: string }>(
        `SELECT id FROM club_time_blocks WHERE event_id = $1`,
        [first],
      );
      expect(block.rows).toHaveLength(1);
      // An overlapping published event on the same court is refused by the calendar.
      expect(await failure(event({ resourceId, fromHour: 12, toHour: 20 }))).toMatchObject({
        code: '23P01',
      });
      // Nobody but the event removes its closure.
      expect(
        await failure(
          client.query(`DELETE FROM club_time_blocks WHERE id = $1`, [block.rows[0]?.id]),
        ),
      ).toMatchObject({ constraint: 'club_time_blocks_event_owned' });
      // A save that does not move the event keeps the same closure.
      await client.query(
        `UPDATE club_events SET title_bg = 'Лагер 2', starts_at = starts_at WHERE id = $1`,
        [first],
      );
      const kept = await client.query<{ id: string }>(
        `SELECT id FROM club_time_blocks WHERE event_id = $1`,
        [first],
      );
      expect(kept.rows[0]?.id).toBe(block.rows[0]?.id);
      // Cancelled, the court is free again.
      await client.query(
        `UPDATE club_events SET status = 'cancelled', cancelled_at = now() WHERE id = $1`,
        [first],
      );
      await event({ resourceId, fromHour: 12, toHour: 20 });
    });
  });

  describe('holds and the line', () => {
    it('releases a lapsed hold, voids its charge, and moves the line in arrival order', async () => {
      const ev = await event({ capacity: 1 });
      const t = await ticket(ev, { priceCents: 2000 });
      const charge = await eventCharge(anna);
      const held = await placeId(ev, t, anna, 'held', { chargeId: charge, hold: '-1 hour' });
      const firstInLine = await placeId(ev, t, boris, 'waitlisted');
      const second = await placeId(ev, t, vera, 'waitlisted');

      const promoted = await expireEventHolds(getDb(), null);
      expect(promoted.map((p) => p.registrationId)).toEqual([firstInLine]);
      expect(await stateOf(held)).toBe('expired');
      expect(await stateOf(firstInLine)).toBe('confirmed');
      expect(await stateOf(second)).toBe('waitlisted');
      const voided = await client.query<{ voided: boolean }>(
        `SELECT voided_at IS NOT NULL AS voided FROM club_charges WHERE id = $1`,
        [charge],
      );
      expect(voided.rows[0]?.voided).toBe(true);
      // The promoted place owes its own new event charge.
      const owed = await client.query<{ kind: string; amount_cents: number }>(
        `SELECT ch.kind, ch.amount_cents FROM club_event_registrations r
           JOIN club_charges ch ON ch.id = r.charge_id WHERE r.id = $1`,
        [firstInLine],
      );
      expect(owed.rows[0]).toMatchObject({ kind: 'event', amount_cents: 2000 });
    });

    it('offers the seat to be paid online when the event takes payment online only', async () => {
      const ev = await event({ capacity: 1, payment: 'online_required' });
      const t = await ticket(ev, { priceCents: 2000 });
      await client.query(
        `INSERT INTO club_payment_accounts (club_id, provider, account_ref, charges_enabled)
         VALUES ($1, 'fake', 'acct_events_test', true)`,
        [club.clubId],
      );
      // Boris can open the portal (a linked account); Vera, in line first, cannot.
      const borisUser = await ensureUser(client, 'events_boris');
      await client.query(
        `INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
         VALUES ($1, $2, $3, 'active', 'self')`,
        [boris, club.clubId, borisUser],
      );
      const seat = await placeId(ev, t, anna, 'confirmed');
      const unreachable = await placeId(ev, t, vera, 'waitlisted');
      const waiting = await placeId(ev, t, boris, 'waitlisted');
      const free = (id: string) =>
        getDb().transaction(async (tx) => {
          await lockEvent(tx, club.clubId, ev);
          // Free a seat as a cancellation would, under the event lock.
          await tx.execute(sql`
            UPDATE club_event_registrations SET state = 'cancelled', cancelled_at = now(),
                   cancel_kind = 'staff' WHERE id = ${id}::uuid`);
          expect(await releaseLapsedEventHolds(tx, club.clubId, ev)).toBe(0);
          return promoteEventWaitlist(tx, club.clubId, ev, 'fake');
        });
      // Nobody can pay Vera's place online: it is given, owed at the desk.
      expect(await free(seat)).toEqual([
        { clubId: club.clubId, eventId: ev, registrationId: unreachable, state: 'confirmed' },
      ]);
      // Boris can: the seat is offered, to be paid by its deadline.
      expect(await free(unreachable)).toEqual([
        { clubId: club.clubId, eventId: ev, registrationId: waiting, state: 'held' },
      ]);
      const offer = await client.query<{ state: string; hours: number }>(
        `SELECT state, round(extract(epoch FROM hold_expires_at - now()) / 3600)::int AS hours
           FROM club_event_registrations WHERE id = $1`,
        [waiting],
      );
      expect(offer.rows[0]).toEqual({ state: 'held', hours: 23 });
    });
  });

  it('keeps an erased client’s seat anonymised, and the purge empties every table', async () => {
    const ev = await event({ capacity: 2 });
    const t = await ticket(ev);
    const id = await placeId(ev, t, anna, 'confirmed');
    await client.query(`DELETE FROM club_members WHERE id = $1`, [anna]);
    const row = await client.query<{ member_id: string | null; state: string }>(
      `SELECT member_id, state FROM club_event_registrations WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({ member_id: null, state: 'confirmed' });

    await purgeClub(client, club.clubId);
    for (const table of ['club_events', 'club_event_tickets', 'club_event_registrations']) {
      const left = await client.query(`SELECT 1 FROM ${table} WHERE club_id = $1`, [club.clubId]);
      expect(left.rows, table).toHaveLength(0);
    }
  });
});
