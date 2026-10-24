import { getDb, getPool, materializeClubClasses, sql } from '@sportkarta/db';
import { addDaysIso, isoWeekKey, isoWeekMonday, sofiaToday } from '@sportkarta/lib/clubs';
import { generateInviteToken, sha256Hex } from '@sportkarta/lib/clubs/secrets';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteAccount } from '@/lib/account-deletion';
import { buildAccountExport } from '@/lib/account-export';
import { approveClub, setClubStatus } from '@/lib/clubs/admin';
import { applyForClub } from '@/lib/clubs/apply';
import { bookAtDesk, bookTrial, cancelBooking } from '@/lib/clubs/bookings';
import { clubCheckIn, todaysCheckins } from '@/lib/clubs/checkin';
import { clubExportCsv } from '@/lib/clubs/export';
import { activeByMonth, atRiskMembers, classFillRates, revenueByMonth } from '@/lib/clubs/reports';
import {
  createKioskDevice,
  kioskFromCookie,
  kioskLocation,
  kioskTodayCount,
  pairKiosk,
} from '@/lib/clubs/kiosk';
import {
  acceptMemberInvite,
  claimableRecords,
  inviteMemberToLink,
  setLinkPreference,
} from '@/lib/clubs/links';
import {
  createMember,
  eraseMember,
  listMembers,
  memberCard,
  memberSummary,
} from '@/lib/clubs/members';
import {
  openCharges,
  paymentLedger,
  recordPayment,
  savePlan,
  sellMembership,
} from '@/lib/clubs/sales';
import { memberClubs, portalView } from '@/lib/clubs/portal';
import { publicClub, publicClubDirectory, publicOccurrence } from '@/lib/clubs/public';
import { occurrenceRoster, saveClass, weekOccurrences } from '@/lib/clubs/schedule';
import type { ClubActor } from '@/lib/clubs/scope';
import {
  clubLocations,
  saveLocation,
  setClubVisible,
  updateClubSettings,
} from '@/lib/clubs/settings';
import { acceptStaffInvite, inviteStaff } from '@/lib/clubs/staff';
import { unsubscribe, unsubscribeTarget } from '@/lib/clubs/unsubscribe';

import { hasDb } from './db';

/**
 * The «Клубове» add-on, end to end, through the app's OWN functions against
 * real PostGIS: apply → approve → configure → staff → plans → members → sale
 * and payments → timetable and materialization → bookings and the waitlist →
 * kiosk pairing → linking and consent → QR check-in writing the passport →
 * reports → club-side erasure → POPS-side erasure → suspension.
 *
 * Unlike the rolled-back journeys (./db.ts), this one COMMITS: most club
 * readers take the shared pool, which cannot see another connection's open
 * transaction. Every row it makes hangs off one `e2e-jr-*` club and
 * `e2e_club_jr_*` accounts, and afterAll removes them through the real purge
 * path — the only door the append-only ledgers leave open.
 */

const PREFIX = 'e2e_club_jr_';

async function user(label: string, role: 'user' | 'admin' = 'user'): Promise<string> {
  const id = `${PREFIX}${label}_${Math.random().toString(36).slice(2, 8)}`;
  await getDb().execute(sql`
    INSERT INTO users (id, display_name, email, email_verified, role)
    VALUES (${id}, ${`Journey ${label}`}, ${`${id}@example.org`}, true, ${role}::user_role)
  `);
  return id;
}

/** What the worker does when it mails an invite: mint a token, keep its hash. */
async function mintInvite(
  table: 'club_staff_invites' | 'club_member_invites',
  id: string,
): Promise<string> {
  const token = generateInviteToken();
  await getDb().execute(sql`
    UPDATE ${sql.raw(table)} SET token_hash = ${sha256Hex(token)} WHERE id = ${id}::uuid
  `);
  return token;
}

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-jr-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
}

