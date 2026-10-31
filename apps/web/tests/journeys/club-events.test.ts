import { expireEventHolds, getDb, getPool, sql } from '@sportkarta/db';
import { MemoryMailer } from '@sportkarta/lib/email';
import { MemoryPushSender } from '@sportkarta/lib/push';
import { MemorySmsSender } from '@sportkarta/lib/sms';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  cancelEvent,
  cancelEventPlace,
  eventForStaff,
  publicEvent,
  publishEvent,
  registerForEvent,
  saveEvent,
  saveEventTicket,
} from '@/lib/clubs/events';
import { clubExportCsv } from '@/lib/clubs/export';
import type { EventInput, EventTicketInput } from '@/lib/clubs/input';
import { checkoutReturn, startChargeCheckout } from '@/lib/clubs/payments';
import { refundsDue } from '@/lib/clubs/reservations';
import type { ClubActor } from '@/lib/clubs/scope';

import { runClubNotify } from '../../../worker/src/club-mail-job';

import { hasDb } from './db';

vi.mock('server-only', () => ({}));

/**
 * Events, camps and tournaments (0053), end to end: the app's own functions,
 * the worker's own notice code, real Postgres. What must hold:
 *
 *   * management puts an event on — a draft, its tickets, then published; a
 *     trainer and the desk cannot; a court already taken refuses the event;
 *   * a stranger registers and gets a record of their own; a full event puts
 *     the next in line, in arrival order; giving a place up in time moves the
 *     line at once, and the person who moved up is told;
 *   * an event that takes payment online only holds the seat while the person
 *     pays; a payment confirms it; a lapsed hold is released and the seat is
 *     OFFERED to the next in line, to pay by its own deadline;
 *   * late is late: a confirmed place given up after the deadline keeps its
 *     charge;
 *   * audiences, teams, the registration window and one unpaid place at a time;
 *   * cancelling the event cancels every place, tells everyone, and lists
 *     what was paid as owed back;
 *   * the export carries the places; another club sees nothing.
 *
 * COMMITS under its own `e2e-je-*` clubs and `e2e_club_je_*` accounts,
 * removed through the real purge path.
 */

const PREFIX = 'e2e_club_je_';

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-je-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
}

