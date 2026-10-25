import {
  calendarFeed,
  ensureCalendarToken,
  getDb,
  getPool,
  materializeClubClasses,
  sql,
} from '@sportkarta/db';
import { addDaysIso, isoWeekKey, isoWeekMonday, sofiaToday } from '@sportkarta/lib/clubs';
import { generateInviteToken, sha256Hex } from '@sportkarta/lib/clubs/secrets';
import { parseCsv } from '@sportkarta/lib/csv';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { deleteAccount } from '@/lib/account-deletion';
import { buildAccountExport } from '@/lib/account-export';
import { approveClub, setClubStatus } from '@/lib/clubs/admin';
import { applyForClub } from '@/lib/clubs/apply';
import { bookAtDesk, bookTrial, cancelBooking } from '@/lib/clubs/bookings';
import { clubCheckIn, todaysCheckins } from '@/lib/clubs/checkin';
import { CLUB_EXPORT_DATASETS, clubExportCsv } from '@/lib/clubs/export';
import {
  commitClubImport,
  guessClubMapping,
  parseClubCsv,
  previewClubImport,
  rowsFromClubCsv,
} from '@/lib/clubs/import';
import {
  memberPause,
  memberStopRenewal,
  ownContact,
  setContactPreferences,
} from '@/lib/clubs/self-service';
import {
  activeByMonth,
  atRiskMembers,
  churnByMonth,
  classFillRates,
  engagementBands,
  monthToDate,
  peakHours,
  retentionCohorts,
  revenueByMonth,
  revenueByPlan,
  staffPay,
  topClients,
} from '@/lib/clubs/reports';
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
import {
  checkoutForMember,
  connectAccount,
  fakeSettle,
  refundOnlinePayment,
  startChargeCheckout,
  startPlanCheckout,
  unappliedCheckouts,
} from '@/lib/clubs/payments';
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
import {
  acceptStaffInvite,
  addTimeOff,
  inviteStaff,
  removeTimeOff,
  setPayRate,
  upcomingTimeOff,
} from '@/lib/clubs/staff';
import { unsubscribe, unsubscribeTarget } from '@/lib/clubs/unsubscribe';

import { hasDb } from './db';

// lib/clubs/payments.ts is `server-only`, a marker Next resolves from its own
// bundle; plain Node has no such package. (Hoisted above the imports.)
vi.mock('server-only', () => ({}));

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

