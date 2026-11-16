import { getDb, getPool, materializeClubClasses, sql } from '@sportkarta/db';
import { addDaysIso, sofiaToday, type ClubNotifyJob } from '@sportkarta/lib/clubs';
import { sha256Hex } from '@sportkarta/lib/clubs/secrets';
import { MemoryMailer } from '@sportkarta/lib/email';
import { MemoryPushSender } from '@sportkarta/lib/push';
import { MemorySmsSender } from '@sportkarta/lib/sms';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { rosterOpAction } from '@/app/[locale]/klub/[slug]/(office)/grafik/actions';
import { bookAtDesk, bookTrial, cancelBooking, ensureSelfRecord } from '@/lib/clubs/bookings';
import { clubCheckIn } from '@/lib/clubs/checkin';
import { issueMemberCard } from '@/lib/clubs/members';
import { availability, bookReservation } from '@/lib/clubs/reservations';
import { saveLocationHours, saveResource } from '@/lib/clubs/resources';
import type { ClubActor } from '@/lib/clubs/scope';
import { saveService, saveStaffHours } from '@/lib/clubs/services';

import { runClubNotify } from '../../../worker/src/club-mail-job';

import { hasDb } from './db';

/**
 * The timetable, booking and check-in findings of the 2026-11-14 clubs audit,
 * each through the app's OWN functions (and the worker's own notice code)
 * against real Postgres:
 *
 *   B1  the bookers of a date an edited class no longer has are told;
 *   B8  the desk cancelling somebody's place tells them;
 *   B5  a second scan ticks the next booked class, not the one already ticked;
 *   B4  one arrival is one row and one visit — a walk-in tick and a roster
 *       tick for the same person, day and location do not spend two visits;
 *   D1  a door that opens «for every member» does not open for a record a
 *       stranger made for themselves and the club has never handled;
 *   B9  a trainer whose hours do not start on the location's grid can still
 *       be booked together with a room;
 *   B11 a trial class is for somebody who never held an abonnement;
 *   B12 a lapsed club's desk cancels no bookings; the member still may.
 *
 * COMMITS under its own `e2e-as-*` clubs and `e2e_club_as_*` accounts,
 * removed through the real purge path.
 */

// The office action under test (B8) renders nothing here: its page gate, the
// queue and Next's request scope are stand-ins; the statements are real.
const harness = vi.hoisted(() => ({
  actor: null as unknown,
  sent: [] as unknown[],
}));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));
vi.mock('next-intl/server', () => ({ getLocale: () => Promise.resolve('bg') }));
vi.mock('@/i18n/navigation', () => ({ redirect: () => undefined }));
vi.mock('@/lib/clubs/club-session', () => ({
  requireClubStaff: () => Promise.resolve({ actor: harness.actor }),
  actorCan: () => true,
}));
vi.mock('@/lib/clubs/notify', () => ({
  enqueueClubNotify: (job: unknown) => {
    harness.sent.push(job);
    return Promise.resolve();
  },
  enqueueClubMaterialize: () => Promise.resolve(),
}));

const PREFIX = 'e2e_club_as_';

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-as-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
}

interface CheckinRow {
  id: string;
  occurrence_id: string | null;
  method: string;
  consumed_membership_id: string | null;
  covered: boolean;
  training_log_id: string | null;
}