describe.skipIf(!hasDb)('club events journey (requires running database)', () => {
  let db: ReturnType<typeof getDb>;
  let clubId = '';
  let slug = '';
  let locationId = '';
  let owner: ClubActor;
  let desk: ClubActor;
  let trainer: ClubActor;
  const mailer = new MemoryMailer();
  const options = {
    mailer,
    siteUrl: 'https://pops.test',
    channels: {
      sms: { sender: new MemorySmsSender(), on: false },
      push: { sender: new MemoryPushSender(), on: false },
    },
  };
  const saved = {
    payments: process.env.CLUB_PAYMENTS_ENABLED,
    provider: process.env.PAYMENT_PROVIDER,
  };

  async function account(label: string): Promise<string> {
    const id = `${PREFIX}${label}_${Math.random().toString(36).slice(2, 8)}`;
    await db.execute(sql`
      INSERT INTO users (id, display_name, email, email_verified)
      VALUES (${id}, ${`Journey ${label}`}, ${`${id}@example.org`}, true)
    `);
    return id;
  }

  async function staff(role: 'desk' | 'trainer'): Promise<ClubActor> {
    const userId = await account(role);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${userId}, ${role})
    `);
    return { userId, clubId, role, ngoAdmin: false };
  }

  const hours = (h: number) => new Date(Date.now() + h * 3600_000);

  function input(fields: Partial<EventInput> = {}): EventInput {
    return {
      kind: 'camp',
      titleBg: 'Летен лагер',
      titleEn: null,
      descriptionBg: null,
      descriptionEn: null,
      sport: null,
      locationId,
      resourceId: null,
      startsAt: hours(72),
      endsAt: hours(80),
      registrationOpensAt: null,
      registrationClosesAt: null,
      capacity: 1,
      teamEvent: false,
      payment: 'desk',
      cancelDeadlineHours: 24,
      public: true,
      ...fields,
    };
  }

  const ticket = (fields: Partial<EventTicketInput> = {}): EventTicketInput => ({
    nameBg: 'Общ билет',
    nameEn: null,
    priceCents: 0,
    memberPriceCents: null,
    capacity: null,
    audience: 'all',
    sortOrder: 0,
    ...fields,
  });

  /** A published event with one ticket; returns the event and ticket ids. */
  async function published(
    fields: Partial<EventInput> = {},
    ticketFields: Partial<EventTicketInput> = {},
  ): Promise<{ eventId: string; ticketId: string }> {
    const created = await saveEvent(db, owner, input(fields), null);
    if (!created.ok) throw new Error(`saveEvent: ${created.error}`);
    expect((await saveEventTicket(db, owner, created.eventId, ticket(ticketFields), null)).ok).toBe(
      true,
    );
    expect(await publishEvent(db, owner, created.eventId)).toBe('ok');
    const tickets = await db.execute(sql`
      SELECT id FROM club_event_tickets WHERE event_id = ${created.eventId}::uuid
    `);
    return { eventId: created.eventId, ticketId: String(tickets.rows[0]?.id) };
  }

  const member = (userId: string) => ({ kind: 'member' as const, userId, clubId });
  const self = (ticketId: string) => ({ ticketId, memberId: null, teamName: null });

  async function stateOf(registrationId: string): Promise<string> {
    const row = await db.execute(sql`
      SELECT state FROM club_event_registrations WHERE id = ${registrationId}::uuid
    `);
    return String(row.rows[0]?.state);
  }

  beforeAll(async () => {
    db = getDb();
    process.env.CLUB_PAYMENTS_ENABLED = 'true';
    process.env.PAYMENT_PROVIDER = 'fake';
    await cleanup();
    const ownerId = await account('owner');
    slug = `e2e-je-${Math.random().toString(36).slice(2, 8)}`;
    const club = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until, visible)
      VALUES (${slug}, 'Клуб Събития', 'standard', 'active', now(), (now() + interval '1 year')::date,
              true)
      RETURNING id
    `);
    clubId = String(club.rows[0]?.id);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${ownerId}, 'owner')
    `);
    owner = { userId: ownerId, clubId, role: 'owner', ngoAdmin: false };
    const location = await db.execute(sql`
      INSERT INTO club_locations (club_id, name, address)
      VALUES (${clubId}::uuid, 'Зала', 'ул. Тестова 1') RETURNING id
    `);
    locationId = String(location.rows[0]?.id);
    await db.execute(sql`
      INSERT INTO club_payment_accounts (club_id, provider, account_ref, charges_enabled)
      VALUES (${clubId}::uuid, 'fake', ${`acct_je_${Math.random().toString(36).slice(2, 8)}`}, true)
    `);
    desk = await staff('desk');
    trainer = await staff('trainer');
  });

  afterAll(async () => {
    process.env.CLUB_PAYMENTS_ENABLED = saved.payments;
    process.env.PAYMENT_PROVIDER = saved.provider;
    await cleanup();
    await getPool().end();
  });

  it('lets only management put an event on, and refuses a court already taken', async () => {
    expect((await saveEvent(db, trainer, input(), null)).ok).toBe(false);
    expect((await saveEvent(db, desk, input(), null)).ok).toBe(false);
    const draft = await saveEvent(db, owner, input(), null);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    // No ticket, no publication; the desk cannot publish.
    expect(await publishEvent(db, owner, draft.eventId)).toBe('no_tickets');
    expect((await saveEventTicket(db, owner, draft.eventId, ticket(), null)).ok).toBe(true);
    expect(await publishEvent(db, desk, draft.eventId)).toBe('not_allowed');
    expect(await publishEvent(db, owner, draft.eventId)).toBe('ok');
    expect((await publicEvent(clubId, draft.eventId, 'bg'))?.open).toBe(true);

    const court = await db.execute(sql`
      INSERT INTO club_resources (club_id, location_id, kind, name)
      VALUES (${clubId}::uuid, ${locationId}::uuid, 'court', 'Корт 1') RETURNING id
    `);
    const resourceId = String(court.rows[0]?.id);
    await published({ resourceId, startsAt: hours(200), endsAt: hours(204) });
    const clash = await saveEvent(
      db,
      owner,
      input({ resourceId, startsAt: hours(202), endsAt: hours(206) }),
      null,
    );
    expect(clash.ok).toBe(true);
    if (!clash.ok) return;
    expect((await saveEventTicket(db, owner, clash.eventId, ticket(), null)).ok).toBe(true);
    expect(await publishEvent(db, owner, clash.eventId)).toBe('resource_taken');
  });

  it('seats the first, puts the rest in line in arrival order, and moves the line when a place is given up', async () => {
    const { eventId, ticketId } = await published();
    const anna = await account('anna');
    const boris = await account('boris');
    const vera = await account('vera');
    const first = await registerForEvent(db, member(anna), eventId, self(ticketId));
    const second = await registerForEvent(db, member(boris), eventId, self(ticketId));
    const third = await registerForEvent(db, member(vera), eventId, self(ticketId));
    expect(first).toMatchObject({ ok: true, state: 'confirmed' });
    expect(second).toMatchObject({ ok: true, state: 'waitlisted' });
    expect(third).toMatchObject({ ok: true, state: 'waitlisted' });
    if (!first.ok || !second.ok || !third.ok) return;
    // The same person twice is refused.
    expect(await registerForEvent(db, member(anna), eventId, self(ticketId))).toEqual({
      ok: false,
      error: 'already_registered',
    });

    mailer.sent.length = 0;
    await runClubNotify(
      { kind: 'event_registered', registrationId: second.registrationId },
      options,
    );
    expect(mailer.sent.map((m) => m.to)).toEqual([`${boris}@example.org`]);
    expect(mailer.sent[0]?.text).toContain('№ 1');

    const given = await cancelEventPlace(db, member(anna), first.registrationId);
    expect(given).toMatchObject({ ok: true, late: false, refundDue: false });
    if (!given.ok) return;
    expect(given.promotions.map((p) => p.registrationId)).toEqual([second.registrationId]);
    expect(await stateOf(second.registrationId)).toBe('confirmed');
    expect(await stateOf(third.registrationId)).toBe('waitlisted');

    mailer.sent.length = 0;
    await runClubNotify(
      { kind: 'event_promoted', registrationIds: [second.registrationId] },
      options,
    );
    expect(mailer.sent.map((m) => m.to)).toEqual([`${boris}@example.org`]);

    // The front of house sees who; a trainer sees counts only.
    expect((await eventForStaff(desk, eventId, 'bg'))?.places.length).toBeGreaterThan(0);
    expect((await eventForStaff(trainer, eventId, 'bg'))?.places).toEqual([]);
  });

  it('holds a seat while it is paid online, and offers a lapsed one to the line', async () => {
    const { eventId, ticketId } = await published(
      { payment: 'online_required', capacity: 1 },
      { priceCents: 3000 },
    );
    const payer = await account('payer');
    const patient = await account('patient');
    const held = await registerForEvent(db, member(payer), eventId, self(ticketId));
    expect(held).toMatchObject({ ok: true, state: 'held' });
    if (!held.ok || !held.chargeId) return;
    // One unpaid place at a club at a time.
    const another = await published(
      { payment: 'online_required', startsAt: hours(300), endsAt: hours(305) },
      { priceCents: 1000 },
    );
    expect(
      await registerForEvent(db, member(payer), another.eventId, self(another.ticketId)),
    ).toEqual({ ok: false, error: 'hold_pending' });

    const waiting = await registerForEvent(db, member(patient), eventId, self(ticketId));
    expect(waiting).toMatchObject({ ok: true, state: 'waitlisted' });
    if (!waiting.ok) return;

    // The hold lapses unpaid: released, its charge voided, and the seat offered on.
    await db.execute(sql`
      UPDATE club_event_registrations SET hold_expires_at = now() - interval '1 hour'
       WHERE id = ${held.registrationId}::uuid
    `);
    const promoted = await expireEventHolds(db, 'fake');
    expect(promoted).toEqual([
      expect.objectContaining({ registrationId: waiting.registrationId, state: 'held' }),
    ]);
    expect(await stateOf(held.registrationId)).toBe('expired');
    const voided = await db.execute(sql`
      SELECT voided_at IS NOT NULL AS voided FROM club_charges WHERE id = ${held.chargeId}::uuid
    `);
    expect(voided.rows[0]?.voided).toBe(true);
    const offer = await db.execute(sql`
      SELECT charge_id FROM club_event_registrations WHERE id = ${waiting.registrationId}::uuid
    `);
    const offerCharge = String(offer.rows[0]?.charge_id);
    // Paid at the desk all the same: the payment confirms the place.
    await db.execute(sql`
      INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                 received_on, recorded_by)
      SELECT ch.club_id, ch.id, ch.member_id, 'payment', 3000, 'cash',
             (now() AT TIME ZONE 'Europe/Sofia')::date, ${desk.userId}
        FROM club_charges ch WHERE ch.id = ${offerCharge}::uuid
    `);
    expect(await stateOf(waiting.registrationId)).toBe('confirmed');

    // The club cancels: every place goes, everyone is told, the paid one is owed back.
    const cancelled = await cancelEvent(db, owner, eventId);
    expect(cancelled).toMatchObject({ ok: true });
    if (!cancelled.ok) return;
    expect(cancelled.registrationIds).toEqual([waiting.registrationId]);
    expect((await refundsDue(owner)).find((r) => r.chargeId === offerCharge)).toMatchObject({
      source: 'event',
      paidCents: 3000,
    });
    mailer.sent.length = 0;
    await runClubNotify(
      { kind: 'event_cancelled', registrationIds: cancelled.registrationIds },
      options,
    );
    expect(mailer.sent.map((m) => m.to)).toEqual([`${patient}@example.org`]);
    // Cancelled is final.
    expect(await publishEvent(db, owner, eventId)).toBe('not_allowed');
  });

  it('keeps a late cancellation’s charge', async () => {
    const { eventId, ticketId } = await published(
      { startsAt: hours(10), endsAt: hours(12), cancelDeadlineHours: 24, capacity: 5 },
      { priceCents: 1500 },
    );
    const keen = await account('keen');
    const place = await registerForEvent(db, member(keen), eventId, self(ticketId));
    expect(place).toMatchObject({ ok: true, state: 'confirmed' });
    if (!place.ok) return;
    const late = await cancelEventPlace(db, member(keen), place.registrationId);
    expect(late).toMatchObject({ ok: true, late: true });
    const charge = await db.execute(sql`
      SELECT voided_at IS NULL AS live FROM club_charges WHERE id = ${place.chargeId}::uuid
    `);
    expect(charge.rows[0]?.live).toBe(true);
  });

  it('holds audiences, teams and the window, and never cuts a capacity below the seats', async () => {
    const kids = await published(
      { startsAt: hours(500), endsAt: hours(505) },
      { audience: 'minors' },
    );
    const adult = await account('adult');
    expect(await registerForEvent(db, member(adult), kids.eventId, self(kids.ticketId))).toEqual({
      ok: false,
      error: 'audience_mismatch',
    });

    const teams = await published({
      teamEvent: true,
      startsAt: hours(600),
      endsAt: hours(605),
      capacity: 2,
    });
    const captain = await account('captain');
    const other = await account('other');
    expect(
      await registerForEvent(db, member(captain), teams.eventId, self(teams.ticketId)),
    ).toEqual({ ok: false, error: 'team_required' });
    for (const [who, team] of [
      [captain, 'Сините'],
      [other, 'Червените'],
    ] as const) {
      expect(
        await registerForEvent(db, member(who), teams.eventId, {
          ...self(teams.ticketId),
          teamName: team,
        }),
      ).toMatchObject({ ok: true, state: 'confirmed' });
    }
    expect(
      await saveEvent(
        db,
        owner,
        input({ teamEvent: true, startsAt: hours(600), endsAt: hours(605), capacity: 1 }),
        teams.eventId,
      ),
    ).toEqual({ ok: false, error: 'capacity_below_taken' });

    const closed = await published({ startsAt: hours(700), endsAt: hours(705) });
    await db.execute(sql`
      UPDATE club_events SET registration_opens_at = now() - interval '2 hours',
             registration_closes_at = now() - interval '1 minute'
       WHERE id = ${closed.eventId}::uuid
    `);
    const tardy = await account('tardy');
    expect(
      await registerForEvent(db, member(tardy), closed.eventId, self(closed.ticketId)),
    ).toEqual({ ok: false, error: 'closed' });
    // The desk is not bound by the window.
    const record = await db.execute(sql`
      INSERT INTO club_members (club_id, display_name) VALUES (${clubId}::uuid, 'На рецепцията')
      RETURNING id
    `);
    expect(
      await registerForEvent(db, { kind: 'staff', actor: desk }, closed.eventId, {
        ticketId: closed.ticketId,
        memberId: String(record.rows[0]?.id),
        teamName: null,
      }),
    ).toMatchObject({ ok: true, state: 'confirmed' });
  });

  it('keeps a member to their own places and charges, and each role to its own work', async () => {
    const { eventId, ticketId } = await published(
      { startsAt: hours(800), endsAt: hours(805), capacity: 5 },
      { priceCents: 1200 },
    );
    const alice = await account('alice');
    const mallory = await account('mallory');
    const place = await registerForEvent(db, member(alice), eventId, self(ticketId));
    expect(place).toMatchObject({ ok: true, state: 'confirmed' });
    if (!place.ok) return;
    const aliceRecord = await db.execute(sql`
      SELECT member_id FROM club_event_registrations WHERE id = ${place.registrationId}::uuid
    `);
    // Another account: not her place, not her record, not her charge.
    expect(await cancelEventPlace(db, member(mallory), place.registrationId)).toEqual({
      ok: false,
    });
    expect(
      await registerForEvent(db, member(mallory), eventId, {
        ticketId,
        memberId: String(aliceRecord.rows[0]?.member_id),
        teamName: null,
      }),
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(
      await startChargeCheckout(
        db,
        mallory,
        { id: clubId, slug },
        place.chargeId ?? '',
        checkoutReturn('bg'),
      ),
    ).toMatchObject({ ok: false, error: 'not_allowed' });

    // A trainer neither registers nor gives places up; the desk does not run events.
    const record = await db.execute(sql`
      INSERT INTO club_members (club_id, display_name) VALUES (${clubId}::uuid, 'Без профил')
      RETURNING id
    `);
    const recordId = String(record.rows[0]?.id);
    expect(
      await registerForEvent(db, { kind: 'staff', actor: trainer }, eventId, {
        ticketId,
        memberId: recordId,
        teamName: null,
      }),
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(
      await cancelEventPlace(db, { kind: 'staff', actor: trainer }, place.registrationId),
    ).toEqual({ ok: false });
    expect(await saveEventTicket(db, desk, eventId, ticket(), null)).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    expect(await cancelEvent(db, desk, eventId)).toEqual({ ok: false });
    expect(await stateOf(place.registrationId)).toBe('confirmed');

    // A pending link waits for the club.
    const waiting = await account('waiting');
    await db.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
      VALUES (${recordId}::uuid, ${clubId}::uuid, ${waiting}, 'pending', 'claim')
    `);
    expect(await registerForEvent(db, member(waiting), eventId, self(ticketId))).toEqual({
      ok: false,
      error: 'link_pending',
    });

    // The team flag is the event's: a name sent for a non-team event is not kept.
    const solo = await account('solo');
    const named = await registerForEvent(db, member(solo), eventId, {
      ...self(ticketId),
      teamName: 'Подхвърлено',
    });
    expect(named.ok).toBe(true);
    if (!named.ok) return;
    const team = await db.execute(sql`
      SELECT team_name FROM club_event_registrations WHERE id = ${named.registrationId}::uuid
    `);
    expect(team.rows[0]?.team_name).toBeNull();
  });

  it('gives a seat from the line after the deadline free to give up, and never cancels the past', async () => {
    const { eventId, ticketId } = await published(
      { startsAt: hours(10), endsAt: hours(12), cancelDeadlineHours: 24, capacity: 1 },
      { priceCents: 900 },
    );
    const early = await account('early');
    const next = await account('next');
    const first = await registerForEvent(db, member(early), eventId, self(ticketId));
    const second = await registerForEvent(db, member(next), eventId, self(ticketId));
    expect(second).toMatchObject({ ok: true, state: 'waitlisted' });
    if (!first.ok || !second.ok) return;
    // Registered after the deadline, knowingly: late.
    expect(await cancelEventPlace(db, member(early), first.registrationId)).toMatchObject({
      ok: true,
      late: true,
    });
    expect(await stateOf(second.registrationId)).toBe('confirmed');
    // Seated by the line after the deadline: never accepted late.
    expect(await cancelEventPlace(db, member(next), second.registrationId)).toMatchObject({
      ok: true,
      late: false,
    });

    const past = await published({ startsAt: hours(900), endsAt: hours(905) });
    await db.execute(sql`
      UPDATE club_events SET starts_at = now() - interval '3 hours',
             ends_at = now() - interval '1 hour'
       WHERE id = ${past.eventId}::uuid
    `);
    expect(await cancelEvent(db, owner, past.eventId)).toEqual({ ok: false });
  });

  it('offers a seat to pay online only with time to pay, and never past the start', async () => {
    const soon = await published(
      { payment: 'online_required', startsAt: hours(3), endsAt: hours(5), capacity: 1 },
      { priceCents: 2500 },
    );
    const holder = await account('holder');
    const linked = await account('linked');
    const seat = await registerForEvent(db, member(holder), soon.eventId, self(soon.ticketId));
    const line = await registerForEvent(db, member(linked), soon.eventId, self(soon.ticketId));
    expect(seat).toMatchObject({ ok: true, state: 'held' });
    expect(line).toMatchObject({ ok: true, state: 'waitlisted' });
    if (!seat.ok || !line.ok) return;
    const given = await cancelEventPlace(db, member(holder), seat.registrationId);
    expect(given).toMatchObject({ ok: true });
    if (!given.ok) return;
    expect(given.promotions).toEqual([
      expect.objectContaining({ registrationId: line.registrationId, state: 'held' }),
    ]);
    const offer = await db.execute(sql`
      SELECT r.hold_expires_at = e.starts_at AS capped
        FROM club_event_registrations r JOIN club_events e ON e.id = r.event_id
       WHERE r.id = ${line.registrationId}::uuid
    `);
    expect(offer.rows[0]?.capped).toBe(true);

    // Twenty minutes before the start there is no time to pay: given, owed at the desk.
    const last = await published(
      { payment: 'online_required', startsAt: hours(5), endsAt: hours(7), capacity: 1 },
      { priceCents: 2500 },
    );
    const a = await account('lasta');
    const b = await account('lastb');
    const firstSeat = await registerForEvent(db, member(a), last.eventId, self(last.ticketId));
    const behind = await registerForEvent(db, member(b), last.eventId, self(last.ticketId));
    if (!firstSeat.ok || !behind.ok) return;
    await db.execute(sql`
      UPDATE club_events SET starts_at = now() + interval '20 minutes'
       WHERE id = ${last.eventId}::uuid
    `);
    const moved = await cancelEventPlace(db, member(a), firstSeat.registrationId);
    expect(moved).toMatchObject({ ok: true });
    if (!moved.ok) return;
    expect(moved.promotions).toEqual([
      expect.objectContaining({ registrationId: behind.registrationId, state: 'confirmed' }),
    ]);
  });

  it('never lets an archived client in line keep a free seat from a newcomer', async () => {
    const { eventId, ticketId } = await published({
      startsAt: hours(1000),
      endsAt: hours(1005),
      capacity: 1,
    });
    const holder = await account('seated');
    const gone = await account('gone');
    const newcomer = await account('newcomer');
    const seat = await registerForEvent(db, member(holder), eventId, self(ticketId));
    const line = await registerForEvent(db, member(gone), eventId, self(ticketId));
    expect(line).toMatchObject({ ok: true, state: 'waitlisted' });
    if (!seat.ok || !line.ok) return;
    await db.execute(sql`
      UPDATE club_members SET archived_at = now()
       WHERE id = (SELECT member_id FROM club_event_registrations WHERE id = ${line.registrationId}::uuid)
    `);
    const given = await cancelEventPlace(db, member(holder), seat.registrationId);
    expect(given).toMatchObject({ ok: true, promotions: [] });
    expect(await registerForEvent(db, member(newcomer), eventId, self(ticketId))).toMatchObject({
      ok: true,
      state: 'confirmed',
    });
  });

  it('exports the places, and shows another club nothing', async () => {
    const csv = await clubExportCsv(owner, 'events');
    expect(csv.split('\n')[0]).toContain('event');
    expect(csv).toContain('Летен лагер');
    const otherOwner = await account('owner2');
    const other = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until)
      VALUES (${`e2e-je-${Math.random().toString(36).slice(2, 8)}`}, 'Друг', 'standard', 'active',
              now(), (now() + interval '1 year')::date)
      RETURNING id
    `);
    const otherClub = String(other.rows[0]?.id);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role)
      VALUES (${otherClub}::uuid, ${otherOwner}, 'owner')
    `);
    const stranger: ClubActor = {
      userId: otherOwner,
      clubId: otherClub,
      role: 'owner',
      ngoAdmin: false,
    };
    const anyEvent = await db.execute(sql`
      SELECT id FROM club_events WHERE club_id = ${clubId}::uuid LIMIT 1
    `);
    const id = String(anyEvent.rows[0]?.id);
    expect(await eventForStaff(stranger, id, 'bg')).toBeNull();
    expect(await cancelEvent(db, stranger, id)).toEqual({ ok: false });
    expect(await saveEventTicket(db, stranger, id, ticket(), null)).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    const someone = await db.execute(sql`
      SELECT er.id, er.ticket_id, er.member_id FROM club_event_registrations er
       WHERE er.club_id = ${clubId}::uuid AND er.state IN ('confirmed', 'waitlisted') LIMIT 1
    `);
    const theirs = someone.rows[0];
    expect(
      await registerForEvent(db, { kind: 'staff', actor: stranger }, id, {
        ticketId: String(theirs?.ticket_id),
        memberId: String(theirs?.member_id),
        teamName: null,
      }),
    ).toEqual({ ok: false, error: 'not_allowed' });
    expect(
      await cancelEventPlace(db, { kind: 'staff', actor: stranger }, String(theirs?.id)),
    ).toEqual({ ok: false });
  });
});