/** Plans and classes without the 0045 terms and policies. */
const NO_TERMS = {
  autoRenew: false,
  minTermMonths: null,
  noticeDays: 0,
  selfPauseAllowed: false,
  selfCancelAllowed: false,
} as const;
const NO_POLICY = {
  noShowFeeCents: null,
  lateCancelFeeCents: null,
  strikeLimit: null,
  strikeDays: null,
} as const;

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
  // Created in beforeAll, never at collection: vitest still runs a skipped
  // suite's body to list its tests, and getDb() throws without DATABASE_URL.
  let db: ReturnType<typeof getDb>;
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
    db = getDb();
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
        accent: 'coral',
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
      ...NO_TERMS,
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
        ...NO_TERMS,
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
      ...NO_POLICY,
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
    // The private calendar feed carries the child's seat and the parent's own
    // cancelled booking — the latter as a cancellation, so a client removes it.
    const feed = await calendarFeed(db, await ensureCalendarToken(db, memberUser));
    const here = feed?.clubBookings.filter((b) => b.occurrenceId === occurrenceId) ?? [];
    expect(here.map((b) => b.cancelled).sort()).toEqual([false, true]);
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
    // Every dataset exports, and every cell sits under its own header — the
    // email column holds the email, not a timestamp shifted into it.
    const members = parseCsv(csv.replace(/^\uFEFF/, ''));
    const col = (name: string) => members.headers.indexOf(name);
    const maria = members.rows.find((row) => row[col('name')] === 'Мария Журни');
    expect(maria?.[col('email')]).toBe(`${memberUser}@example.org`);
    expect(maria?.[col('is_minor')]).toBe('false');
    // No POPS account id leaves in an export (the fixture's address merely
    // contains it, so the check is per cell, not per substring).
    expect(members.rows.flat()).not.toContain(memberUser);
    for (const dataset of CLUB_EXPORT_DATASETS) {
      const parsed = parseCsv((await clubExportCsv(owner, dataset)).replace(/^\uFEFF/, ''));
      expect(parsed.headers.length, dataset).toBeGreaterThan(2);
    }
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

    // The advanced reports (0045) run against the same data: the month's
    // payment shows up by plan, month to date and among the top payers; the
    // check-in lands in the peak-hours grid; every member is in one band.
    const [peaks, cohorts, churn, byPlan, mtd, top, pay, bands] = await Promise.all([
      peakHours(owner),
      retentionCohorts(owner),
      churnByMonth(owner),
      revenueByPlan(owner),
      monthToDate(owner),
      topClients(owner),
      staffPay(owner, sofiaToday().slice(0, 7)),
      engagementBands(owner),
    ]);
    expect(peaks.reduce((sum, cell) => sum + cell.count, 0)).toBeGreaterThanOrEqual(1);
    expect(peaks.every((c) => c.weekday >= 1 && c.weekday <= 7 && c.hour >= 0 && c.hour < 24)).toBe(
      true,
    );
    expect(cohorts.every((c) => c.kept.length === 5)).toBe(true);
    expect(churn).toHaveLength(11);
    expect(byPlan.reduce((sum, line) => sum + line.cents, 0)).toBeGreaterThan(0);
    expect(mtd.revenue[0]).toBeGreaterThan(0);
    expect(top.bySpend.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(pay)).toBe(true);
    expect(bands.high + bands.medium + bands.low).toBeGreaterThanOrEqual(1);
    expect(await unsubscribeTarget(String(token), 'bg')).toMatchObject({ optedOut: false });
    expect(await unsubscribe(String(token))).toBe(true);
    expect(await unsubscribe(String(token))).toBe(true);
    expect(await unsubscribeTarget(String(token), 'bg')).toMatchObject({ optedOut: true });
    expect(await unsubscribe('0'.repeat(32))).toBe(false);
  });

  it('lets a member stop a renewal with notice, pause once, and set their own contact', async () => {
    const planId = await savePlan(db, owner, null, {
      nameBg: 'Месечен договор',
      nameEn: null,
      descriptionBg: null,
      descriptionEn: null,
      kind: 'unlimited',
      audience: 'all',
      priceCents: 4000,
      validityDays: null,
      validityMonths: 1,
      visitsCount: null,
      visibility: 'public',
      autoRenew: true,
      minTermMonths: null,
      noticeDays: 30,
      selfPauseAllowed: true,
      selfCancelAllowed: true,
    });
    const today = sofiaToday();
    const sale = await sellMembership(db, desk, {
      memberId,
      planId: planId ?? '',
      startsOn: today,
      payment: null,
      dueOn: today,
    });
    expect(sale).toMatchObject({ ok: true });
    const membershipId = sale.ok ? sale.membershipId : '';
    const sold = await db.execute(
      sql`SELECT renews, term_started_on::text AS term FROM club_memberships WHERE id = ${membershipId}::uuid`,
    );
    expect(sold.rows[0]).toEqual({ renews: true, term: today });

    // The provider is asked FIRST: when it refuses, nothing is recorded and
    // the member can simply try again; it is told the notice's last day.
    const asked: string[] = [];
    expect(
      await memberStopRenewal(
        db,
        memberUser,
        clubId,
        membershipId,
        today,
        async (_tail, endsOn) => {
          asked.push(endsOn);
          return false;
        },
      ),
    ).toEqual({ ok: false, error: 'provider_error' });
    expect(asked).toEqual([addDaysIso(today, 30)]);
    const unchanged = await db.execute(
      sql`SELECT renewal_ends_on FROM club_memberships WHERE id = ${membershipId}::uuid`,
    );
    expect(unchanged.rows[0]?.renewal_ends_on).toBeNull();

    // Stopping keeps the period sold and fixes the contract's last day.
    expect(await memberStopRenewal(db, memberUser, clubId, membershipId, today)).toEqual({
      ok: true,
      endsOn: addDaysIso(today, 30),
    });
    // A second notice changes nothing.
    expect(await memberStopRenewal(db, memberUser, clubId, membershipId, today)).toMatchObject({
      ok: false,
    });
    // A stranger cannot give notice on somebody else's membership.
    expect(
      await memberStopRenewal(db, `${PREFIX}nobody`, clubId, membershipId, today),
    ).toMatchObject({ ok: false });

    // One pause of their own; a second is the desk's to grant.
    const tomorrow = addDaysIso(today, 1);
    expect(
      await memberPause(
        db,
        memberUser,
        clubId,
        membershipId,
        { startsOn: tomorrow, days: 5 },
        today,
      ),
    ).toEqual({ ok: true });
    expect(
      await memberPause(
        db,
        memberUser,
        clubId,
        membershipId,
        { startsOn: addDaysIso(today, 20), days: 2 },
        today,
      ),
    ).toMatchObject({ ok: false });

    expect(
      await setContactPreferences(db, memberUser, clubId, memberId, {
        phone: '0888 123 456',
        marketingEmail: true,
        marketingSms: false,
      }),
    ).toBe(true);
    expect(await ownContact(db, memberUser, clubId)).toMatchObject({
      memberId,
      phone: '0888 123 456',
      marketingEmail: true,
      marketingSms: false,
    });
    const consented = await db.execute(
      sql`SELECT marketing_email_at IS NOT NULL AS email FROM club_members WHERE id = ${memberId}::uuid`,
    );
    expect(consented.rows[0]?.email).toBe(true);
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
    // A linked member WITHOUT passport consent (every trial lead) still checks
    // in at the kiosk — recorded, nothing written to the passport.
    expect(
      await clubCheckIn(db, { method: 'qr_kiosk', userId: visitor, clubId, locationId }),
    ).toMatchObject({ status: 'recorded', passport: false });
    const own = await portalView(visitor, slug, 'bg');
    expect(own?.link?.status).toBe('active');
    expect(own?.records).toHaveLength(1);
  });

  it('offers an email-matched record for claiming', async () => {
    const newcomer = await user('newcomer');
    const record = await createMember(db, desk, {
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

    // «Покани» is not a mailer: one invitation a day, none after an opt-out.
    if (!record.ok) throw new Error('record');
    expect((await inviteMemberToLink(db, desk, record.memberId)).ok).toBe(true);
    expect(await inviteMemberToLink(db, desk, record.memberId)).toEqual({
      ok: false,
      error: 'recently_invited',
    });
    await db.execute(sql`
      UPDATE club_member_invites
         SET created_at = created_at - interval '2 days', expires_at = expires_at - interval '2 days'
       WHERE member_id = ${record.memberId}::uuid`);
    await db.execute(
      sql`UPDATE club_members SET email_opt_out_at = now() WHERE id = ${record.memberId}::uuid`,
    );
    expect(await inviteMemberToLink(db, desk, record.memberId)).toEqual({
      ok: false,
      error: 'opted_out',
    });
  });

  it('imports a member list twice without doubling it, refuses leva, and measures retention per member', async () => {
    const today = sofiaToday();
    const dotted = (iso: string) => iso.split('-').reverse().join('.');
    const early = addDaysIso(today, -40);
    const csv = [
      'Име;Имейл;Дете;Имейл на родител;Абонамент;Начало;Край;Платено',
      `Гергана Импорт;gergana-imp@example.org;;;Месечен;${dotted(addDaysIso(today, -5))};;25 €`,
      'Малкия Импорт;;да;gergana-imp@example.org;;;;',
      'Лев Импорт;lev-imp@example.org;;;Месечен;;;50 лв.',
      'Без Контакт Импорт;;;;;;;',
      `Ретенция Импорт;ret-imp@example.org;;;Месечен;${dotted(early)};${dotted(addDaysIso(early, 29))};`,
    ].join('\n');
    const mapping = guessClubMapping(parseClubCsv(csv).headers);
    const rows = rowsFromClubCsv(csv, mapping);

    const preview = await previewClubImport(owner, rows);
    expect(preview.counts).toEqual({ new: 4, match: 0, conflict: 0, invalid: 1 });
    expect(preview.rows.find((r) => r.line === 4)).toEqual({
      line: 4,
      status: 'invalid',
      errors: ['currency_bgn'],
    });
    const first = await commitClubImport(db, owner, rows, new Set());
    expect(first).toEqual({
      ok: true,
      result: { created: 4, updated: 0, memberships: 2, skipped: 0, invalid: 1 },
    });
    const imported = await db.execute(sql`
      SELECT m.display_name, g.display_name AS guardian,
             (SELECT count(*)::int FROM club_memberships ms WHERE ms.member_id = m.id) AS sold,
             (SELECT count(*)::int FROM club_memberships ms
               WHERE ms.member_id = m.id AND ms.sold_by IS NOT NULL) AS attributed,
             (SELECT count(*)::int FROM club_charges ch WHERE ch.member_id = m.id) AS charges
        FROM club_members m
        LEFT JOIN club_members g ON g.id = m.guardian_member_id
       WHERE m.club_id = ${clubId}::uuid AND m.display_name LIKE '%Импорт'
       ORDER BY m.display_name`);
    expect(imported.rows).toEqual([
      { display_name: 'Без Контакт Импорт', guardian: null, sold: 0, attributed: 0, charges: 0 },
      { display_name: 'Гергана Импорт', guardian: null, sold: 1, attributed: 0, charges: 1 },
      {
        display_name: 'Малкия Импорт',
        guardian: 'Гергана Импорт',
        sold: 0,
        attributed: 0,
        charges: 0,
      },
      { display_name: 'Ретенция Импорт', guardian: null, sold: 1, attributed: 0, charges: 0 },
    ]);

    // The same file again: the adults match by e-mail, the child by name under
    // the guardian, the contact-less name waits for a human — and no second
    // abonnement is sold.
    const again = await previewClubImport(owner, rows);
    expect(again.counts).toEqual({ new: 0, match: 3, conflict: 1, invalid: 1 });
    expect(again.rows.find((r) => r.line === 5)).toMatchObject({
      status: 'conflict',
      reason: 'name_exists',
    });
    expect(await commitClubImport(db, owner, rows, new Set())).toEqual({
      ok: true,
      result: { created: 0, updated: 3, memberships: 0, skipped: 1, invalid: 1 },
    });
    // A desk has no data.import.
    expect(await commitClubImport(db, desk, rows, new Set())).toEqual({
      ok: false,
      error: 'not_allowed',
    });

    // Retention is measured a month after the member's OWN first day: the
    // 30-day abonnement has lapsed by then, whatever day of the month it began.
    const cohort = (await retentionCohorts(owner)).find((c) => c.month === early.slice(0, 7));
    expect(cohort?.size).toBe(1);
    expect(cohort?.kept[0]).toBe(0);
  });

  it('keeps pay and leave with those who may set them, and a started class uncancellable', async () => {
    const managerUser = await user('manager');
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${managerUser}, 'manager')`);
    const manager: ClubActor = { userId: managerUser, clubId, role: 'manager', ngoAdmin: false };
    const flat = { kind: 'flat', cents: 2000 } as const;
    // Nobody but an owner sets their own pay or an owner's.
    expect(await setPayRate(db, manager, managerUser, flat)).toBe(false);
    expect(await setPayRate(db, manager, owner.userId, flat)).toBe(false);
    expect(await setPayRate(db, desk, desk.userId, flat)).toBe(false);
    expect(await setPayRate(db, manager, desk.userId, flat)).toBe(true);
    expect(await setPayRate(db, owner, managerUser, flat)).toBe(true);

    // Leave: one's own, or anyone's with staff.manage.
    const today = sofiaToday();
    const leave = (userId: string) =>
      ({
        userId,
        startsOn: addDaysIso(today, 3),
        endsOn: addDaysIso(today, 4),
        reason: 'time_off',
      }) as const;
    expect(await addTimeOff(db, desk, leave(desk.userId))).toBe(true);
    expect(await addTimeOff(db, desk, leave(owner.userId))).toBe(false);
    expect(await addTimeOff(db, manager, leave(owner.userId))).toBe(true);
    const blocks = await upcomingTimeOff(owner);
    const ownersBlock = blocks.find((b) => b.userId === owner.userId);
    const desksBlock = blocks.find((b) => b.userId === desk.userId);
    expect(await removeTimeOff(db, desk, ownersBlock?.id ?? '')).toBe(false);
    expect(await removeTimeOff(db, owner, desksBlock?.id ?? '')).toBe(true);

    // Once a class has begun, a member's booking can no longer be cancelled
    // (it is attendance or a no-show now, not a late cancellation).
    const booked = await bookAtDesk(db, desk, occurrenceId, memberId);
    const bookingId = booked.ok ? booked.bookingId : '';
    expect(bookingId).not.toBe('');
    const original = await db.execute(sql`
      SELECT starts_at, ends_at, starts_at_local FROM club_class_occurrences
       WHERE id = ${occurrenceId}::uuid`);
    const was = original.rows[0] as { starts_at: Date; ends_at: Date; starts_at_local: string };
    await db.execute(sql`
      UPDATE club_class_occurrences
         SET starts_at = now() - interval '10 minutes',
             ends_at = now() - interval '10 minutes' + (ends_at - starts_at),
             starts_at_local = (now() - interval '10 minutes') AT TIME ZONE 'Europe/Sofia'
       WHERE id = ${occurrenceId}::uuid`);
    expect(
      await cancelBooking(db, { kind: 'member', userId: memberUser, clubId }, bookingId),
    ).toMatchObject({ cancelled: false });
    await db.execute(sql`
      UPDATE club_class_occurrences
         SET starts_at = ${was.starts_at}, ends_at = ${was.ends_at},
             starts_at_local = ${was.starts_at_local}::timestamp
       WHERE id = ${occurrenceId}::uuid`);
  });

  it('takes a payment online through the fake provider and refunds it from the office', async () => {
    vi.stubEnv('CLUB_PAYMENTS_ENABLED', 'true');
    vi.stubEnv('PAYMENT_PROVIDER', 'fake');
    try {
      const back = { base: 'http://localhost', locale: 'bg' as const };
      const charge = await db.execute(sql`
        INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on)
        VALUES (${clubId}::uuid, ${memberId}::uuid, 'other', 'Онлайн такса', 3000,
                current_date, current_date)
        RETURNING id`);
      const chargeId = String(charge.rows[0]?.id);
      // No connected account yet: nothing to pay through.
      expect(
        await startChargeCheckout(db, memberUser, { id: clubId, slug }, chargeId, back),
      ).toEqual({ ok: false, error: 'unavailable' });
      // Only settings.manage connects.
      const account = {
        provider: 'fake' as const,
        accountRef: 'acct_fake_journey01',
        chargesEnabled: true,
      };
      expect(await connectAccount(db, desk, account)).toBe(false);
      expect(await connectAccount(db, owner, account)).toBe(true);
      // A stranger cannot pay someone else's charge.
      const stranger = await user('payer');
      expect(await startChargeCheckout(db, stranger, { id: clubId, slug }, chargeId, back)).toEqual(
        {
          ok: false,
          error: 'not_allowed',
        },
      );

      const started = await startChargeCheckout(
        db,
        memberUser,
        { id: clubId, slug },
        chargeId,
        back,
      );
      if (!started.ok) throw new Error(started.error);
      expect(started.url).toBe(`/dev/plashtane/${started.checkoutId}`);
      // A second click replaces the first checkout instead of opening two.
      const again = await startChargeCheckout(db, memberUser, { id: clubId, slug }, chargeId, back);
      if (!again.ok) throw new Error(again.error);
      expect((await checkoutForMember(memberUser, clubId, started.checkoutId))?.status).toBe(
        'expired',
      );
      expect(await fakeSettle(again.checkoutId, 'paid')).toBe(true);
      expect((await checkoutForMember(memberUser, clubId, again.checkoutId))?.status).toBe('paid');
      expect(await checkoutForMember(stranger, clubId, again.checkoutId)).toBeNull();

      const paid = await db.execute(sql`
        SELECT id FROM club_payments
         WHERE charge_id = ${chargeId}::uuid AND method = 'card_online' AND kind = 'payment'`);
      const paymentId = Number(paid.rows[0]?.id);
      expect(await refundOnlinePayment(db, desk, paymentId, 1000)).toEqual({
        ok: false,
        error: 'not_allowed',
      });
      expect(await refundOnlinePayment(db, owner, paymentId, 4000)).toEqual({
        ok: false,
        error: 'amount_invalid',
      });
      expect(await refundOnlinePayment(db, owner, paymentId, 1000)).toEqual({ ok: true });
      // What is left to refund shrinks with each refund.
      expect(await refundOnlinePayment(db, owner, paymentId, 2500)).toEqual({
        ok: false,
        error: 'amount_invalid',
      });
      const books = await db.execute(sql`
        SELECT kind, amount_cents FROM club_payments
         WHERE charge_id = ${chargeId}::uuid ORDER BY id`);
      expect(books.rows).toEqual([
        { kind: 'payment', amount_cents: 3000 },
        { kind: 'refund', amount_cents: -1000 },
      ]);
      // A partial refund leaves the rest owed; refunding the rest voids the
      // charge, so the member is never asked to pay back their own refund.
      const balance = async () =>
        (
          await db.execute(sql`
            SELECT status, due_cents FROM club_charge_balances WHERE charge_id = ${chargeId}::uuid`)
        ).rows[0];
      expect(await balance()).toMatchObject({ status: 'partial', due_cents: 1000 });
      expect(await refundOnlinePayment(db, owner, paymentId, null)).toEqual({ ok: true });
      expect(await balance()).toEqual({ status: 'void', due_cents: 0 });
      expect(await unappliedCheckouts(owner)).toEqual([]);

      // Buying a plan online: every refusal is in the statement.
      const club = { id: clubId, slug };
      const plan = async (values: { visibility?: string; audience?: string; archived?: boolean }) =>
        String(
          (
            await db.execute(sql`
              INSERT INTO club_plans (club_id, name_bg, kind, audience, price_cents, validity_months,
                                      visibility, archived_at)
              VALUES (${clubId}::uuid, ${`План ${Math.random().toString(36).slice(2, 7)}`},
                      'unlimited', ${values.audience ?? 'all'}, 2500, 1,
                      ${values.visibility ?? 'public'},
                      ${values.archived ? sql`now()` : sql`NULL`})
              RETURNING id`)
          ).rows[0]?.id,
        );
      const buy = (
        userId: string,
        planId: string,
        extra: Partial<{ memberId: string; terms: boolean }> = {},
      ) =>
        startPlanCheckout(
          db,
          userId,
          club,
          {
            planId,
            memberId: extra.memberId ?? null,
            startsOn: null,
            termsAccepted: extra.terms ?? false,
          },
          back,
        );
      const open = await plan({});
      expect(await buy(stranger, open, { memberId })).toEqual({ ok: false, error: 'not_allowed' });
      expect(await buy(memberUser, '00000000-0000-4000-8000-000000000999', { memberId })).toEqual({
        ok: false,
        error: 'not_allowed',
      });
      expect(await buy(memberUser, await plan({ visibility: 'private' }), { memberId })).toEqual({
        ok: false,
        error: 'not_allowed',
      });
      expect(await buy(memberUser, await plan({ archived: true }), { memberId })).toEqual({
        ok: false,
        error: 'not_allowed',
      });
      expect(await buy(memberUser, await plan({ audience: 'minors' }), { memberId })).toEqual({
        ok: false,
        error: 'audience_mismatch',
      });
      // The club's terms are checked on the server, not by a form field.
      await db.execute(
        sql`UPDATE clubs SET terms_url = 'https://example.org/usloviya' WHERE id = ${clubId}::uuid`,
      );
      expect(await buy(memberUser, open, { memberId })).toEqual({
        ok: false,
        error: 'terms_required',
      });
      // A renewing abonnement already bills the next period: no second purchase.
      const renewing = await db.execute(sql`
        UPDATE club_memberships ms SET renews = true
          FROM club_membership_balances mb
         WHERE mb.membership_id = ms.id AND ms.member_id = ${memberId}::uuid
           AND mb.state IN ('active', 'upcoming') AND ms.renewal_ends_on IS NULL
           AND ms.kind <> 'trial'
           AND NOT EXISTS (SELECT 1 FROM club_memberships nx WHERE nx.renewal_of = ms.id)
        RETURNING ms.id`);
      expect(renewing.rows.length).toBeGreaterThan(0);
      expect(await buy(memberUser, open, { memberId, terms: true })).toEqual({
        ok: false,
        error: 'already_renewing',
      });
      await db.execute(sql`
        UPDATE club_memberships SET renews = false
         WHERE id = ANY(${sql.param(renewing.rows.map((r) => String(r.id)))}::uuid[])`);
      // The member cap refuses a new member — and the self record the
      // purchase would have created for them is rolled back with it.
      await db.execute(sql`
        UPDATE clubs SET member_cap = (SELECT count(DISTINCT member_id) FROM club_membership_balances
                                        WHERE club_id = ${clubId}::uuid
                                          AND state IN ('active', 'paused', 'upcoming'))
         WHERE id = ${clubId}::uuid`);
      expect(await buy(stranger, open, { terms: true })).toEqual({
        ok: false,
        error: 'member_cap',
      });
      const leftover = await db.execute(sql`
        SELECT count(*)::int AS n FROM club_member_links WHERE user_id = ${stranger}`);
      expect(leftover.rows[0]?.n).toBe(0);
      await db.execute(sql`UPDATE clubs SET member_cap = NULL WHERE id = ${clubId}::uuid`);

      const bought = await buy(memberUser, open, { memberId, terms: true });
      if (!bought.ok) throw new Error(bought.error);
      expect(await fakeSettle(bought.checkoutId, 'paid')).toBe(true);
      const sold = await db.execute(sql`
        SELECT renews, sold_by FROM club_memberships
         WHERE member_id = ${memberId}::uuid AND plan_id = ${open}::uuid`);
      // A one-off online purchase never renews by itself.
      expect(sold.rows).toEqual([{ renews: false, sold_by: null }]);
      await db.execute(sql`UPDATE clubs SET terms_url = NULL WHERE id = ${clubId}::uuid`);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('erases on both sides without losing the books, and stops when suspended', async () => {
    const countBooks = async () =>
      (
        await db.execute(
          sql`SELECT count(*)::int AS n FROM club_payments WHERE club_id = ${clubId}::uuid`,
        )
      ).rows[0]?.n;
    const booksBefore = await countBooks();
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
    // Erasing the child and the account deleted no payment row.
    expect(await countBooks()).toBe(booksBefore);
    expect(Number(booksBefore)).toBeGreaterThanOrEqual(3);

    const admin = await user('admin2', 'admin');
    expect(await setClubStatus(db, admin, clubId, 'suspended')).toBe(true);
    const closed = await clubCheckIn(db, { method: 'desk', actor: desk, memberId, locationId });
    expect(closed).toEqual({ status: 'club_closed' });
  });
});