describe.skipIf(!hasDb)('club schedule audit journey (requires running database)', () => {
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

  const tag = () => Math.random().toString(36).slice(2, 8);

  async function account(label: string): Promise<string> {
    const id = `${PREFIX}${label}_${tag()}`;
    await db.execute(sql`
      INSERT INTO users (id, display_name, email, email_verified)
      VALUES (${id}, ${`Journey ${label}`}, ${`${id}@example.org`}, true)
    `);
    return id;
  }

  async function staff(role: 'owner' | 'desk' | 'trainer'): Promise<ClubActor> {
    const userId = await account(role);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${userId}, ${role})
    `);
    return { userId, clubId, role, ngoAdmin: false };
  }

  /** A record the DESK made, with an address the club may write to. */
  async function member(name: string): Promise<{ id: string; email: string }> {
    const email = `${PREFIX}m_${tag()}@example.org`;
    const created = await db.execute(sql`
      INSERT INTO club_members (club_id, display_name, email)
      VALUES (${clubId}::uuid, ${name}, ${email}) RETURNING id
    `);
    return { id: String(created.rows[0]?.id), email };
  }

  /** Link a record to a POPS account, as an accepted invitation leaves it. */
  async function link(memberId: string, userId: string, consent = false): Promise<void> {
    await db.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method, passport_consent_at)
      VALUES (${memberId}::uuid, ${clubId}::uuid, ${userId}, 'active', 'invite',
              CASE WHEN ${consent} THEN now() END)
    `);
  }

  async function plan(kind: 'unlimited' | 'visits', name: string): Promise<string> {
    const created = await db.execute(sql`
      INSERT INTO club_plans (club_id, name_bg, kind, price_cents, validity_months, visits_count)
      VALUES (${clubId}::uuid, ${name}, ${kind}, 5000, 1, ${kind === 'unlimited' ? null : 10})
      RETURNING id
    `);
    return String(created.rows[0]?.id);
  }

  /** A sale as the books hold it: the plan's snapshot, from today (Sofia) unless offset. */
  async function sell(
    memberId: string,
    planId: string,
    opts: { days?: number; startOffsetDays?: number; visits?: number } = {},
  ): Promise<string> {
    const created = await db.execute(sql`
      INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                    price_cents, visits_total, starts_on, ends_on)
      SELECT p.club_id, ${memberId}::uuid, p.id, p.name_bg, p.kind, p.audience, p.price_cents,
             CASE WHEN p.kind = 'unlimited' THEN NULL
                  ELSE coalesce(${opts.visits ?? null}::int, p.visits_count) END,
             (now() AT TIME ZONE 'Europe/Sofia')::date + ${opts.startOffsetDays ?? 0}::int,
             (now() AT TIME ZONE 'Europe/Sofia')::date + ${opts.startOffsetDays ?? 0}::int
               + ${opts.days ?? 30}::int - 1
        FROM club_plans p WHERE p.club_id = ${clubId}::uuid AND p.id = ${planId}::uuid
      RETURNING id
    `);
    return String(created.rows[0]?.id);
  }

  async function used(membershipId: string): Promise<number> {
    const row = await db.execute(sql`
      SELECT visits_used FROM club_membership_balances WHERE membership_id = ${membershipId}::uuid
    `);
    return Number(row.rows[0]?.visits_used);
  }

  /**
   * A one-off class starting `minutes` from now (the database's clock, so the
   * booking and check-in windows agree with it) and its occurrence, written
   * the way the materializer writes one.
   */
  async function classIn(
    minutes: number,
    opts: { title?: string; duration?: number; capacity?: number; planIds?: string[] } = {},
  ): Promise<{ classId: string; occurrenceId: string }> {
    const klass = await db.execute(sql`
      INSERT INTO club_classes (club_id, location_id, title, sport, instructor_user_id,
                                starts_at_local, duration_minutes, capacity, covers_all_plans)
      VALUES (${clubId}::uuid, ${locationId}::uuid, ${opts.title ?? 'Йога'}, 'yoga', ${trainer.userId},
              (date_trunc('minute', now()) + make_interval(mins => ${minutes}::int))
                AT TIME ZONE 'Europe/Sofia',
              ${opts.duration ?? 30}, ${opts.capacity ?? 10}, ${opts.planIds === undefined})
      RETURNING id
    `);
    const classId = String(klass.rows[0]?.id);
    for (const planId of opts.planIds ?? []) {
      await db.execute(sql`
        INSERT INTO club_class_plans (club_id, class_id, plan_id)
        VALUES (${clubId}::uuid, ${classId}::uuid, ${planId}::uuid)
      `);
    }
    const occurrence = await db.execute(sql`
      INSERT INTO club_class_occurrences (club_id, class_id, starts_at, ends_at, starts_at_local)
      SELECT c.club_id, c.id, c.starts_at_local AT TIME ZONE 'Europe/Sofia',
             (c.starts_at_local AT TIME ZONE 'Europe/Sofia')
               + make_interval(mins => c.duration_minutes),
             c.starts_at_local
        FROM club_classes c WHERE c.id = ${classId}::uuid
      RETURNING id
    `);
    return { classId, occurrenceId: String(occurrence.rows[0]?.id) };
  }

  async function door(rule: 'member' | 'covered'): Promise<string> {
    const created = await db.execute(sql`
      INSERT INTO club_kiosk_devices (club_id, location_id, name, kind, access_rule, secret_hash,
                                      paired_at, created_by)
      VALUES (${clubId}::uuid, ${locationId}::uuid, 'Вход', 'door', ${rule},
              ${sha256Hex(`door-${tag()}`)}, now(), ${owner.userId})
      RETURNING id
    `);
    return String(created.rows[0]?.id);
  }

  async function checkins(memberId: string): Promise<CheckinRow[]> {
    const rows = await db.execute(sql`
      SELECT id, occurrence_id, method, consumed_membership_id, covered, training_log_id
        FROM club_checkins WHERE member_id = ${memberId}::uuid ORDER BY checked_in_at, id
    `);
    return rows.rows as unknown as CheckinRow[];
  }

  const atDesk = (memberId: string, occurrenceId?: string) =>
    clubCheckIn(db, { method: 'desk', actor: desk, memberId, occurrenceId, locationId });

  beforeAll(async () => {
    db = getDb();
    await cleanup();
    slug = `e2e-as-${tag()}`;
    const club = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until, visible,
                         mail_unlinked_members)
      VALUES (${slug}, 'Клуб Одит', 'pro', 'active', now(), (now() + interval '1 year')::date, true,
              true)
      RETURNING id
    `);
    clubId = String(club.rows[0]?.id);
    owner = await staff('owner');
    desk = await staff('desk');
    trainer = await staff('trainer');
    const location = await db.execute(sql`
      INSERT INTO club_locations (club_id, name, address)
      VALUES (${clubId}::uuid, 'Зала', 'ул. Тестова 14') RETURNING id
    `);
    locationId = String(location.rows[0]?.id);
  });

  afterAll(async () => {
    await cleanup();
    await getPool().end();
  });

  beforeEach(() => {
    mailer.sent.length = 0;
    harness.sent.length = 0;
    harness.actor = desk;
  });

  // ── B1 ────────────────────────────────────────────────────────────────────

  it('B1: mails the booker of a date an edited class no longer has', async () => {
    const klass = await db.execute(sql`
      INSERT INTO club_classes (club_id, location_id, title, sport, starts_at_local, duration_minutes,
                                rrule)
      VALUES (${clubId}::uuid, ${locationId}::uuid, 'Сутрешна йога', 'yoga',
              ((now() AT TIME ZONE 'Europe/Sofia')::date + 2)::timestamp + interval '8 hours', 60,
              'FREQ=WEEKLY')
      RETURNING id
    `);
    const classId = String(klass.rows[0]?.id);
    await materializeClubClasses(getPool(), { classId, horizonWeeks: 3 });
    const first = await db.execute(sql`
      SELECT id FROM club_class_occurrences WHERE class_id = ${classId}::uuid
       ORDER BY starts_at LIMIT 1
    `);
    const occurrenceId = String(first.rows[0]?.id);
    const booker = await member('Мария Записана');
    expect(await bookAtDesk(db, desk, occurrenceId, booker.id)).toMatchObject({ ok: true });

    // The office moves the class half an hour; the worker's job reconciles.
    await db.execute(sql`
      UPDATE club_classes SET starts_at_local = starts_at_local + interval '30 minutes',
                              materialized_through = NULL
       WHERE id = ${classId}::uuid
    `);
    const report = await materializeClubClasses(getPool(), { classId, horizonWeeks: 3 });
    expect(report.cancelledOccurrenceIds).toEqual([occurrenceId]);

    // What the worker enqueues for them — the office's own cancellation job.
    const notice: ClubNotifyJob = {
      kind: 'class_cancelled',
      occurrenceIds: report.cancelledOccurrenceIds,
    };
    const run = await runClubNotify(notice, options);
    expect(run.report.sent).toBe(1);
    expect(mailer.sent.map((m) => m.to)).toEqual([booker.email]);
    expect(mailer.sent[0]?.subject).toContain('Сутрешна йога');
    // A second job for the same date mails nobody twice.
    mailer.sent.length = 0;
    await runClubNotify(notice, options);
    expect(mailer.sent).toEqual([]);
  });

  // ── B8 ────────────────────────────────────────────────────────────────────

  it('B8: tells a member the desk cancelled their place, and still tells who moved up', async () => {
    const { occurrenceId } = await classIn(2 * 24 * 60, { title: 'Кръгова', capacity: 1 });
    const seated = await member('Седнал');
    const waiting = await member('Чакащ');
    const a = await bookAtDesk(db, desk, occurrenceId, seated.id);
    const b = await bookAtDesk(db, desk, occurrenceId, waiting.id);
    if (!a.ok || !b.ok) throw new Error('booking refused');
    expect([a.status, b.status]).toEqual(['going', 'waitlisted']);

    const form = new FormData();
    form.set('slug', slug);
    form.set('occurrenceId', occurrenceId);
    form.set('op', 'cancelBooking');
    form.set('bookingId', a.bookingId);
    await rosterOpAction(form);

    expect(harness.sent).toContainEqual({ kind: 'booking_cancelled', bookingId: a.bookingId });
    expect(harness.sent).toContainEqual({ kind: 'booking_promoted', bookingIds: [b.bookingId] });
    // The notice is the one the worker already knows how to send.
    for (const job of harness.sent) await runClubNotify(job, options);
    const cancelledMail = mailer.sent.find((m) => m.to === seated.email);
    expect(cancelledMail?.subject).toContain('Отменено записване');
    expect(cancelledMail?.subject).toContain('Кръгова');
    expect(mailer.sent.some((m) => m.to === waiting.email)).toBe(true);

    // Nothing cancelled, nobody told: the same form posted again.
    harness.sent.length = 0;
    await rosterOpAction(form);
    expect(harness.sent).toEqual([]);
  });

  // ── B5 ────────────────────────────────────────────────────────────────────

  it('B5: a second scan ticks the next booked class, not the one already ticked', async () => {
    const first = await classIn(5, { title: 'Първа', duration: 30 });
    const second = await classIn(35, { title: 'Втора', duration: 30 });
    const m = await member('Две поред');
    expect(await bookAtDesk(db, desk, first.occurrenceId, m.id)).toMatchObject({ ok: true });
    expect(await bookAtDesk(db, desk, second.occurrenceId, m.id)).toMatchObject({ ok: true });
    const scan = () => clubCheckIn(db, { method: 'qr_member', actor: desk, memberId: m.id });

    expect(await scan()).toMatchObject({ status: 'recorded', classTitle: 'Първа' });
    expect(await scan()).toMatchObject({ status: 'recorded', classTitle: 'Втора' });
    // Both ticked: a third scan is the earlier class again, already there.
    expect(await scan()).toMatchObject({ status: 'already', classTitle: 'Първа' });
    expect((await checkins(m.id)).map((row) => row.occurrence_id)).toEqual([
      first.occurrenceId,
      second.occurrenceId,
    ]);
  });

  it('B5: a «covered» door lets somebody already in back through, and ticks nothing it would refuse', async () => {
    const strict = await door('covered');
    const first = await classIn(5, { title: 'Първа', duration: 30 });
    const second = await classIn(35, { title: 'Втора', duration: 30 });
    const m = await member('Последно посещение');
    const pack = await sell(m.id, await plan('visits', 'Карта'), { visits: 1 });
    await bookAtDesk(db, desk, first.occurrenceId, m.id);
    await bookAtDesk(db, desk, second.occurrenceId, m.id);
    const scan = () =>
      clubCheckIn(db, {
        method: 'door',
        clubId,
        deviceId: strict,
        credential: { kind: 'member', memberId: m.id },
      });

    expect(await scan()).toMatchObject({ status: 'recorded', covered: true, classTitle: 'Първа' });
    expect(await used(pack)).toBe(1);
    // The card is spent, so the second class is not covered — but the client
    // is inside for the first: the door opens and records nothing new.
    expect((await scan()).status).toBe('already');
    expect((await checkins(m.id)).map((row) => row.occurrence_id)).toEqual([first.occurrenceId]);
  });

  // ── B4 ────────────────────────────────────────────────────────────────────

  it('B4: a walk-in tick and a roster tick for one arrival are one row and one visit', async () => {
    const m = await member('Една визита');
    const pack = await sell(m.id, await plan('visits', 'Карта 10'));
    const walkIn = await atDesk(m.id);
    expect(walkIn).toMatchObject({ status: 'recorded', covered: true, classTitle: null });
    expect(walkIn.membership?.visitsRemaining).toBe(9);

    // Then they join a class, and its trainer ticks the roster.
    const { occurrenceId } = await classIn(5, { title: 'Пилатес' });
    expect(await bookAtDesk(db, desk, occurrenceId, m.id)).toMatchObject({ ok: true });
    const roster = await clubCheckIn(db, {
      method: 'desk',
      actor: trainer,
      memberId: m.id,
      occurrenceId,
    });
    expect(roster).toMatchObject({
      status: 'recorded',
      covered: true,
      classTitle: 'Пилатес',
      checkinId: walkIn.checkinId,
    });
    expect(roster.membership?.visitsRemaining).toBe(9);
    expect(await checkins(m.id)).toMatchObject([
      { id: walkIn.checkinId, occurrence_id: occurrenceId, consumed_membership_id: pack },
    ]);
    expect(await used(pack)).toBe(1);

    // The same ticks again change nothing.
    expect((await atDesk(m.id, occurrenceId)).status).toBe('already');
    expect((await atDesk(m.id)).status).toBe('already');
    expect(await checkins(m.id)).toHaveLength(1);
    expect(await used(pack)).toBe(1);
  });

  it('B4: the last visit of a card covers the class of the same arrival', async () => {
    const m = await member('Последна визита');
    const pack = await sell(m.id, await plan('visits', 'Карта'), { visits: 1 });
    expect(await atDesk(m.id)).toMatchObject({ status: 'recorded', covered: true });
    // The card is now spent — and it is the very visit this class belongs to.
    const { occurrenceId } = await classIn(5, { title: 'Пилатес' });
    const roster = await atDesk(m.id, occurrenceId);
    expect(roster).toMatchObject({ status: 'recorded', covered: true });
    expect(roster.membership).toMatchObject({ planName: 'Карта', visitsRemaining: 0 });
    expect(await checkins(m.id)).toMatchObject([
      { occurrence_id: occurrenceId, consumed_membership_id: pack, covered: true },
    ]);
    expect(await used(pack)).toBe(1);
  });

  it('B4: an open-gym tick after the class tick is the same arrival', async () => {
    const m = await member('Първо клас');
    const pack = await sell(m.id, await plan('visits', 'Карта 10'));
    const { occurrenceId } = await classIn(5, { title: 'Степ' });
    const klass = await atDesk(m.id, occurrenceId);
    expect(klass).toMatchObject({ status: 'recorded', covered: true });
    expect(await atDesk(m.id)).toMatchObject({ status: 'already', checkinId: klass.checkinId });
    expect(await checkins(m.id)).toHaveLength(1);
    expect(await used(pack)).toBe(1);
  });

  it('B4: the visit moves to the abonnement that covers the class', async () => {
    const general = await plan('visits', 'Зала');
    const yogaOnly = await plan('visits', 'Йога карта');
    const m = await member('Две карти');
    // The hall card ends sooner, so an open-gym visit counts against it.
    const hall = await sell(m.id, general, { days: 20 });
    const yoga = await sell(m.id, yogaOnly, { days: 30 });
    expect((await atDesk(m.id)).status).toBe('recorded');
    expect([await used(hall), await used(yoga)]).toEqual([1, 0]);

    const { occurrenceId } = await classIn(5, { title: 'Йога', planIds: [yogaOnly] });
    const roster = await atDesk(m.id, occurrenceId);
    expect(roster).toMatchObject({ status: 'recorded', covered: true });
    expect(roster.membership).toMatchObject({ planName: 'Йога карта', visitsRemaining: 9 });
    expect(await checkins(m.id)).toMatchObject([
      { occurrence_id: occurrenceId, consumed_membership_id: yoga, covered: true },
    ]);
    // One arrival, one visit — from the card the class accepts.
    expect([await used(hall), await used(yoga)]).toEqual([0, 1]);
  });

  it('B4: a class nothing covers stays uncovered, and the paid hall visit stays paid', async () => {
    const general = await plan('visits', 'Зала');
    const yogaOnly = await plan('visits', 'Йога карта');
    const m = await member('Само зала');
    const hall = await sell(m.id, general);
    expect((await atDesk(m.id)).status).toBe('recorded');
    const { occurrenceId } = await classIn(5, { title: 'Йога', planIds: [yogaOnly] });
    expect(await atDesk(m.id, occurrenceId)).toMatchObject({ status: 'recorded', covered: false });
    expect(await checkins(m.id)).toMatchObject([
      { occurrence_id: null, consumed_membership_id: hall, covered: true },
      { occurrence_id: occurrenceId, consumed_membership_id: null, covered: false },
    ]);
    expect(await used(hall)).toBe(1);
  });

  it('B4: a scan that joins a desk-ticked arrival to a class still reaches the passport, once', async () => {
    const userId = await account('passport');
    const m = await member('Със съгласие');
    await link(m.id, userId, true);
    const walkIn = await atDesk(m.id);
    expect(walkIn).toMatchObject({ status: 'recorded', passport: false });

    const { occurrenceId } = await classIn(5, { title: 'Йога' });
    await bookAtDesk(db, desk, occurrenceId, m.id);
    const scan = await clubCheckIn(db, { method: 'qr_member', actor: desk, memberId: m.id });
    expect(scan).toMatchObject({
      status: 'recorded',
      classTitle: 'Йога',
      passport: true,
      checkinId: walkIn.checkinId,
    });
    const rows = await checkins(m.id);
    expect(rows).toMatchObject([{ occurrence_id: occurrenceId, method: 'qr_member' }]);
    const logs = await db.execute(sql`
      SELECT id, external_id, evidence::text AS evidence FROM training_logs
       WHERE user_id = ${userId} AND source::text = 'club'
    `);
    expect(logs.rows).toEqual([
      { id: rows[0]?.training_log_id, external_id: walkIn.checkinId, evidence: 'qr_verified' },
    ]);
    // A second scan is the same visit, and the same one diary entry.
    expect(
      (await clubCheckIn(db, { method: 'qr_member', actor: desk, memberId: m.id })).status,
    ).toBe('already');

    // An arrival that was a scan already has its diary entry: joining a class
    // leaves that entry as the member has it, and writes no second one.
    const scannerUser = await account('scanner');
    const scanner = await member('Сканира два пъти');
    await link(scanner.id, scannerUser, true);
    const arrival = await clubCheckIn(db, {
      method: 'qr_member',
      actor: desk,
      memberId: scanner.id,
    });
    expect(arrival).toMatchObject({ status: 'recorded', classTitle: null, passport: true });
    const later = await classIn(5, { title: 'Пилатес' });
    await bookAtDesk(db, desk, later.occurrenceId, scanner.id);
    // The trainer ticks the roster: a desk tick, which never mints an entry.
    const ticked = await clubCheckIn(db, {
      method: 'desk',
      actor: trainer,
      memberId: scanner.id,
      occurrenceId: later.occurrenceId,
    });
    expect(ticked).toMatchObject({
      status: 'recorded',
      passport: false,
      checkinId: arrival.checkinId,
    });
    // Still the scan it was, with the entry it had.
    const kept = await checkins(scanner.id);
    expect(kept).toMatchObject([{ occurrence_id: later.occurrenceId, method: 'qr_member' }]);
    const diary = await db.execute(sql`
      SELECT id FROM training_logs WHERE user_id = ${scannerUser} AND source::text = 'club'
    `);
    expect(diary.rows).toEqual([{ id: kept[0]?.training_log_id }]);
  });

  it('B4: a late tick for yesterday’s class is not today’s arrival', async () => {
    const m = await member('Вчера и днес');
    const pack = await sell(m.id, await plan('visits', 'Карта 10'));
    const yesterday = await classIn(-24 * 60, { title: 'Вчерашна' });
    // The desk catches up on yesterday's roster, then the client walks in today.
    expect(await atDesk(m.id, yesterday.occurrenceId)).toMatchObject({ status: 'recorded' });
    expect(await atDesk(m.id)).toMatchObject({ status: 'recorded', classTitle: null });
    expect(await checkins(m.id)).toHaveLength(2);
    expect(await used(pack)).toBe(2);

    // And the other way round: today's walk-in is not swallowed by the catch-up.
    const other = await member('Днес и вчера');
    const card = await sell(other.id, await plan('visits', 'Карта 10'));
    const earlier = await classIn(-24 * 60, { title: 'Вчерашна' });
    expect((await atDesk(other.id)).status).toBe('recorded');
    expect(await atDesk(other.id, earlier.occurrenceId)).toMatchObject({ status: 'recorded' });
    expect((await checkins(other.id)).map((row) => row.occurrence_id)).toEqual([
      null,
      earlier.occurrenceId,
    ]);
    expect(await used(card)).toBe(2);
  });

  // ── D1 ────────────────────────────────────────────────────────────────────

  it('D1: a «member» door stays shut for a record a stranger made for themselves', async () => {
    const open = await door('member');
    const through = (memberId: string) =>
      clubCheckIn(db, {
        method: 'door',
        clubId,
        deviceId: open,
        credential: { kind: 'member', memberId },
      });

    // Anyone can sign up and get a record of their own (a trial, an inquiry).
    const stranger = await account('stranger');
    const self = await db.transaction((tx) => ensureSelfRecord(tx, stranger, clubId));
    if (!self.ok) throw new Error(self.error);
    expect(await through(self.memberId)).toMatchObject({ status: 'denied', denial: 'not_covered' });
    // A refused door records nothing.
    expect(await checkins(self.memberId)).toEqual([]);

    // A client the DESK keeps opens it with no abonnement at all — the rule's
    // point — and the visit is recorded as unpaid.
    const regular = await member('Редовен');
    expect(await through(regular.id)).toMatchObject({ status: 'recorded', covered: false });

    // Once the club has handled the record, the same person is a member:
    // somebody the desk let in today…
    expect((await atDesk(self.memberId)).status).toBe('recorded');
    expect((await through(self.memberId)).status).toBe('already');
    // …somebody the desk gave a card…
    const carded = await account('carded');
    const withCard = await db.transaction((tx) => ensureSelfRecord(tx, carded, clubId));
    if (!withCard.ok) throw new Error(withCard.error);
    expect((await through(withCard.memberId)).status).toBe('denied');
    const cardKey = await issueMemberCard(db, owner, withCard.memberId);
    if (!cardKey) throw new Error('card refused');
    expect(
      await clubCheckIn(db, {
        method: 'door',
        clubId,
        deviceId: open,
        credential: { kind: 'card', cardKey },
      }),
    ).toMatchObject({ status: 'recorded' });
    // …or somebody who bought an abonnement.
    const buyer = await account('buyer');
    const bought = await db.transaction((tx) => ensureSelfRecord(tx, buyer, clubId));
    if (!bought.ok) throw new Error(bought.error);
    await sell(bought.memberId, await plan('unlimited', 'Месечен'));
    expect(await through(bought.memberId)).toMatchObject({ status: 'recorded', covered: true });
  });

  // ── B9 ────────────────────────────────────────────────────────────────────

  it('B9: offers a trainer-and-room appointment when the trainer starts off the location’s grid', async () => {
    const day = addDaysIso(sofiaToday(), 3);
    const weekday = ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const court = (await saveResource(db, owner, null, {
      locationId,
      kind: 'court',
      name: 'Корт Одит',
      quantity: 1,
      sortOrder: 0,
    })) as string;
    expect(
      await saveLocationHours(db, owner, locationId, [
        { weekday, opens: '08:00', closes: '20:00' },
      ]),
    ).toBe(true);
    // The trainer starts a quarter past: none of their starts is on the
    // location's half-hour grid.
    expect(
      await saveStaffHours(db, owner, trainer.userId, locationId, [
        { weekday, opens: '08:15', closes: '12:15' },
      ]),
    ).toBe(true);
    const lesson = (await saveService(db, owner, null, {
      locationId,
      kind: 'appointment',
      nameBg: 'Урок на корта',
      nameEn: null,
      descriptionBg: null,
      descriptionEn: null,
      durationMin: 60,
      durationMax: 60,
      stepMinutes: 30,
      bufferMinutes: 0,
      priceUnit: 'booking',
      priceCents: 0,
      memberPriceCents: null,
      bookingWindowDays: 14,
      cancelDeadlineHours: 2,
      maxUpcomingPerMember: 4,
      payment: 'desk',
      audience: 'all',
      visibility: 'public',
      resourceIds: [court],
      staffUserIds: [trainer.userId],
    })) as string;
    const slots = () => availability(db, clubId, lesson, day, 60, { member: false, office: true });

    const free = await slots();
    expect(free.map((s) => s.local)).toEqual([
      '08:15',
      '08:45',
      '09:15',
      '09:45',
      '10:15',
      '10:45',
      '11:15',
    ]);
    expect(free.every((s) => s.resourceId === court && s.staffUserId === trainer.userId)).toBe(
      true,
    );

    // The court is taken 09:00–10:00 by somebody else: every start whose hour
    // touches that is gone, the rest stay.
    const renter = await member('Наемател');
    await db.execute(sql`
      INSERT INTO club_reservations (club_id, service_id, member_id, resource_id, starts_at, ends_at,
                                     price_cents, cancel_deadline_hours)
      VALUES (${clubId}::uuid, ${lesson}::uuid, ${renter.id}::uuid, ${court}::uuid,
              (${day}::date + interval '9 hours') AT TIME ZONE 'Europe/Sofia',
              (${day}::date + interval '10 hours') AT TIME ZONE 'Europe/Sofia', 0, 2)
    `);
    expect((await slots()).map((s) => s.local)).toEqual(['10:15', '10:45', '11:15']);

    // And the offered start books — trainer and court together.
    const pupil = await member('Ученик');
    const booked = await bookReservation(
      db,
      { kind: 'staff', actor: desk },
      { serviceId: lesson, date: day, local: '10:15', durationMinutes: 60, memberId: pupil.id },
    );
    expect(booked).toMatchObject({ ok: true, state: 'confirmed' });
    // 10:45 would overlap the lesson; 11:15 starts the minute it ends.
    expect((await slots()).map((s) => s.local)).toEqual(['11:15']);
  });

  // ── B11 ───────────────────────────────────────────────────────────────────

  it('B11: a trial class is not for somebody who has held an abonnement', async () => {
    const { occurrenceId } = await classIn(2 * 24 * 60, { title: 'Пробна' });
    const monthly = await plan('unlimited', 'Месечен');
    const trials = async (memberId: string) =>
      Number(
        (
          await db.execute(sql`
            SELECT count(*)::int AS n FROM club_bookings
             WHERE member_id = ${memberId}::uuid AND is_trial
          `)
        ).rows[0]?.n,
      );

    // A paying member posts the trial form by hand.
    const payer = await account('payer');
    const paying = await member('Плащащ');
    await link(paying.id, payer);
    await sell(paying.id, monthly);
    expect(await bookTrial(db, payer, clubId, occurrenceId)).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    expect(await trials(paying.id)).toBe(0);

    // So does one whose abonnement ran out last month.
    const former = await account('former');
    const lapsed = await member('Бивш');
    await link(lapsed.id, former);
    await sell(lapsed.id, monthly, { startOffsetDays: -60, days: 30 });
    expect(await bookTrial(db, former, clubId, occurrenceId)).toEqual({
      ok: false,
      error: 'not_allowed',
    });
    expect(await trials(lapsed.id)).toBe(0);

    // A newcomer books theirs, once.
    const newcomer = await account('newcomer');
    expect(await bookTrial(db, newcomer, clubId, occurrenceId)).toMatchObject({ ok: true });
    expect(await bookTrial(db, newcomer, clubId, occurrenceId)).toEqual({
      ok: false,
      error: 'already_trialed',
    });
  });

  // ── B12 ───────────────────────────────────────────────────────────────────

  it('B12: a lapsed club’s desk cancels no booking; the member still cancels their own', async () => {
    const { occurrenceId } = await classIn(2 * 24 * 60, { title: 'Преди изтичане' });
    const userId = await account('own');
    const m = await member('Сам отказва');
    await link(m.id, userId);
    const booking = await bookAtDesk(db, desk, occurrenceId, m.id);
    if (!booking.ok) throw new Error(booking.error);
    const state = async () =>
      String(
        (
          await db.execute(
            sql`SELECT state FROM club_bookings WHERE id = ${booking.bookingId}::uuid`,
          )
        ).rows[0]?.state,
      );

    await db.execute(sql`
      UPDATE clubs SET paid_until = current_date - 90, trial_ends_on = NULL
       WHERE id = ${clubId}::uuid
    `);
    try {
      expect(
        await cancelBooking(db, { kind: 'staff', actor: desk }, booking.bookingId),
      ).toMatchObject({ cancelled: false });
      expect(await state()).toBe('active');
      // Leaving is never held hostage to the club's own account.
      expect(
        await cancelBooking(db, { kind: 'member', userId, clubId }, booking.bookingId),
      ).toMatchObject({ cancelled: true });
      expect(await state()).toBe('cancelled');
    } finally {
      await db.execute(sql`
        UPDATE clubs SET paid_until = (now() + interval '1 year')::date WHERE id = ${clubId}::uuid
      `);
    }
  });
});