describe.skipIf(!hasDb)('club journey (requires running database)', () => {
  const db = getDb();
  let clubId = '';
  let slug = '';
  let owner: ClubActor;
  let desk: ClubActor;
  let locationId = '';
  let memberId = '';
  let childId = '';
  let memberUser = '';
  let occurrenceId = '';

  beforeAll(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await getPool().end();
  });

  it('applies, and the operator approves with a trial', async () => {
    const ownerId = await user('owner');
    const applied = await applyForClub(db, ownerId, {
      nameBg: `E2E JR ${Math.random().toString(36).slice(2, 6)}`,
      kind: 'gym',
      tier: 'standard',
      municipalityId: null,
      sports: ['yoga'],
      websiteUrl: null,
      descriptionBg: null,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    clubId = applied.clubId;
    // Rename the slug into the cleanup namespace.
    slug = `e2e-jr-${applied.slug}`.slice(0, 60);
    await db.execute(sql`UPDATE clubs SET slug = ${slug} WHERE id = ${clubId}::uuid`);
    const again = await applyForClub(db, ownerId, {
      nameBg: 'Втори',
      kind: 'gym',
      tier: 'standard',
      municipalityId: null,
      sports: [],
      websiteUrl: null,
      descriptionBg: null,
    });
    expect(again).toEqual({ ok: false, error: 'already_pending' });

    const admin = await user('admin', 'admin');
    expect(await approveClub(db, admin, clubId)).toBe(true);
    expect(await approveClub(db, admin, clubId)).toBe(false);
    const club = await db.execute(
      sql`SELECT status, trial_ends_on IS NOT NULL AS trial FROM clubs WHERE id = ${clubId}::uuid`,
    );
    expect(club.rows[0]).toEqual({ status: 'active', trial: true });
    owner = { userId: ownerId, clubId, role: 'owner', ngoAdmin: false };
  });

  it('configures the club and a location', async () => {
    expect(
      await updateClubSettings(db, owner, {
        nameBg: 'Журни Фитнес',
        nameEn: 'Journey Fitness',
        kind: 'gym',
        descriptionBg: 'Описание',
        descriptionEn: null,
        sports: ['yoga', 'fitness'],
        municipalityId: null,
        websiteUrl: 'https://example.org/',
        publicEmail: 'club@example.org',
        publicPhone: '+359 2 000 000',
        legalName: null,
        eik: '123456789',
        locale: 'bg',
        bookingOpensHours: 168,
        cancelDeadlineHours: 2,
        mailUnlinkedMembers: false,
      }),
    ).toBe(true);
    locationId =
      (await saveLocation(db, owner, null, {
        name: 'Зала 1',
        facilityId: null,
        address: 'ул. Тест 1',
      })) ?? '';
    expect(locationId).not.toBe('');
    expect((await clubLocations(owner)).map((l) => l.name)).toEqual(['Зала 1']);
  });

  it('brings in staff by invite, for the invited verified address only', async () => {
    const deskUser = await user('desk');
    const invited = await inviteStaff(db, owner, {
      email: `${deskUser}@example.org`,
      role: 'desk',
    });
    expect(invited.ok).toBe(true);
    if (!invited.ok) return;
    const token = await mintInvite('club_staff_invites', invited.inviteId);
    const stranger = await user('stranger');
    expect(await acceptStaffInvite(db, stranger, token)).toEqual({
      ok: false,
      error: 'wrong_account',
    });
    expect(await acceptStaffInvite(db, deskUser, token)).toMatchObject({ ok: true });
    desk = { userId: deskUser, clubId, role: 'desk', ngoAdmin: false };
    // A desk cannot create owners.
    expect(await inviteStaff(db, desk, { email: 'x@example.org', role: 'owner' })).toEqual({
      ok: false,
      error: 'role_not_grantable',
    });
  });

  it('sells an abonnement with a partial payment and settles it', async () => {
    const planId = await savePlan(db, owner, null, {
      nameBg: 'Месечен',
      nameEn: null,
      descriptionBg: null,
      descriptionEn: null,
      kind: 'unlimited',
      audience: 'all',
      priceCents: 5000,
      validityDays: null,
      validityMonths: 1,
      visitsCount: null,
      visibility: 'public',
    });
    expect(planId).not.toBeNull();
    // A desk may not edit plans.
    expect(
      await savePlan(db, desk, planId, {
        nameBg: 'Хак',
        nameEn: null,
        descriptionBg: null,
        descriptionEn: null,
        kind: 'unlimited',
        audience: 'all',
        priceCents: 1,
        validityDays: null,
        validityMonths: 1,
        visitsCount: null,
        visibility: 'public',
      }),
    ).toBeNull();

    memberUser = await user('member');
    const created = await createMember(db, desk, {
      displayName: 'Мария Журни',
      email: `${memberUser}@example.org`,
      phone: null,
      isMinor: false,
      guardianMemberId: null,
      tags: ['Сутрин'],
      staffNote: null,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    memberId = created.memberId;
    const child = await createMember(db, desk, {
      displayName: 'Дете Журни',
      email: null,
      phone: null,
      isMinor: true,
      guardianMemberId: memberId,
      tags: [],
      staffNote: null,
    });
    if (!child.ok) throw new Error('child');
    childId = child.memberId;

    const today = sofiaToday();
    const sale = await sellMembership(db, desk, {
      memberId,
      planId: planId ?? '',
      startsOn: today,
      dueOn: addDaysIso(today, 7),
      payment: { method: 'cash', amountCents: 3000, receivedOn: today },
    });
    expect(sale.ok).toBe(true);
    if (!sale.ok || !sale.chargeId) return;
    const owed = await openCharges(desk, { memberId });
    expect(owed.map((c) => [c.status, c.dueCents])).toEqual([['partial', 2000]]);
    expect(
      await recordPayment(db, desk, {
        chargeId: sale.chargeId,
        kind: 'payment',
        method: 'card_desk',
        amountCents: 2500,
        receivedOn: today,
      }),
    ).toEqual({ ok: false, error: 'amount_exceeds_due' });
    expect(
      await recordPayment(db, desk, {
        chargeId: sale.chargeId,
        kind: 'payment',
        method: 'card_desk',
        amountCents: 2000,
        receivedOn: today,
      }),
    ).toEqual({ ok: true });
    expect(await openCharges(desk, { memberId })).toEqual([]);

    const list = await listMembers(desk, { filter: 'with_membership' });
    expect(list.rows.map((r) => r.displayName)).toEqual(['Мария Журни']);
    expect(list.rows[0]?.status).toBe('active');
    const card = await memberCard(desk, memberId);
    expect(card?.children.map((c) => c.displayName)).toEqual(['Дете Журни']);
    expect(card?.memberships[0]?.state).toBe('active');
    expect(card?.payments.length).toBe(2);
    const ledger = await paymentLedger(owner, today.slice(0, 7), null);
    expect(ledger.totalCents).toBe(5000);
    expect(ledger.byMethod).toEqual({ cash: 3000, card_desk: 2000 });
  });

  it('schedules a weekly class, materializes it and runs the waitlist', async () => {
    const tomorrow = addDaysIso(sofiaToday(), 1);
    const weekday = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][
      (new Date(`${tomorrow}T12:00:00Z`).getUTCDay() + 6) % 7
    ] as string;
    const classId = await saveClass(db, owner, null, {
      title: 'Йога сутрин',
      description: null,
      sport: 'yoga',
      locationId,
      instructorUserId: null,
      startsAtLocal: `${tomorrow} 08:00:00`,
      rrule: `FREQ=WEEKLY;BYDAY=${weekday}`,
      durationMinutes: 60,
      capacity: 1,
      bookingOpensHours: 168,
      cancelDeadlineHours: 2,
      dropInPriceCents: null,
      coversAllPlans: true,
      planIds: [],
      trialAllowed: true,
      public: true,
    });
    expect(classId).not.toBeNull();
    const report = await materializeClubClasses(getPool(), { classId: classId ?? '' });
    expect(report.failures).toEqual([]);
    expect(report.occurrencesCreated).toBeGreaterThanOrEqual(7);
    const monday = isoWeekMonday(isoWeekKey(tomorrow)) ?? tomorrow;
    const week = await weekOccurrences(desk, monday, null);
    const first = week.find((o) => o.localStart === `${tomorrow} 08:00`);
    expect(first).toBeDefined();
    occurrenceId = first?.id ?? '';

    const a = await bookAtDesk(db, desk, occurrenceId, memberId);
    const b = await bookAtDesk(db, desk, occurrenceId, childId);
    expect(a).toMatchObject({ ok: true, status: 'going' });
    expect(b).toMatchObject({ ok: true, status: 'waitlisted' });
    if (!a.ok || !b.ok) return;
    const cancelled = await cancelBooking(db, { kind: 'staff', actor: desk }, a.bookingId);
    expect(cancelled).toEqual({ cancelled: true, late: false, promoted: [b.bookingId] });

    const roster = await occurrenceRoster(desk, occurrenceId, true);
    expect(roster?.people.map((p) => [p.displayName, p.kind, p.isMinor])).toEqual([
      ['Дете Журни', 'going', true],
    ]);
    // Tomorrow's class cannot be ticked today: that would spend a visit early.
    expect(
      await clubCheckIn(db, { method: 'desk', actor: desk, memberId: childId, occurrenceId }),
    ).toEqual({ status: 'too_early' });
    // A trainer who does not teach this class sees no roster at all.
    const trainerId = await user('trainer');
    await db.execute(
      sql`INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${trainerId}, 'trainer')`,
    );
    expect(
      await occurrenceRoster(
        { userId: trainerId, clubId, role: 'trainer', ngoAdmin: false },
        occurrenceId,
        false,
      ),
    ).toBeNull();
  });

  it('pairs a kiosk, links the member, and a QR scan writes their passport', async () => {
    const device = await createKioskDevice(db, owner, locationId, 'Рецепция');
    expect(device).not.toBeNull();
    if (!device) return;
    expect(await pairKiosk(db, slug, '000000' === device.code ? '000001' : '000000')).toBeNull();
    const paired = await pairKiosk(db, slug, device.code);
    expect(paired).not.toBeNull();
    expect(await pairKiosk(db, slug, device.code)).toBeNull();
    const session = await kioskFromCookie(slug, paired?.cookie);
    expect(session).toMatchObject({ clubId, locationId, live: true });
    expect(await kioskFromCookie(slug, `${device.deviceId}~${'x'.repeat(43)}`)).toBeNull();

    // Not linked yet: the kiosk cannot know who this is.
    expect(
      await clubCheckIn(db, { method: 'qr_kiosk', userId: memberUser, clubId, locationId }),
    ).toEqual({
      status: 'not_linked',
    });
    const invite = await inviteMemberToLink(db, desk, memberId);
    expect(invite.ok).toBe(true);
    if (!invite.ok) return;
    const token = await mintInvite('club_member_invites', invite.inviteId);
    expect(await acceptMemberInvite(db, memberUser, token)).toMatchObject({ ok: true });
    expect(await setLinkPreference(memberUser, memberId, 'passport', true)).toBe(true);

    const scan = await clubCheckIn(db, {
      method: 'qr_kiosk',
      userId: memberUser,
      clubId,
      locationId,
    });
    expect(scan).toMatchObject({ status: 'recorded', covered: true, passport: true });
    const log = await db.execute(sql`
      SELECT sport, evidence::text AS evidence FROM training_logs
       WHERE user_id = ${memberUser} AND source::text = 'club'`);
    expect(log.rows).toEqual([{ sport: 'fitness', evidence: 'qr_verified' }]);
    const twice = await clubCheckIn(db, {
      method: 'qr_kiosk',
      userId: memberUser,
      clubId,
      locationId,
    });
    expect(twice.status).toBe('already');

    // The uncovered child is recorded, never refused — and a desk tick never
    // reaches anybody's passport.
    const childVisit = await clubCheckIn(db, {
      method: 'desk',
      actor: desk,
      memberId: childId,
      locationId,
    });
    expect(childVisit).toMatchObject({ status: 'recorded', covered: false, passport: false });

    // The desk's list and the tablet's counter see the same two arrivals; the
    // tablet gets a number, never a name.
    const today = await todaysCheckins(desk);
    expect(today.map((row) => [row.displayName, row.method, row.covered]).sort()).toEqual(
      [
        ['Дете Журни', 'desk', false],
        ['Мария Журни', 'qr_kiosk', true],
      ].sort(),
    );
    if (session) expect(await kioskTodayCount(session)).toBe(2);
    expect(await kioskLocation(locationId, 'bg')).toMatchObject({ clubId, clubSlug: slug });
    expect(await memberSummary(desk, childId)).toMatchObject({ isMinor: true });
  });

  it('shows a linked member their own records and nobody else, and opts out in one click', async () => {
    const view = await portalView(memberUser, slug, 'bg');
    expect(view?.link?.status).toBe('active');
    expect(view?.records.map((r) => [r.displayName, r.self, r.isMinor])).toEqual([
      ['Мария Журни', true, false],
      ['Дете Журни', false, true],
    ]);
    expect(await memberClubs(memberUser, 'bg')).toMatchObject([
      { clubSlug: slug, status: 'active' },
    ]);
    // The member's own GDPR export carries the link and the visits it covers.
    const mine = await buildAccountExport(db, memberUser);
    expect(mine?.clubs.links).toMatchObject([{ clubSlug: slug, status: 'active' }]);
    expect(mine?.clubs.visits.length).toBeGreaterThanOrEqual(1);
    // Somebody without a record sees the club, and no record at all.
    const stranger = await user('stranger');
    const other = await portalView(stranger, slug, 'bg');
    expect(other?.link).toBeNull();
    expect(other?.records).toEqual([]);

    const token = (
      await db.execute(sql`SELECT unsubscribe_token FROM club_members WHERE id = ${childId}::uuid`)
    ).rows[0]?.unsubscribe_token;

    // The club takes its data as CSV — never a token, and the download is logged.
    const csv = await clubExportCsv(owner, 'members');
    expect(csv.split('\r\n')[0]).toContain('name,email,phone');
    expect(csv).toContain('Мария Журни');
    expect(csv).not.toContain(String(token));
    expect(csv).not.toContain(memberUser);
    const exported = await db.execute(
      sql`SELECT count(*)::int AS n FROM club_audit WHERE club_id = ${clubId}::uuid AND action = 'export_downloaded'`,
    );
    expect(exported.rows[0]?.n).toBeGreaterThanOrEqual(1);

    // The reports run and agree with what happened: one month in a row of twelve
    // has the active member, and the month's payments are counted.
    const [active, revenue, , fill] = await Promise.all([
      activeByMonth(owner),
      revenueByMonth(owner),
      atRiskMembers(owner),
      classFillRates(owner),
    ]);
    expect(active).toHaveLength(12);
    expect(active.at(-1)?.value).toBeGreaterThanOrEqual(1);
    expect(revenue.at(-1)?.value).toBeGreaterThan(0);
    expect(Array.isArray(fill)).toBe(true);
    expect(await unsubscribeTarget(String(token), 'bg')).toMatchObject({ optedOut: false });
    expect(await unsubscribe(String(token))).toBe(true);
    expect(await unsubscribe(String(token))).toBe(true);
    expect(await unsubscribeTarget(String(token), 'bg')).toMatchObject({ optedOut: true });
    expect(await unsubscribe('0'.repeat(32))).toBe(false);
  });

  it('shows only a published club in public, and books a stranger’s trial once', async () => {
    expect((await publicClubDirectory('bg')).map((c) => c.slug)).not.toContain(slug);
    expect(await publicClub(slug, 'bg')).toBeNull();
    expect(await setClubVisible(db, owner, true)).toBe(true);
    expect((await publicClubDirectory('bg')).map((c) => c.slug)).toContain(slug);
    const page = await publicClub(slug, 'bg');
    expect(page?.classes.map((c) => c.occurrenceId)).toContain(occurrenceId);
    expect(page?.plans.length).toBeGreaterThanOrEqual(1);
    expect(await publicOccurrence(slug, occurrenceId, 'bg')).toMatchObject({
      title: 'Йога сутрин',
      trialAllowed: true,
      cancelled: false,
    });

    const visitor = await user('visitor');
    const first = await bookTrial(db, visitor, clubId, occurrenceId);
    expect(first.ok).toBe(true);
    expect(await bookTrial(db, visitor, clubId, occurrenceId)).toEqual({
      ok: false,
      error: 'already_trialed',
    });
    const own = await portalView(visitor, slug, 'bg');
    expect(own?.link?.status).toBe('active');
    expect(own?.records).toHaveLength(1);
  });

  it('offers an email-matched record for claiming', async () => {
    const newcomer = await user('newcomer');
    await createMember(db, desk, {
      displayName: 'Нов Член',
      email: `${newcomer}@example.org`,
      phone: null,
      isMinor: false,
      guardianMemberId: null,
      tags: [],
      staffNote: null,
    });
    const claimable = await claimableRecords(newcomer);
    expect(claimable.map((r) => r.memberName)).toEqual(['Нов Член']);
  });

  it('erases on both sides without losing the books, and stops when suspended', async () => {
    expect(await eraseMember(db, desk, childId)).toBe(false);
    expect(await eraseMember(db, owner, childId)).toBe(true);
    const visits = await db.execute(
      sql`SELECT count(*)::int AS n FROM club_checkins WHERE member_id = ${childId}::uuid`,
    );
    expect(visits.rows[0]?.n).toBe(0);

    const summary = await deleteAccount(db, memberUser);
    expect(summary.clubMemberLinksErased).toBe(1);
    const record = await db.execute(
      sql`SELECT count(*)::int AS n FROM club_members WHERE id = ${memberId}::uuid`,
    );
    expect(record.rows[0]?.n).toBe(1);
    const books = await db.execute(
      sql`SELECT count(*)::int AS n FROM club_payments WHERE club_id = ${clubId}::uuid`,
    );
    expect(books.rows[0]?.n).toBe(2);

    const admin = await user('admin2', 'admin');
    expect(await setClubStatus(db, admin, clubId, 'suspended')).toBe(true);
    const closed = await clubCheckIn(db, { method: 'desk', actor: desk, memberId, locationId });
    expect(closed).toEqual({ status: 'club_closed' });
  });
});
