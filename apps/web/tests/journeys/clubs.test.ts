import {
  applyCheckoutPaid,
  calendarFeed,
  ensureCalendarToken,
  expireReservationHolds,
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
  previewMembershipSale,
  recordPayment,
  refundPaid,
  savePlan,
  sellMembership,
  voidCharge,
} from '@/lib/clubs/sales';
import {
  checkoutForMember,
  connectAccount,
  fakeSettle,
  refundOnlinePayment,
  startChargeCheckout,
  startPlanCheckout,
  startWalletCheckout,
  unappliedCheckouts,
} from '@/lib/clubs/payments';
import { parseInvoiceBuyer } from '@/lib/clubs/input';
import {
  clubInvoices,
  invoiceById,
  invoicesOwingCredit,
  issueCreditNote,
  issueInvoice,
} from '@/lib/clubs/invoices';
import { memberWallet, payOutWallet, topUpWallet } from '@/lib/clubs/wallet';
import { memberClubs, portalView } from '@/lib/clubs/portal';
import {
  availability,
  bookReservation,
  cancelReservation,
  dayCalendar,
  memberReservations,
  refundsDue,
} from '@/lib/clubs/reservations';
import {
  addResourceBlock,
  saveLocationHours,
  saveResource,
  setResourceArchived,
} from '@/lib/clubs/resources';
import { addPriceRule, saveService, saveStaffHours } from '@/lib/clubs/services';
import { savePromotion, setPromotionArchived } from '@/lib/clubs/promotions';
import {
  clubProducts,
  previewTillSale,
  recordStock,
  recordTillSale,
  reverseSale,
  saleById,
  saveProduct,
  setProductArchived,
} from '@/lib/clubs/shop';
import { publicClub, publicClubDirectory, publicOccurrence } from '@/lib/clubs/public';
import { ClassRoomTaken, occurrenceRoster, saveClass, weekOccurrences } from '@/lib/clubs/schedule';
import type { ClubActor } from '@/lib/clubs/scope';
import {
  clubLocations,
  saveInvoiceDetails,
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
      resourceId: null,
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
    expect(await addTimeOff(db, desk, leave(desk.userId))).toBe('ok');
    expect(await addTimeOff(db, desk, leave(owner.userId))).toBe('not_allowed');
    expect(await addTimeOff(db, manager, leave(owner.userId))).toBe('ok');
    // Overlapping leave is refused as such (0048), never a server error.
    expect(await addTimeOff(db, manager, leave(owner.userId))).toBe('overlaps');
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
                ${sofiaToday()}::date, ${sofiaToday()}::date)
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

  it('books a court at the desk and online, never twice, and lets a class not take it', async () => {
    vi.stubEnv('CLUB_PAYMENTS_ENABLED', 'true');
    vi.stubEnv('PAYMENT_PROVIDER', 'fake');
    try {
      const day = addDaysIso(sofiaToday(), 3);
      const weekday = ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      const court = await saveResource(db, owner, null, {
        locationId,
        kind: 'court',
        name: 'Корт Журни',
        quantity: 1,
        sortOrder: 0,
      });
      expect(court).not.toBeNull();
      // A desk may not add facilities.
      expect(
        await saveResource(db, desk, null, {
          locationId,
          kind: 'court',
          name: 'Х',
          quantity: 1,
          sortOrder: 0,
        }),
      ).toBeNull();
      expect(
        await saveLocationHours(db, owner, locationId, [
          { weekday, opens: '08:00', closes: '22:00' },
        ]),
      ).toBe(true);
      const service = await saveService(db, owner, null, {
        locationId,
        kind: 'rental',
        nameBg: 'Наем на корт',
        nameEn: null,
        descriptionBg: null,
        descriptionEn: null,
        durationMin: 60,
        durationMax: 120,
        stepMinutes: 30,
        bufferMinutes: 0,
        priceUnit: 'hour',
        priceCents: 2000,
        memberPriceCents: 1500,
        bookingWindowDays: 14,
        cancelDeadlineHours: 24,
        maxUpcomingPerMember: 4,
        payment: 'desk',
        audience: 'all',
        visibility: 'public',
        resourceIds: [court ?? ''],
        staffUserIds: [],
      });
      const serviceId = service ?? '';
      expect(
        await addPriceRule(db, owner, serviceId, {
          weekdays: [weekday],
          from: '18:00',
          to: '22:00',
          priceCents: 3000,
          memberPriceCents: null,
          priority: 1,
        }),
      ).toBe(true);
      const slots = await availability(db, clubId, serviceId, day, 60, {
        member: false,
        office: true,
      });
      expect(slots.find((s) => s.local === '10:00')?.priceCents).toBe(2000);
      expect(slots.find((s) => s.local === '18:00')?.priceCents).toBe(3000);

      // The desk books 10:00; the slot is then gone, for everyone.
      const request = { serviceId, date: day, local: '10:00', durationMinutes: 60, memberId };
      const booked = await bookReservation(db, { kind: 'staff', actor: desk }, request);
      if (!booked.ok) throw new Error(booked.error);
      expect(await bookReservation(db, { kind: 'staff', actor: desk }, request)).toEqual({
        ok: false,
        error: 'slot_taken',
      });
      const after = await availability(db, clubId, serviceId, day, 60, {
        member: false,
        office: true,
      });
      expect(after.some((s) => s.local === '10:00' || s.local === '09:30')).toBe(false);

      // The member books for themselves at the member price, and sees it.
      const own = await bookReservation(
        db,
        { kind: 'member', userId: memberUser, clubId },
        { ...request, local: '12:00', memberId: null },
      );
      if (!own.ok) throw new Error(own.error);
      const mine = await memberReservations(memberUser, clubId, 'bg');
      expect(mine.find((r) => r.id === own.reservationId)?.priceCents).toBe(1500);
      // Someone else cannot cancel it; the member can, in time — the charge goes.
      const stranger = await user('booker');
      expect(
        await cancelReservation(
          db,
          { kind: 'member', userId: stranger, clubId },
          own.reservationId,
        ),
      ).toEqual({ ok: false });
      expect(
        await cancelReservation(
          db,
          { kind: 'member', userId: memberUser, clubId },
          own.reservationId,
        ),
      ).toEqual({ ok: true, late: false, refundDue: false });
      const voided = await db.execute(
        sql`SELECT voided_at IS NOT NULL AS gone FROM club_charges WHERE id = ${own.chargeId}::uuid`,
      );
      expect(voided.rows[0]?.gone).toBe(true);

      // A class cannot be put in the court where a booking already stands.
      await expect(
        saveClass(db, owner, null, {
          title: 'Тенис група',
          description: null,
          sport: 'tennis',
          locationId,
          instructorUserId: null,
          resourceId: court,
          startsAtLocal: `${day} 10:00:00`,
          rrule: null,
          durationMinutes: 60,
          capacity: 4,
          bookingOpensHours: 168,
          cancelDeadlineHours: 2,
          dropInPriceCents: null,
          coversAllPlans: true,
          planIds: [],
          trialAllowed: false,
          public: true,
          noShowFeeCents: null,
          lateCancelFeeCents: null,
          strikeLimit: null,
          strikeDays: null,
        }),
      ).rejects.toBeInstanceOf(ClassRoomTaken);

      // Online payment required: the slot is HELD until the money arrives.
      await db.execute(
        sql`UPDATE club_services SET payment = 'online_required' WHERE id = ${serviceId}::uuid`,
      );
      const held = await bookReservation(
        db,
        { kind: 'member', userId: memberUser, clubId },
        { ...request, local: '15:00', memberId },
      );
      if (!held.ok) throw new Error(held.error);
      expect(held.state).toBe('held');
      const checkout = await startChargeCheckout(
        db,
        memberUser,
        { id: clubId, slug },
        held.chargeId ?? '',
        { base: 'http://localhost', locale: 'bg' },
      );
      if (!checkout.ok) throw new Error(checkout.error);
      expect(await fakeSettle(checkout.checkoutId, 'paid')).toBe(true);
      const confirmed = await db.execute(
        sql`SELECT state FROM club_reservations WHERE id = ${held.reservationId}::uuid`,
      );
      expect(confirmed.rows[0]?.state).toBe('confirmed');

      // Late: inside the cancel deadline the charge stays.
      await db.execute(
        sql`UPDATE club_services SET cancel_deadline_hours = 168, payment = 'desk' WHERE id = ${serviceId}::uuid`,
      );
      const late = await bookReservation(
        db,
        { kind: 'member', userId: memberUser, clubId },
        { ...request, local: '16:00', memberId },
      );
      if (!late.ok) throw new Error(late.error);
      expect(
        await cancelReservation(
          db,
          { kind: 'member', userId: memberUser, clubId },
          late.reservationId,
        ),
      ).toEqual({ ok: true, late: true, refundDue: false });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps bookings in scope, caps them, and never sells a held slot twice', async () => {
    vi.stubEnv('CLUB_PAYMENTS_ENABLED', 'true');
    vi.stubEnv('PAYMENT_PROVIDER', 'fake');
    try {
      const day = addDaysIso(sofiaToday(), 5);
      const weekday = ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
      const back = { base: 'http://localhost', locale: 'bg' } as const;
      const asMember = { kind: 'member', userId: memberUser, clubId } as const;
      const atDesk = { kind: 'staff', actor: desk } as const;
      const state = async (id: string) =>
        (await db.execute(sql`SELECT state FROM club_reservations WHERE id = ${id}::uuid`)).rows[0]
          ?.state;
      const voided = async (chargeId: string | null) =>
        (
          await db.execute(
            sql`SELECT voided_at IS NOT NULL AS v FROM club_charges WHERE id = ${chargeId ?? ''}::uuid`,
          )
        ).rows[0]?.v;
      const lapse = (id: string) =>
        db.execute(sql`
          UPDATE club_reservations SET hold_expires_at = now() - interval '6 minutes'
           WHERE id = ${id}::uuid`);

      const court = (await saveResource(db, owner, null, {
        locationId,
        kind: 'court',
        name: 'Скуош 1',
        quantity: 1,
        sortOrder: 1,
      })) as string;
      expect(
        await saveLocationHours(db, owner, locationId, [
          { weekday, opens: '08:00', closes: '24:00' },
        ]),
      ).toBe(true);
      const base = {
        locationId,
        kind: 'rental' as const,
        nameEn: null,
        descriptionBg: null,
        descriptionEn: null,
        durationMin: 60,
        durationMax: 60,
        stepMinutes: 60,
        bufferMinutes: 0,
        priceUnit: 'hour' as const,
        priceCents: 1000,
        memberPriceCents: null,
        bookingWindowDays: 14,
        cancelDeadlineHours: 2,
        maxUpcomingPerMember: 2,
        audience: 'all' as const,
        visibility: 'public' as const,
        resourceIds: [court],
        staffUserIds: [],
      };
      const online = (await saveService(db, owner, null, {
        ...base,
        nameBg: 'Скуош онлайн',
        payment: 'online_required',
      })) as string;
      const onSite = (await saveService(db, owner, null, {
        ...base,
        nameBg: 'Скуош на място',
        payment: 'desk',
      })) as string;
      const slot = (serviceId: string, local: string, member: string | null = memberId) => ({
        serviceId,
        date: day,
        local,
        durationMinutes: 60,
        memberId: member,
      });

      // Midnight closes the day: the last hour, 23:00–24:00, is on sale.
      const late = await availability(db, clubId, onSite, day, 60, { member: false, office: true });
      expect(late.at(-1)?.local).toBe('23:00');

      // ── Scope. A private service, someone else's record, another club's
      // service, a trainer acting as the desk, a forged actor: all refused.
      const stranger = await createMember(db, desk, {
        displayName: 'Чужд Журни',
        email: null,
        phone: null,
        isMinor: false,
        guardianMemberId: null,
        tags: [],
        staffNote: null,
      });
      if (!stranger.ok) throw new Error('stranger');
      expect(await bookReservation(db, asMember, slot(onSite, '09:00', stranger.memberId))).toEqual(
        {
          ok: false,
          error: 'not_allowed',
        },
      );
      await db.execute(
        sql`UPDATE club_services SET visibility = 'private' WHERE id = ${onSite}::uuid`,
      );
      expect(await bookReservation(db, asMember, slot(onSite, '09:00'))).toEqual({
        ok: false,
        error: 'not_allowed',
      });
      await db.execute(
        sql`UPDATE club_services SET visibility = 'public' WHERE id = ${onSite}::uuid`,
      );
      await db.execute(
        sql`UPDATE club_services SET audience = 'adults' WHERE id = ${onSite}::uuid`,
      );
      expect(await bookReservation(db, asMember, slot(onSite, '09:00', childId))).toEqual({
        ok: false,
        error: 'audience_mismatch',
      });
      await db.execute(sql`UPDATE club_services SET audience = 'all' WHERE id = ${onSite}::uuid`);

      const otherOwnerId = await user('owner_b');
      const appliedB = await applyForClub(db, otherOwnerId, {
        nameBg: `E2E JR B ${Math.random().toString(36).slice(2, 6)}`,
        kind: 'gym',
        tier: 'community',
        municipalityId: null,
        sports: [],
        websiteUrl: null,
        descriptionBg: null,
      });
      if (!appliedB.ok) throw new Error('club b');
      await db.execute(
        sql`UPDATE clubs SET slug = ${`e2e-jr-b-${appliedB.slug}`.slice(0, 60)} WHERE id = ${appliedB.clubId}::uuid`,
      );
      expect(await approveClub(db, await user('admin_b', 'admin'), appliedB.clubId)).toBe(true);
      const ownerB: ClubActor = {
        userId: otherOwnerId,
        clubId: appliedB.clubId,
        role: 'owner',
        ngoAdmin: false,
      };
      const locationB = (await saveLocation(db, ownerB, null, {
        name: 'Б',
        facilityId: null,
        address: null,
      })) as string;
      const courtB = (await saveResource(db, ownerB, null, {
        locationId: locationB,
        kind: 'court',
        name: 'Б1',
        quantity: 1,
        sortOrder: 0,
      })) as string;
      const serviceB = (await saveService(db, ownerB, null, {
        ...base,
        locationId: locationB,
        resourceIds: [courtB],
        nameBg: 'Б',
        payment: 'desk',
      })) as string;
      expect(serviceB).toBeTruthy();
      expect(await bookReservation(db, asMember, slot(serviceB, '09:00'))).toEqual({
        ok: false,
        error: 'not_allowed',
      });

      const mine = await bookReservation(db, asMember, slot(onSite, '09:00'));
      if (!mine.ok) throw new Error(mine.error);
      const trainerId = await user('trainer_c');
      await db.execute(
        sql`INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${trainerId}, 'trainer')`,
      );
      const trainer: ClubActor = { userId: trainerId, clubId, role: 'trainer', ngoAdmin: false };
      expect(
        await bookReservation(db, { kind: 'staff', actor: trainer }, slot(onSite, '10:00')),
      ).toEqual({ ok: false, error: 'not_allowed' });
      expect(
        await cancelReservation(db, { kind: 'staff', actor: trainer }, mine.reservationId),
      ).toEqual({ ok: false });
      expect(
        await cancelReservation(db, { kind: 'staff', actor: ownerB }, mine.reservationId),
      ).toEqual({ ok: false });
      // The actor's claimed role and club are not trusted: B's owner posing
      // as an owner of THIS club holds no row in its staff.
      expect(
        await cancelReservation(
          db,
          { kind: 'staff', actor: { ...ownerB, clubId } },
          mine.reservationId,
        ),
      ).toEqual({ ok: false });
      expect(await state(mine.reservationId)).toBe('confirmed');

      // ── The cap: two upcoming bookings of a service per account online.
      const second = await bookReservation(db, asMember, slot(onSite, '10:00'));
      expect(second.ok).toBe(true);
      expect(await bookReservation(db, asMember, slot(onSite, '11:00'))).toEqual({
        ok: false,
        error: 'limit_reached',
      });
      // The desk is not capped.
      const deskEleven = await bookReservation(db, atDesk, slot(onSite, '11:00'));
      if (!deskEleven.ok) throw new Error(deskEleven.error);
      // Client names on the day calendar are for those who may see members:
      // the desk, never a trainer — decided in the statement.
      const laneItem = async (actor: ClubActor) =>
        (await dayCalendar(actor, locationId, day)).resources
          .flatMap((lane) => lane.items)
          .find((item) => item.id === deskEleven.reservationId);
      expect((await laneItem(desk))?.memberName).toBe('Мария Журни');
      expect(await laneItem(trainer)).toMatchObject({ memberName: null });

      // ── What was booked is a fact: its terms and its charge never move.
      const terms = await db
        .execute(
          sql`UPDATE club_reservations SET price_cents = 1 WHERE id = ${mine.reservationId}::uuid`,
        )
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(String((terms as { cause?: unknown } | null)?.cause ?? terms)).toMatch(
        /what was booked never changes/,
      );

      // ── The deadline that binds is the one the member booked under.
      await db.execute(
        sql`UPDATE club_services SET cancel_deadline_hours = 168 WHERE id = ${onSite}::uuid`,
      );
      expect(await cancelReservation(db, asMember, mine.reservationId)).toEqual({
        ok: true,
        late: false,
        refundDue: false,
      });
      expect(await voided(mine.chargeId)).toBe(true);

      // ── Part-paid, then cancelled in time: nothing more is owed (the charge
      // is voided), and what was paid is a refund the club owes, and lists.
      if (!second.ok) throw new Error('second');
      expect(
        await recordPayment(db, desk, {
          chargeId: second.chargeId ?? '',
          kind: 'payment',
          method: 'cash',
          amountCents: 500,
          receivedOn: sofiaToday(),
        }),
      ).toEqual({ ok: true });
      expect(await cancelReservation(db, asMember, second.reservationId)).toEqual({
        ok: true,
        late: false,
        refundDue: true,
      });
      expect(await voided(second.chargeId)).toBe(true);
      expect((await refundsDue(owner)).find((r) => r.chargeId === second.chargeId)).toMatchObject({
        source: 'reservation',
        paidCents: 500,
        online: false,
      });
      // A trainer may not see the money side at all.
      expect(await refundsDue(trainer)).toEqual([]);
      expect(
        await recordPayment(db, desk, {
          chargeId: second.chargeId ?? '',
          kind: 'refund',
          method: 'cash',
          amountCents: -500,
          receivedOn: sofiaToday(),
        }),
      ).toEqual({ ok: true });
      expect((await refundsDue(owner)).some((r) => r.chargeId === second.chargeId)).toBe(false);

      // ── Holds. One unpaid hold per account; the session dies with it.
      const held = await bookReservation(db, asMember, slot(online, '13:00'));
      if (!held.ok) throw new Error(held.error);
      expect(held.state).toBe('held');
      expect(await bookReservation(db, asMember, slot(online, '14:00'))).toEqual({
        ok: false,
        error: 'hold_pending',
      });
      const checkout = await startChargeCheckout(
        db,
        memberUser,
        { id: clubId, slug },
        held.chargeId ?? '',
        back,
      );
      if (!checkout.ok) throw new Error(checkout.error);
      // Lapsed past its grace: the sweep releases it, voids, closes — at once.
      await lapse(held.reservationId);
      expect(await expireReservationHolds(db)).toBeGreaterThanOrEqual(1);
      expect(await state(held.reservationId)).toBe('expired');
      expect(await voided(held.chargeId)).toBe(true);
      const closed = await db.execute(
        sql`SELECT status FROM club_checkouts WHERE id = ${checkout.checkoutId}::uuid`,
      );
      expect(closed.rows[0]?.status).toBe('expired');
      // Money that still arrives is never applied to a released slot.
      const latePay = await applyCheckoutPaid(db, {
        checkoutId: checkout.checkoutId,
        provider: 'fake',
        paymentRef: `fake_pi_late_${checkout.checkoutId.slice(0, 8)}`,
        amountCents: 1000,
        subscriptionRef: null,
      });
      expect(latePay).toMatchObject({ applied: false, reason: 'session_closed' });
      expect((await unappliedCheckouts(owner)).some((u) => u.id === checkout.checkoutId)).toBe(
        true,
      );

      // A lapsed hold on a slot is released by the next booking of it, in
      // the same transaction — charge voided, checkout closed.
      const again = await bookReservation(db, asMember, slot(online, '15:00'));
      if (!again.ok) throw new Error(again.error);
      const againCheckout = await startChargeCheckout(
        db,
        memberUser,
        { id: clubId, slug },
        again.chargeId ?? '',
        back,
      );
      if (!againCheckout.ok) throw new Error(againCheckout.error);
      await lapse(again.reservationId);
      const taker = await bookReservation(db, atDesk, slot(online, '15:00', stranger.memberId));
      expect(taker.ok).toBe(true);
      expect(await state(again.reservationId)).toBe('expired');
      expect(await voided(again.chargeId)).toBe(true);
      const againClosed = await db.execute(
        sql`SELECT status FROM club_checkouts WHERE id = ${againCheckout.checkoutId}::uuid`,
      );
      expect(againClosed.rows[0]?.status).toBe('expired');

      // A desk payment confirms a hold too, so the sweep never frees a paid slot.
      const deskPaid = await bookReservation(db, asMember, slot(online, '16:00'));
      if (!deskPaid.ok) throw new Error(deskPaid.error);
      expect(
        await recordPayment(db, desk, {
          chargeId: deskPaid.chargeId ?? '',
          kind: 'payment',
          method: 'cash',
          amountCents: 1000,
          receivedOn: sofiaToday(),
        }),
      ).toEqual({ ok: true });
      expect(await state(deskPaid.reservationId)).toBe('confirmed');

      // Too little of a hold left for the provider's 30-minute floor: refused.
      // Booked under a week-long deadline, so 17:00 is already inside it.
      await db.execute(
        sql`UPDATE club_services SET cancel_deadline_hours = 168 WHERE id = ${online}::uuid`,
      );
      const ending = await bookReservation(db, asMember, slot(online, '17:00'));
      if (!ending.ok) throw new Error(ending.error);
      await db.execute(
        sql`UPDATE club_services SET cancel_deadline_hours = 2 WHERE id = ${online}::uuid`,
      );
      const first = await startChargeCheckout(
        db,
        memberUser,
        { id: clubId, slug },
        ending.chargeId ?? '',
        back,
      );
      if (!first.ok) throw new Error(first.error);
      await db.execute(sql`
        UPDATE club_reservations SET hold_expires_at = now() + interval '10 minutes'
         WHERE id = ${ending.reservationId}::uuid`);
      // Back from the payment page with ten minutes left: the open session is
      // handed back, never expired and replaced by one that cannot exist.
      expect(
        await startChargeCheckout(
          db,
          memberUser,
          { id: clubId, slug },
          ending.chargeId ?? '',
          back,
        ),
      ).toMatchObject({ ok: true, checkoutId: first.checkoutId });
      // Once that session is gone, nothing can be opened in the time left.
      expect(await fakeSettle(first.checkoutId, 'cancelled')).toBe(true);
      expect(
        await startChargeCheckout(
          db,
          memberUser,
          { id: clubId, slug },
          ending.chargeId ?? '',
          back,
        ),
      ).toEqual({ ok: false, error: 'hold_ending' });
      // A held booking cancelled — even inside the deadline — is released, not
      // late, and owes nothing.
      expect(await cancelReservation(db, asMember, ending.reservationId)).toEqual({
        ok: true,
        late: false,
        refundDue: false,
      });
      expect(await voided(ending.chargeId)).toBe(true);

      // Cancelling a held booking closes its open payment page too.
      const abandoned = await bookReservation(db, asMember, slot(online, '20:00'));
      if (!abandoned.ok) throw new Error(abandoned.error);
      const abandonedCheckout = await startChargeCheckout(
        db,
        memberUser,
        { id: clubId, slug },
        abandoned.chargeId ?? '',
        back,
      );
      if (!abandonedCheckout.ok) throw new Error(abandonedCheckout.error);
      expect(await cancelReservation(db, asMember, abandoned.reservationId)).toMatchObject({
        ok: true,
        late: false,
      });
      const abandonedStatus = await db.execute(
        sql`SELECT status FROM club_checkouts WHERE id = ${abandonedCheckout.checkoutId}::uuid`,
      );
      expect(abandonedStatus.rows[0]?.status).toBe('expired');

      // With no way to pay online, an online-only service books nothing.
      vi.stubEnv('CLUB_PAYMENTS_ENABLED', 'false');
      expect(await bookReservation(db, asMember, slot(online, '18:00'))).toEqual({
        ok: false,
        error: 'payment_unavailable',
      });
      vi.stubEnv('CLUB_PAYMENTS_ENABLED', 'true');

      // ── An erased client's booking can still be cancelled at the desk.
      const goner = await bookReservation(db, atDesk, slot(onSite, '19:00', stranger.memberId));
      if (!goner.ok) throw new Error(goner.error);
      expect(await eraseMember(db, owner, stranger.memberId)).toBe('ok');
      expect(await cancelReservation(db, atDesk, goner.reservationId)).toMatchObject({ ok: true });

      // ── Appointments: the trainer's hours ∩ the location's, minus the
      // classes they teach, and only while a required court is free.
      expect(
        await saveStaffHours(db, owner, trainerId, locationId, [
          { weekday, opens: '09:00', closes: '12:00' },
        ]),
      ).toBe(true);
      const pt = (await saveService(db, owner, null, {
        ...base,
        kind: 'appointment',
        nameBg: 'Персонален час',
        payment: 'desk',
        resourceIds: [],
        staffUserIds: [trainerId],
        stepMinutes: 60,
      })) as string;
      const taught = await saveClass(db, owner, null, {
        title: 'Група на треньора',
        description: null,
        sport: 'fitness',
        locationId,
        instructorUserId: trainerId,
        resourceId: null,
        startsAtLocal: `${day} 10:00:00`,
        rrule: null,
        durationMinutes: 60,
        capacity: 4,
        bookingOpensHours: 168,
        cancelDeadlineHours: 2,
        dropInPriceCents: null,
        coversAllPlans: true,
        planIds: [],
        trialAllowed: false,
        public: true,
        ...NO_POLICY,
      });
      await materializeClubClasses(getPool(), { classId: taught ?? '' });
      const ptSlots = await availability(db, clubId, pt, day, 60, { member: false, office: true });
      expect(ptSlots.map((s) => s.local)).toEqual(['09:00', '11:00']);
      expect(ptSlots.every((s) => s.staffUserId === trainerId)).toBe(true);
      // Needing the squash court too: 11:00 is the desk's booking there.
      await saveService(db, owner, pt, {
        ...base,
        kind: 'appointment',
        nameBg: 'Персонален час',
        payment: 'desk',
        resourceIds: [court],
        staffUserIds: [trainerId],
        stepMinutes: 60,
      });
      const withCourt = await availability(db, clubId, pt, day, 60, {
        member: false,
        office: true,
      });
      expect(withCourt.map((s) => [s.local, s.resourceId])).toEqual([['09:00', court]]);

      // ── Facility changes the calendar refuses, with a reason, never a 500.
      const booked = (
        await db.execute(sql`
          SELECT starts_at, ends_at FROM club_reservations WHERE id = ${deskEleven.reservationId}::uuid`)
      ).rows[0];
      const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
      expect(
        await addResourceBlock(db, owner, {
          resourceId: court,
          startsAt: iso(booked?.starts_at),
          endsAt: iso(booked?.ends_at),
          reason: 'other',
        }),
      ).toBe('conflict');
      expect(await setResourceArchived(db, owner, court, true)).toBe('busy');
      const elsewhere = (await saveLocation(db, owner, null, {
        name: 'Зала 2',
        facilityId: null,
        address: null,
      })) as string;
      await expect(
        saveResource(db, owner, court, {
          locationId: elsewhere,
          kind: 'court',
          name: 'Скуош 1',
          quantity: 1,
          sortOrder: 1,
        }),
      ).rejects.toMatchObject({ code: 'resource_busy' });
      // A pool cannot shrink below what is booked at one moment.
      const rackets = (await saveResource(db, owner, null, {
        locationId,
        kind: 'equipment',
        name: 'Ракети',
        quantity: 2,
        sortOrder: 2,
      })) as string;
      const rent = (await saveService(db, owner, null, {
        ...base,
        nameBg: 'Ракета',
        payment: 'desk',
        resourceIds: [rackets],
      })) as string;
      expect((await bookReservation(db, atDesk, slot(rent, '10:00'))).ok).toBe(true);
      expect((await bookReservation(db, atDesk, slot(rent, '10:00'))).ok).toBe(true);
      await expect(
        saveResource(db, owner, rackets, {
          locationId,
          kind: 'equipment',
          name: 'Ракети',
          quantity: 1,
          sortOrder: 2,
        }),
      ).rejects.toMatchObject({ code: 'quantity_conflict' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('sells over the counter with stock and offers, reverses a sale, and discounts a plan', async () => {
    vi.stubEnv('CLUB_PAYMENTS_ENABLED', 'true');
    vi.stubEnv('PAYMENT_PROVIDER', 'fake');
    try {
      const label = (n: number) => `Продажба №${n}`;
      const product = (name: string, priceCents: number, sku: string | null = null) => ({
        name,
        sku,
        category: 'drink' as const,
        priceCents,
        vatRateBp: 2000,
        trackStock: true,
        lowStockAt: 3,
        sortOrder: 0,
      });
      const water = await saveProduct(db, owner, null, product('Вода', 150, 'W-500'));
      if (!water.ok) throw new Error(water.error);
      // The desk sells; it does not set prices or count the shelf.
      expect(await saveProduct(db, desk, null, product('Х', 1))).toEqual({
        ok: false,
        error: 'not_allowed',
      });
      expect(await saveProduct(db, owner, null, product('Друга вода', 150, 'W-500'))).toEqual({
        ok: false,
        error: 'sku_taken',
      });
      const bar = await saveProduct(db, owner, null, product('Протеиново барче', 299));
      if (!bar.ok) throw new Error(bar.error);
      expect(
        await recordStock(db, owner, {
          productId: water.productId,
          kind: 'receive',
          quantity: 10,
          unitCostCents: 60,
        }),
      ).toBe('ok');
      expect(
        await recordStock(db, desk, {
          productId: water.productId,
          kind: 'receive',
          quantity: 10,
          unitCostCents: null,
        }),
      ).toBe('not_allowed');
      // The shelf holds 8: the ledger gets the difference.
      expect(
        await recordStock(db, owner, {
          productId: water.productId,
          kind: 'count',
          quantity: 8,
          unitCostCents: null,
        }),
      ).toBe('ok');
      const onHand = async (id: string) =>
        (await clubProducts(owner)).find((p) => p.id === id)?.onHand;
      expect(await onHand(water.productId)).toBe(8);

      // A walk-in buys two waters for cash: numbered, paid, off the shelf.
      const first = await recordTillSale(
        db,
        desk,
        {
          lines: [{ productId: water.productId, quantity: 2 }],
          memberId: null,
          method: 'cash',
          code: null,
          locationId,
        },
        label,
      );
      if (!first.ok) throw new Error(first.error);
      expect(first.totalCents).toBe(300);
      expect(await onHand(water.productId)).toBe(6);
      const receipt = await saleById(desk, first.saleId);
      expect(receipt).toMatchObject({ status: 'paid', reversed: false, totalCents: 300 });
      expect(receipt?.payments).toEqual([{ method: 'cash', amountCents: 300, refundedCents: 0 }]);
      // A trainer has no till.
      const trainerId = await user('trainer_b1');
      await db.execute(
        sql`INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${trainerId}, 'trainer')`,
      );
      const trainer: ClubActor = { userId: trainerId, clubId, role: 'trainer', ngoAdmin: false };
      expect(
        await recordTillSale(
          db,
          trainer,
          {
            lines: [{ productId: water.productId, quantity: 1 }],
            memberId: null,
            method: 'cash',
            code: null,
            locationId: null,
          },
          label,
        ),
      ).toEqual({ ok: false, error: 'not_allowed' });

      // Offers: an automatic 10 % on products, and a one-use €2 code.
      const today = sofiaToday();
      const offer = (input: Partial<Parameters<typeof savePromotion>[3]>) =>
        savePromotion(db, owner, null, {
          name: 'Оферта',
          code: null,
          kind: 'percent',
          value: 1000,
          target: 'products',
          targetIds: null,
          startsOn: today,
          endsOn: null,
          maxUses: null,
          perMemberMax: null,
          newMembersOnly: false,
          minVisits90d: null,
          ...input,
        });
      const tenOff = await offer({ name: 'Десет процента' });
      const voucher = await offer({
        name: 'Ваучер',
        code: 'BAR-0002',
        kind: 'amount',
        value: 200,
        target: 'all',
        maxUses: 1,
      });
      if (!tenOff.ok || !voucher.ok) throw new Error('offers');
      // The desk may not create offers.
      expect(
        await savePromotion(db, desk, null, {
          name: 'Х',
          code: null,
          kind: 'percent',
          value: 100,
          target: 'all',
          targetIds: null,
          startsOn: today,
          endsOn: null,
          maxUses: null,
          perMemberMax: null,
          newMembersOnly: false,
          minVisits90d: null,
        }),
      ).toEqual({ ok: false, error: 'not_allowed' });
      const sell = (
        memberIdFor: string | null,
        code: string | null,
        method: 'cash' | null = 'cash',
      ) =>
        recordTillSale(
          db,
          desk,
          {
            lines: [
              { productId: water.productId, quantity: 2 },
              { productId: bar.productId, quantity: 1 },
            ],
            memberId: memberIdFor,
            method,
            code,
            locationId: null,
          },
          label,
        );
      // 300 + 299 = 599: 10 % automatically (60), or the €2 code if typed (better).
      const auto = await sell(null, null);
      expect(auto).toMatchObject({ ok: true, discountCents: 60, totalCents: 539 });
      const coded = await sell(null, 'bar-0002');
      expect(coded).toMatchObject({ ok: true, discountCents: 200, totalCents: 399 });
      // Used once, it gives nothing more: the till says so rather than charging full.
      expect(await sell(null, 'BAR-0002')).toEqual({ ok: false, error: 'code_invalid' });
      // Reversing the sale returns the goods and the money, and frees the use.
      if (!coded.ok) throw new Error('coded');
      const before = await onHand(bar.productId);
      expect(await reverseSale(db, desk, coded.saleId)).toBe('not_found');
      expect(await reverseSale(db, owner, coded.saleId)).toBe('ok');
      expect(await reverseSale(db, owner, coded.saleId)).toBe('not_found');
      expect(await onHand(bar.productId)).toBe((before ?? 0) + 1);
      const undone = await saleById(owner, coded.saleId);
      expect(undone).toMatchObject({ reversed: true, status: 'void' });
      expect(undone?.payments).toEqual([{ method: 'cash', amountCents: 399, refundedCents: 399 }]);
      expect((await sell(null, 'BAR-0002')).ok).toBe(true);

      // On the client's account: the charge stays open for them.
      const onAccount = await sell(memberId, null, null);
      if (!onAccount.ok) throw new Error(onAccount.error);
      expect((await saleById(desk, onAccount.saleId))?.status).toBe('open');
      expect(
        (await openCharges(desk, { memberId })).some((c) => c.label === label(onAccount.number)),
      ).toBe(true);

      // A plan at the desk: an automatic offer on plans, and a blank amount
      // pays all of it after the offer.
      const plan = await savePlan(db, owner, null, {
        nameBg: 'Оферта план',
        nameEn: null,
        descriptionBg: null,
        descriptionEn: null,
        kind: 'unlimited',
        audience: 'all',
        priceCents: 4000,
        validityDays: 30,
        validityMonths: null,
        visitsCount: null,
        visibility: 'public',
        ...NO_TERMS,
      });
      const planOff = await offer({ name: 'Есен', target: 'plans', kind: 'amount', value: 1000 });
      if (!plan || !planOff.ok) throw new Error('plan offer');
      const sold = await sellMembership(db, desk, {
        memberId: childId,
        planId: plan,
        startsOn: today,
        dueOn: today,
        payment: { method: 'cash', amountCents: null, receivedOn: today },
      });
      if (!sold.ok) throw new Error(sold.error);
      const price = await db.execute(sql`
        SELECT ms.price_cents, cb.status,
               (SELECT rd.discount_cents FROM club_promotion_redemptions rd
                 WHERE rd.membership_id = ms.id) AS discount
          FROM club_memberships ms JOIN club_charge_balances cb ON cb.charge_id = ${sold.chargeId}::uuid
         WHERE ms.id = ${sold.membershipId}::uuid`);
      expect(price.rows[0]).toEqual({ price_cents: 3000, status: 'paid', discount: 1000 });

      // Online, the offer travels with the checkout and is used when the money lands.
      const bought = await startPlanCheckout(
        db,
        memberUser,
        { id: clubId, slug },
        { planId: plan, memberId: childId, startsOn: null, termsAccepted: true, code: null },
        { base: 'http://localhost', locale: 'bg' },
      );
      if (!bought.ok) throw new Error(bought.error);
      const opened = await db.execute(
        sql`SELECT amount_cents, discount_cents FROM club_checkouts WHERE id = ${bought.checkoutId}::uuid`,
      );
      expect(opened.rows[0]).toEqual({ amount_cents: 3000, discount_cents: 1000 });
      expect(await fakeSettle(bought.checkoutId, 'paid')).toBe(true);
      const used = await db.execute(sql`
        SELECT count(*)::int AS n FROM club_promotion_redemptions
         WHERE promotion_id = ${planOff.promotionId}::uuid AND member_id = ${childId}::uuid`);
      // The desk sale and the online one.
      expect(used.rows[0]?.n).toBe(2);

      // A tier without offers neither saves nor applies them: a code typed at
      // the desk is refused, not silently ignored.
      await db.execute(sql`UPDATE clubs SET tier = 'community' WHERE id = ${clubId}::uuid`);
      expect((await offer({ name: 'Х' })).ok).toBe(false);
      expect(
        await sellMembership(db, desk, {
          memberId: childId,
          planId: plan,
          startsOn: today,
          dueOn: today,
          payment: null,
          code: 'BAR-0002',
        }),
      ).toEqual({ ok: false, error: 'code_invalid' });
      await db.execute(sql`UPDATE clubs SET tier = 'standard' WHERE id = ${clubId}::uuid`);

      for (const id of [tenOff.promotionId, voucher.promotionId, planOff.promotionId]) {
        expect(await setPromotionArchived(db, owner, id)).toBe(true);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps offers to their rules at the till, the desk and online, and a reversal to its money', async () => {
    vi.stubEnv('CLUB_PAYMENTS_ENABLED', 'true');
    vi.stubEnv('PAYMENT_PROVIDER', 'fake');
    try {
      const today = sofiaToday();
      const back = { base: 'http://localhost', locale: 'bg' as const };
      const label = (n: number) => `Продажба №${n}`;
      const juice = await saveProduct(db, owner, null, {
        name: 'Сок',
        sku: null,
        category: 'drink',
        priceCents: 400,
        vatRateBp: 2000,
        trackStock: true,
        lowStockAt: null,
        sortOrder: 0,
      });
      if (!juice.ok) throw new Error(juice.error);
      const offer = async (input: Partial<Parameters<typeof savePromotion>[3]>) => {
        const saved = await savePromotion(db, owner, null, {
          name: 'Оферта',
          code: null,
          kind: 'percent',
          value: 1000,
          target: 'products',
          targetIds: null,
          startsOn: today,
          endsOn: null,
          maxUses: null,
          perMemberMax: null,
          newMembersOnly: false,
          minVisits90d: null,
          ...input,
        });
        if (!saved.ok) throw new Error(saved.error);
        return saved.promotionId;
      };
      const till = (
        buyer: string | null,
        code: string | null,
        method: 'cash' | null = 'cash',
        extra: { productId?: string; locationId?: string | null } = {},
      ) =>
        recordTillSale(
          db,
          desk,
          {
            lines: [{ productId: extra.productId ?? juice.productId, quantity: 1 }],
            memberId: buyer,
            method,
            code,
            locationId: extra.locationId ?? null,
          },
          label,
        );

      // ── Another club's product, client or location never reaches this till.
      const otherClub = String(
        (await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-jr-b-%' LIMIT 1`)).rows[0]
          ?.id,
      );
      const foreignProduct = String(
        (
          await db.execute(sql`
            INSERT INTO club_products (club_id, name, price_cents)
            VALUES (${otherClub}::uuid, 'Чужд', 100) RETURNING id`)
        ).rows[0]?.id,
      );
      const foreignMember = String(
        (
          await db.execute(sql`
            INSERT INTO club_members (club_id, display_name, source)
            VALUES (${otherClub}::uuid, 'Чужд', 'staff') RETURNING id`)
        ).rows[0]?.id,
      );
      const foreignLocation = String(
        (await db.execute(sql`SELECT id FROM club_locations WHERE club_id = ${otherClub}::uuid`))
          .rows[0]?.id,
      );
      expect(await till(null, null, 'cash', { productId: foreignProduct })).toEqual({
        ok: false,
        error: 'product_unavailable',
      });
      expect(await till(foreignMember, null)).toEqual({ ok: false, error: 'member_unavailable' });
      expect(await till(null, null, 'cash', { locationId: foreignLocation })).toEqual({
        ok: false,
        error: 'not_allowed',
      });

      // ── Who an offer is for. Loyal clients 50 %, new clients 40 %, once
      // per client 30 %: a walk-in gets none of them.
      const loyal = await offer({ name: 'Лоялни', value: 5000, minVisits90d: 1 });
      const fresh = await offer({ name: 'Нови', value: 4000, newMembersOnly: true });
      const once = await offer({ name: 'Веднъж', value: 3000, perMemberMax: 1 });
      expect(await till(null, null)).toMatchObject({ ok: true, discountCents: 0 });
      const newcomer = await createMember(db, desk, {
        displayName: 'Нов Журни',
        email: null,
        phone: null,
        isMinor: false,
        guardianMemberId: null,
        tags: [],
        staffNote: null,
      });
      if (!newcomer.ok) throw new Error('newcomer');
      const cart = {
        lines: [{ productId: juice.productId, quantity: 1 }],
        memberId: newcomer.memberId,
        code: null,
      };
      // New, never in: the new-client offer. The till's preview says so first.
      expect(await previewTillSale(db, desk, cart)).toEqual({
        ok: true,
        subtotalCents: 400,
        discountCents: 160,
        totalCents: 240,
        offerName: 'Нови',
      });
      expect(await till(newcomer.memberId, null)).toMatchObject({ ok: true, discountCents: 160 });
      // A visit makes them loyal: the better offer wins.
      await clubCheckIn(db, { method: 'desk', actor: desk, memberId: newcomer.memberId });
      expect(await previewTillSale(db, desk, cart)).toMatchObject({ discountCents: 200 });
      expect(await till(newcomer.memberId, null)).toMatchObject({ ok: true, discountCents: 200 });
      // Without those two: once per client, then nothing.
      expect(await setPromotionArchived(db, owner, loyal)).toBe(true);
      expect(await setPromotionArchived(db, owner, fresh)).toBe(true);
      expect(await till(newcomer.memberId, null)).toMatchObject({ ok: true, discountCents: 120 });
      expect(await till(newcomer.memberId, null)).toMatchObject({ ok: true, discountCents: 0 });
      expect(await setPromotionArchived(db, owner, once)).toBe(true);

      // ── A one-off plan; a voucher taken online is RESERVED while its
      // checkout is open — the desk and the till cannot spend it meanwhile.
      const plan = await savePlan(db, owner, null, {
        nameBg: 'Ваучер план',
        nameEn: null,
        descriptionBg: null,
        descriptionEn: null,
        kind: 'unlimited',
        audience: 'all',
        priceCents: 5000,
        validityDays: 30,
        validityMonths: null,
        visitsCount: null,
        visibility: 'public',
        ...NO_TERMS,
      });
      if (!plan) throw new Error('plan');
      const gift = await offer({
        name: 'Подарък',
        code: 'GIFT-RSV1',
        kind: 'amount',
        value: 1000,
        target: 'all',
        maxUses: 1,
      });
      const buy = () =>
        startPlanCheckout(
          db,
          memberUser,
          { id: clubId, slug },
          {
            planId: plan,
            memberId: childId,
            startsOn: null,
            termsAccepted: true,
            code: 'GIFT-RSV1',
          },
          back,
        );
      const first = await buy();
      if (!first.ok) throw new Error(first.error);
      expect(
        await sellMembership(db, desk, {
          memberId: newcomer.memberId,
          planId: plan,
          startsOn: today,
          dueOn: today,
          payment: null,
          code: 'GIFT-RSV1',
        }),
      ).toEqual({ ok: false, error: 'code_invalid' });
      expect(await till(null, 'GIFT-RSV1')).toEqual({ ok: false, error: 'code_invalid' });
      // Back from the provider and again: the earlier attempt is closed and
      // its reservation passes to the new one.
      const second = await buy();
      if (!second.ok) throw new Error(second.error);
      expect((await checkoutForMember(memberUser, clubId, first.checkoutId))?.status).toBe(
        'expired',
      );
      // Abandoned: the voucher is free again (here, a free juice).
      expect(await fakeSettle(second.checkoutId, 'cancelled')).toBe(true);
      expect(await till(null, 'GIFT-RSV1')).toMatchObject({ ok: true, totalCents: 0 });

      // ── A subscription takes no code (Stripe would repeat the discount).
      const monthly = await savePlan(db, owner, null, {
        nameBg: 'Месечен абонамент',
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
        ...NO_TERMS,
        autoRenew: true,
      });
      if (!monthly) throw new Error('monthly');
      expect(
        await startPlanCheckout(
          db,
          memberUser,
          { id: clubId, slug },
          { planId: monthly, memberId: childId, startsOn: null, termsAccepted: true, code: 'X-1' },
          back,
        ),
      ).toEqual({ ok: false, error: 'code_invalid' });

      // ── An offer that makes a plan free: a typed amount is refused, not
      // dropped; a blank one records no charge and no payment.
      const freeMonth = await offer({
        name: 'Първи месец',
        kind: 'percent',
        value: 10000,
        target: 'plans',
        targetIds: [plan],
      });
      expect(
        await previewMembershipSale(db, desk, {
          memberId: newcomer.memberId,
          planId: plan,
          code: null,
        }),
      ).toEqual({
        ok: true,
        listCents: 5000,
        discountCents: 5000,
        priceCents: 0,
        offerName: 'Първи месец',
      });
      const freeSale = {
        memberId: newcomer.memberId,
        planId: plan,
        startsOn: today,
        dueOn: today,
      };
      expect(
        await sellMembership(db, desk, {
          ...freeSale,
          payment: { method: 'cash', amountCents: 5000, receivedOn: today },
        }),
      ).toEqual({ ok: false, error: 'amount_exceeds_due' });
      const free = await sellMembership(db, desk, {
        ...freeSale,
        payment: { method: 'cash', amountCents: null, receivedOn: today },
      });
      expect(free).toMatchObject({ ok: true, chargeId: null });
      expect(await setPromotionArchived(db, owner, freeMonth)).toBe(true);

      // ── A tab paid online: reversed only after the online refund; its
      // charge is never voided on its own.
      const tab = await till(memberId, null, null);
      if (!tab.ok) throw new Error(tab.error);
      const tabCharge = String(
        (await db.execute(sql`SELECT charge_id FROM club_sales WHERE id = ${tab.saleId}::uuid`))
          .rows[0]?.charge_id,
      );
      const paying = await startChargeCheckout(
        db,
        memberUser,
        { id: clubId, slug },
        tabCharge,
        back,
      );
      if (!paying.ok) throw new Error(paying.error);
      expect(await fakeSettle(paying.checkoutId, 'paid')).toBe(true);
      expect(await reverseSale(db, owner, tab.saleId)).toBe('paid_online');
      expect(await voidCharge(db, owner, tabCharge)).toBe('till_sale_charge');
      const online = await db.execute(sql`
        SELECT id FROM club_payments
         WHERE charge_id = ${tabCharge}::uuid AND method = 'card_online' AND kind = 'payment'`);
      expect(await refundOnlinePayment(db, owner, Number(online.rows[0]?.id), null)).toEqual({
        ok: true,
      });
      const shelf = async () =>
        (await clubProducts(owner)).find((p) => p.id === juice.productId)?.onHand ?? 0;
      const before = await shelf();
      expect(await reverseSale(db, owner, tab.saleId)).toBe('ok');
      expect(await shelf()).toBe(before + 1);
      expect(await saleById(owner, tab.saleId)).toMatchObject({ reversed: true, status: 'void' });

      // ── A count far off the ledger is refused, not a 500.
      expect(
        await recordStock(db, owner, {
          productId: juice.productId,
          kind: 'count',
          quantity: 150_000,
          unitCostCents: null,
        }),
      ).toBe('too_large');
      // The desk sells; it neither archives products nor ends offers.
      expect(await setProductArchived(db, desk, juice.productId, true)).toBe('not_found');
      expect(await setPromotionArchived(db, desk, gift)).toBe(false);
      expect(await setPromotionArchived(db, owner, gift)).toBe(true);
      expect(await setProductArchived(db, owner, juice.productId, true)).toBe('ok');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('loads, spends and pays back credit, and invoices a sale with a credit note', async () => {
    vi.stubEnv('CLUB_PAYMENTS_ENABLED', 'true');
    vi.stubEnv('PAYMENT_PROVIDER', 'fake');
    try {
      const today = sofiaToday();
      const back = { base: 'http://localhost', locale: 'bg' as const };
      const label = 'Предплатен кредит';
      const shake = await saveProduct(db, owner, null, {
        name: 'Шейк',
        sku: null,
        category: 'drink',
        priceCents: 1500,
        vatRateBp: 2000,
        trackStock: false,
        lowStockAt: null,
        sortOrder: 0,
      });
      if (!shake.ok) throw new Error(shake.error);
      const till = (buyer: string | null, method: 'cash' | 'wallet', quantity = 1) =>
        recordTillSale(
          db,
          desk,
          {
            lines: [{ productId: shake.productId, quantity }],
            memberId: buyer,
            method,
            code: null,
            locationId: null,
          },
          (n) => `Продажба №${n}`,
        );
      const created = await createMember(db, desk, {
        displayName: 'Кредит Журни',
        email: null,
        phone: null,
        isMinor: false,
        guardianMemberId: null,
        tags: [],
        staffNote: null,
      });
      if (!created.ok) throw new Error('member');
      const client = created.memberId;
      const credit = async (who = client) => (await memberWallet(owner, who)).balanceCents;

      // ── Loaded at the desk, spent on a plan and at the till.
      expect(
        await topUpWallet(
          db,
          desk,
          { memberId: client, amountCents: 5000, method: 'cash', receivedOn: today },
          label,
        ),
      ).toEqual({ ok: true });
      expect(await credit()).toBe(5000);
      const plan = await savePlan(db, owner, null, {
        nameBg: 'Кредит план',
        nameEn: null,
        descriptionBg: null,
        descriptionEn: null,
        kind: 'unlimited',
        audience: 'all',
        priceCents: 3000,
        validityDays: 30,
        validityMonths: null,
        visitsCount: null,
        visibility: 'public',
        ...NO_TERMS,
      });
      if (!plan) throw new Error('plan');
      expect(
        await sellMembership(db, desk, {
          memberId: client,
          planId: plan,
          startsOn: today,
          dueOn: today,
          payment: { method: 'wallet', amountCents: null, receivedOn: today },
        }),
      ).toMatchObject({ ok: true });
      expect(await credit()).toBe(2000);
      // More than is left, or no client to take it from: refused.
      expect(await till(client, 'wallet', 2)).toEqual({ ok: false, error: 'wallet_insufficient' });
      expect(await till(null, 'wallet')).toEqual({ ok: false, error: 'wallet_needs_client' });
      const paidWithCredit = await till(client, 'wallet');
      if (!paidWithCredit.ok) throw new Error(paidWithCredit.error);
      expect(await credit()).toBe(500);
      // Reversing the sale gives the credit back.
      expect(await reverseSale(db, owner, paidWithCredit.saleId)).toBe('ok');
      expect(await credit()).toBe(2000);
      // The client's credit history, newest first.
      const wallet = await memberWallet(owner, client);
      expect(wallet.entries.map((e) => e.kind)).toEqual(['returned', 'spent', 'spent', 'top_up']);

      // ── The client's money: never erased with it, paid back no further than it goes.
      expect(await eraseMember(db, owner, client)).toBe('credit_left');
      expect(
        await payOutWallet(db, desk, {
          memberId: client,
          amountCents: 2500,
          method: 'cash',
          receivedOn: today,
        }),
      ).toEqual({ ok: false, error: 'wallet_insufficient' });
      expect(
        await payOutWallet(db, desk, {
          memberId: client,
          amountCents: 2000,
          method: 'cash',
          receivedOn: today,
        }),
      ).toEqual({ ok: true });
      expect(await credit()).toBe(0);

      // ── Loaded online: the charge exists only once the money does, and an
      // online refund gives back only what is unspent.
      const before = await credit(memberId);
      const online = await startWalletCheckout(
        db,
        memberUser,
        { id: clubId, slug },
        { memberId, amountCents: 2000, label },
        back,
      );
      if (!online.ok) throw new Error(online.error);
      expect(await credit(memberId)).toBe(before);
      expect(await fakeSettle(online.checkoutId, 'paid')).toBe(true);
      expect(await credit(memberId)).toBe(before + 2000);
      const spent = await till(memberId, 'wallet');
      if (!spent.ok) throw new Error(spent.error);
      const loaded = await db.execute(sql`
        SELECT p.id FROM club_payments p
          JOIN club_checkouts k ON k.club_id = p.club_id AND k.charge_id = p.charge_id
         WHERE k.id = ${online.checkoutId}::uuid AND p.kind = 'payment'`);
      const paymentId = Number(loaded.rows[0]?.id);
      // 2000 loaded, 1500 spent: the whole 2000 cannot go back to the card.
      expect(before).toBe(0);
      expect(await refundOnlinePayment(db, owner, paymentId, null)).toEqual({
        ok: false,
        error: 'wallet_spent',
      });
      expect(await refundOnlinePayment(db, owner, paymentId, 500)).toEqual({ ok: true });
      expect(await credit(memberId)).toBe(before + 2000 - 1500 - 500);

      // ── Invoices: the club's details first, then a sale's lines with VAT.
      const sale = await till(client, 'cash', 2);
      if (!sale.ok) throw new Error(sale.error);
      const saleCharge = String(
        (await db.execute(sql`SELECT charge_id FROM club_sales WHERE id = ${sale.saleId}::uuid`))
          .rows[0]?.charge_id,
      );
      const buyer = {
        kind: 'company' as const,
        name: 'Фирма ООД',
        eik: '987654321',
        vatNumber: null,
        address: 'София, ул. Фирмена 2',
      };
      expect(await issueInvoice(db, owner, { chargeId: saleCharge, buyer })).toEqual({
        ok: false,
        error: 'invoice_details_missing',
      });
      await db.execute(
        sql`UPDATE clubs SET legal_name = 'Журни Фитнес ЕООД', eik = '123456789' WHERE id = ${clubId}::uuid`,
      );
      expect(
        await saveInvoiceDetails(db, owner, {
          legalAddress: 'София, ул. Тест 1',
          vatNumber: 'BG123456789',
          iban: 'BG80BNBG96611020345678',
          invoiceVatBp: 2000,
          zeroVatBasis: null,
        }),
      ).toBe(true);
      // The desk does not issue invoices.
      expect(await issueInvoice(db, desk, { chargeId: saleCharge, buyer })).toEqual({
        ok: false,
        error: 'not_allowed',
      });
      const issued = await issueInvoice(db, owner, { chargeId: saleCharge, buyer });
      if (!issued.ok) throw new Error(issued.error);
      const document = await invoiceById(owner, issued.invoiceId);
      expect(document).toMatchObject({
        kind: 'invoice',
        totalCents: 3000,
        baseCents: 2500,
        vatCents: 500,
        paymentMethod: 'cash',
        supplier: { vatNumber: 'BG123456789', iban: 'BG80BNBG96611020345678' },
        buyer: { kind: 'company', eik: '987654321' },
      });
      expect(document?.lines).toEqual([
        expect.objectContaining({
          description: 'Шейк',
          quantity: 2,
          vatRateBp: 2000,
          totalCents: 3000,
        }),
      ]);
      expect(await issueInvoice(db, owner, { chargeId: saleCharge, buyer })).toEqual({
        ok: false,
        error: 'invoice_exists',
      });
      // Credit is invoiced when it is LOADED: the top-up, for what stays on
      // it (5000 loaded, 2000 paid back)…
      const chargeOf = async (kind: string) =>
        String(
          (
            await db.execute(sql`
              SELECT id FROM club_charges
               WHERE club_id = ${clubId}::uuid AND member_id = ${client}::uuid AND kind = ${kind}
               LIMIT 1`)
          ).rows[0]?.id,
        );
      const topUpInvoice = await issueInvoice(db, owner, {
        chargeId: await chargeOf('wallet'),
        buyer,
      });
      if (!topUpInvoice.ok) throw new Error(topUpInvoice.error);
      expect(await invoiceById(owner, topUpInvoice.invoiceId)).toMatchObject({
        totalCents: 3000,
        baseCents: 2500,
        paymentMethod: 'cash',
        lines: [expect.objectContaining({ description: label, vatRateBp: 2000 })],
      });
      // …and what credit paid for is not invoiced again.
      expect(
        await issueInvoice(db, owner, { chargeId: await chargeOf('membership'), buyer }),
      ).toEqual({ ok: false, error: 'invoice_paid_by_credit' });
      // Corrected by a credit note for the whole; then the charge may be invoiced again.
      const credited = await issueCreditNote(db, owner, issued.invoiceId, 'Грешен получател');
      if (!credited.ok) throw new Error(credited.error);
      expect(await issueCreditNote(db, owner, issued.invoiceId, 'Отново')).toEqual({
        ok: false,
        error: 'already_credited',
      });
      const again = await issueInvoice(db, owner, {
        chargeId: saleCharge,
        buyer: { ...buyer, name: 'Правилна Фирма ООД' },
      });
      if (!again.ok) throw new Error(again.error);
      const numbers = (await clubInvoices(owner)).map((i) => [i.number, i.kind]);
      expect(numbers.slice(0, 4)).toEqual([
        [4, 'invoice'],
        [3, 'credit_note'],
        [2, 'invoice'],
        [1, 'invoice'],
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps credit and invoices honest at the edges: tiers, roles, repeats and corrections', async () => {
    vi.stubEnv('CLUB_PAYMENTS_ENABLED', 'true');
    vi.stubEnv('PAYMENT_PROVIDER', 'fake');
    try {
      const today = sofiaToday();
      const back = { base: 'http://localhost', locale: 'bg' as const };
      const label = 'Предплатен кредит';
      const newClient = async (name: string) => {
        const made = await createMember(db, desk, {
          displayName: name,
          email: null,
          phone: null,
          isMinor: false,
          guardianMemberId: null,
          tags: [],
          staffNote: null,
        });
        if (!made.ok) throw new Error(name);
        return made.memberId;
      };
      const credit = async (who: string) => (await memberWallet(owner, who)).balanceCents;
      const top = (who: string, cents: number, nonce?: string) =>
        topUpWallet(
          db,
          desk,
          {
            memberId: who,
            amountCents: cents,
            method: 'cash',
            receivedOn: today,
            ...(nonce ? { nonce } : {}),
          },
          label,
        );
      const payOut = (who: string, cents: number) =>
        payOutWallet(db, desk, {
          memberId: who,
          amountCents: cents,
          method: 'cash',
          receivedOn: today,
        });
      const water = await saveProduct(db, owner, null, {
        name: 'Вода без ДДС',
        sku: null,
        category: 'drink',
        priceCents: 200,
        vatRateBp: 0,
        trackStock: false,
        lowStockAt: null,
        sortOrder: 0,
      });
      if (!water.ok) throw new Error(water.error);
      const sell = (who: string | null, method: 'cash' | 'wallet') =>
        recordTillSale(
          db,
          desk,
          {
            lines: [{ productId: water.productId, quantity: 1 }],
            memberId: who,
            method,
            code: null,
            locationId: null,
          },
          (n) => `Продажба №${n}`,
        );

      // ── A repeated form loads once (its token is remembered).
      const ana = await newClient('Ана Кредит');
      const nonce = '6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b';
      expect(await top(ana, 1000, nonce)).toEqual({ ok: true });
      expect(await top(ana, 1000, nonce)).toEqual({ ok: true });
      expect(await credit(ana)).toBe(1000);
      // A top-up with money on it is paid back, never voided.
      const anaTopUp = String(
        (
          await db.execute(sql`
            SELECT id FROM club_charges WHERE member_id = ${ana}::uuid AND kind = 'wallet' LIMIT 1`)
        ).rows[0]?.id,
      );
      expect(await voidCharge(db, owner, anaTopUp)).toBe('wallet_void');

      // ── Cash paid for a charge never turns into credit.
      const cashSale = await sell(ana, 'cash');
      if (!cashSale.ok) throw new Error(cashSale.error);
      const cashCharge = String(
        (
          await db.execute(
            sql`SELECT charge_id FROM club_sales WHERE id = ${cashSale.saleId}::uuid`,
          )
        ).rows[0]?.charge_id,
      );
      expect(
        await recordPayment(db, owner, {
          chargeId: cashCharge,
          kind: 'refund',
          amountCents: -200,
          method: 'wallet',
          receivedOn: today,
        }),
      ).toEqual({ ok: false, error: 'wallet_refund_exceeds' });

      // ── Roles: a trainer neither loads nor pays back credit.
      const trainerId = await user('trainer_b2');
      await db.execute(
        sql`INSERT INTO club_staff (club_id, user_id, role) VALUES (${clubId}::uuid, ${trainerId}, 'trainer')`,
      );
      const trainer: ClubActor = { userId: trainerId, clubId, role: 'trainer', ngoAdmin: false };
      expect(
        await topUpWallet(
          db,
          trainer,
          { memberId: ana, amountCents: 100, method: 'cash', receivedOn: today },
          label,
        ),
      ).toEqual({ ok: false, error: 'not_allowed' });
      expect(
        await payOutWallet(db, trainer, {
          memberId: ana,
          amountCents: 100,
          method: 'cash',
          receivedOn: today,
        }),
      ).toEqual({ ok: false, error: 'not_allowed' });

      // ── Online top-up: only the account's own records, within bounds.
      const outsider = await user('outsider_b2');
      expect(
        await startWalletCheckout(
          db,
          outsider,
          { id: clubId, slug },
          { memberId: ana, amountCents: 1000, label },
          back,
        ),
      ).toEqual({ ok: false, error: 'not_allowed' });
      expect(
        await startWalletCheckout(
          db,
          memberUser,
          { id: clubId, slug },
          { memberId, amountCents: 10, label },
          back,
        ),
      ).toEqual({ ok: false, error: 'amount_invalid' });

      // ── Desk money goes back before card money; the card refund is capped
      // by what is still on its top-up — never a refund the books refuse.
      const base = await credit(memberId);
      const online = await startWalletCheckout(
        db,
        memberUser,
        { id: clubId, slug },
        { memberId, amountCents: 1000, label },
        back,
      );
      if (!online.ok) throw new Error(online.error);
      expect(await fakeSettle(online.checkoutId, 'paid')).toBe(true);
      await topUpWallet(
        db,
        desk,
        { memberId, amountCents: 1000, method: 'cash', receivedOn: today },
        label,
      );
      expect(await payOut(memberId, 1500)).toEqual({ ok: true });
      const cardPayment = Number(
        (
          await db.execute(sql`
            SELECT p.id FROM club_payments p
              JOIN club_checkouts k ON k.club_id = p.club_id AND k.charge_id = p.charge_id
             WHERE k.id = ${online.checkoutId}::uuid AND p.kind = 'payment'`)
        ).rows[0]?.id,
      );
      // 1000 desk + 500 of the card's 1000 went back; 500 is left on the card.
      expect(await refundOnlinePayment(db, owner, cardPayment, 600)).toEqual({
        ok: false,
        error: 'amount_invalid',
      });
      expect(await refundOnlinePayment(db, owner, cardPayment, null)).toEqual({ ok: true });
      expect(await credit(memberId)).toBe(base);

      // ── The payments screen counts money received: credit spent is not new money.
      const ledger = await paymentLedger(owner, today.slice(0, 7), null);
      expect(ledger.totalCents).toBe(
        ledger.rows.filter((r) => r.method !== 'wallet').reduce((sum, r) => sum + r.amountCents, 0),
      );

      // ── Invoices: a 0 % line needs its basis; an invoiced charge is not
      // voided, reversed or refunded until its credit note.
      const zeroSale = await sell(ana, 'cash');
      if (!zeroSale.ok) throw new Error(zeroSale.error);
      const zeroCharge = String(
        (
          await db.execute(
            sql`SELECT charge_id FROM club_sales WHERE id = ${zeroSale.saleId}::uuid`,
          )
        ).rows[0]?.charge_id,
      );
      const person = {
        kind: 'person' as const,
        name: 'Ана',
        eik: null,
        vatNumber: null,
        address: 'София, ул. Клиентска 3',
      };
      // Every buyer has an address, a person too (the accountant, 2026-10-25).
      const buyerForm = (fields: Record<string, string>) => {
        const form = new FormData();
        for (const [name, value] of Object.entries(fields)) form.set(name, value);
        return parseInvoiceBuyer(form);
      };
      expect(buyerForm({ buyerKind: 'person', buyerName: 'Ана' })).toEqual({
        ok: false,
        errors: ['buyer_address_required'],
      });
      expect(
        buyerForm({ buyerKind: 'person', buyerName: 'Ана', buyerAddress: person.address }),
      ).toEqual({ ok: true, value: person });
      expect(await issueInvoice(db, owner, { chargeId: zeroCharge, buyer: person })).toEqual({
        ok: false,
        error: 'zero_vat_basis_missing',
      });
      expect(
        await saveInvoiceDetails(db, owner, {
          legalAddress: 'София, ул. Тест 1',
          vatNumber: 'BG123456789',
          iban: 'BG80BNBG96611020345678',
          invoiceVatBp: 2000,
          zeroVatBasis: 'чл. 45 от ЗДДС',
        }),
      ).toBe(true);
      const zeroInvoice = await issueInvoice(db, owner, { chargeId: zeroCharge, buyer: person });
      if (!zeroInvoice.ok) throw new Error(zeroInvoice.error);
      expect(await invoiceById(owner, zeroInvoice.invoiceId)).toMatchObject({
        vatCents: 0,
        zeroVatBasis: 'чл. 45 от ЗДДС',
      });
      expect(await reverseSale(db, owner, zeroSale.saleId)).toBe('invoice_live');
      expect(
        await recordPayment(db, owner, {
          chargeId: zeroCharge,
          kind: 'refund',
          amountCents: -200,
          method: 'cash',
          receivedOn: today,
        }),
      ).toEqual({ ok: false, error: 'invoice_live' });
      // The desk never issues or cancels invoices.
      expect(await issueCreditNote(db, desk, zeroInvoice.invoiceId, 'Отказ')).toEqual({
        ok: false,
        error: 'not_allowed',
      });

      // ── Credit is invoiced when it is LOADED: invoiced credit is paid back
      // by an owner or manager, with a credit note for exactly what leaves;
      // spent credit goes back only as credit; and credit never pays a charge
      // that has an invoice of its own.
      const anaInvoice = await issueInvoice(db, owner, { chargeId: anaTopUp, buyer: person });
      if (!anaInvoice.ok) throw new Error(anaInvoice.error);
      expect(await invoiceById(owner, anaInvoice.invoiceId)).toMatchObject({
        totalCents: 1000,
        paymentMethod: 'cash',
        buyer: { kind: 'person', address: 'София, ул. Клиентска 3' },
      });
      expect(await payOut(ana, 500)).toEqual({ ok: false, error: 'wallet_payout_invoiced' });
      expect(await payOut(ana, 5000)).toEqual({ ok: false, error: 'wallet_insufficient' });
      const ownerPayOut = (cents: number) =>
        payOutWallet(db, owner, {
          memberId: ana,
          amountCents: cents,
          method: 'cash',
          receivedOn: today,
        });
      expect(await ownerPayOut(300)).toEqual({ ok: true });
      expect(await invoiceById(owner, anaInvoice.invoiceId)).toMatchObject({
        creditedCents: 300,
        correctedBy: [expect.objectContaining({ number: expect.any(Number) })],
      });
      expect(await invoicesOwingCredit(owner)).toEqual([]);
      expect(await credit(ana)).toBe(700);
      const drink = String(
        (
          await db.execute(sql`
            INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on)
            VALUES (${clubId}::uuid, ${ana}::uuid, 'product', 'Напитка', 200, ${sofiaToday()}::date, ${sofiaToday()}::date)
            RETURNING id`)
        ).rows[0]?.id,
      );
      const pay = (cents: number, method: 'cash' | 'wallet') =>
        recordPayment(db, owner, {
          chargeId: drink,
          kind: cents < 0 ? 'refund' : 'payment',
          amountCents: cents,
          method,
          receivedOn: today,
        });
      expect(await pay(200, 'wallet')).toEqual({ ok: true });
      expect(await pay(-200, 'cash')).toEqual({ ok: false, error: 'refund_paid_by_credit' });
      expect(
        await refundPaid(db, owner, { chargeId: drink, method: 'cash', receivedOn: today }),
      ).toEqual({ ok: true });
      expect(await credit(ana)).toBe(700);
      // The balance, not what is loaded, bounds a pay-out: 700 loaded, 500 left.
      expect(await pay(200, 'wallet')).toEqual({ ok: true });
      expect(await payOut(ana, 600)).toEqual({ ok: false, error: 'wallet_insufficient' });
      // A sale paid partly with credit, partly refunded, reverses the way it
      // came: the credit back to the credit, never more money than was paid.
      const mixed = await recordTillSale(
        db,
        desk,
        {
          lines: [{ productId: water.productId, quantity: 2 }],
          memberId: ana,
          method: null,
          code: null,
          locationId: null,
        },
        (n) => `Продажба №${n}`,
      );
      if (!mixed.ok) throw new Error(mixed.error);
      const mixedCharge = String(
        (await db.execute(sql`SELECT charge_id FROM club_sales WHERE id = ${mixed.saleId}::uuid`))
          .rows[0]?.charge_id,
      );
      const payMixed = (cents: number, method: 'cash' | 'card_desk' | 'wallet') =>
        recordPayment(db, owner, {
          chargeId: mixedCharge,
          kind: cents < 0 ? 'refund' : 'payment',
          amountCents: cents,
          method,
          receivedOn: today,
        });
      expect(await payMixed(200, 'wallet')).toEqual({ ok: true });
      expect(await payMixed(200, 'card_desk')).toEqual({ ok: true });
      expect(await payMixed(-100, 'cash')).toEqual({ ok: true });
      expect(await credit(ana)).toBe(300);
      expect(await reverseSale(db, owner, mixed.saleId)).toBe('ok');
      expect(await credit(ana)).toBe(500);
      // A top-up is loaded only by its own paths.
      expect(
        await recordPayment(db, owner, {
          chargeId: anaTopUp,
          kind: 'payment',
          amountCents: 100,
          method: 'cash',
          receivedOn: today,
        }),
      ).toEqual({ ok: false, error: 'not_allowed' });
      const anaFee = String(
        (
          await db.execute(sql`
            INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on)
            VALUES (${clubId}::uuid, ${ana}::uuid, 'fee', 'Такса', 300, ${sofiaToday()}::date, ${sofiaToday()}::date)
            RETURNING id`)
        ).rows[0]?.id,
      );
      const feeInvoice = await issueInvoice(db, owner, { chargeId: anaFee, buyer: person });
      expect(feeInvoice.ok).toBe(true);
      expect(
        await recordPayment(db, owner, {
          chargeId: anaFee,
          kind: 'payment',
          amountCents: 300,
          method: 'wallet',
          receivedOn: today,
        }),
      ).toEqual({ ok: false, error: 'wallet_invoiced' });
      expect(await credit(ana)).toBe(500);
      // Money the provider gives back after an invoice is a fact; the office
      // is told the credit note is owed.
      const factSale = await sell(ana, 'cash');
      if (!factSale.ok) throw new Error(factSale.error);
      const factCharge = String(
        (
          await db.execute(
            sql`SELECT charge_id FROM club_sales WHERE id = ${factSale.saleId}::uuid`,
          )
        ).rows[0]?.charge_id,
      );
      const factInvoice = await issueInvoice(db, owner, { chargeId: factCharge, buyer: person });
      if (!factInvoice.ok) throw new Error(factInvoice.error);
      await db.execute(sql`
        INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                   provider, provider_ref, received_on)
        VALUES (${clubId}::uuid, ${factCharge}::uuid, ${ana}::uuid, 'refund', -150, 'card_online',
                'fake', 'fake_re_owing_1', current_date)`);
      expect(await invoicesOwingCredit(owner)).toEqual([
        expect.objectContaining({ id: factInvoice.invoiceId, uncoveredCents: 150 }),
      ]);
      // A one-line invoice is corrected by exactly the money given back.
      expect(
        await issueCreditNote(db, owner, factInvoice.invoiceId, 'Възстановено', {
          amountCents: 150,
        }),
      ).toMatchObject({ ok: true });
      expect(await invoiceById(owner, factInvoice.invoiceId)).toMatchObject({
        creditedCents: 150,
      });
      expect(await invoicesOwingCredit(owner)).toEqual([]);
      // One pay-out across two invoiced top-ups corrects both invoices.
      const boyko = await newClient('Бойко Кредит');
      expect(await top(boyko, 1000)).toEqual({ ok: true });
      expect(await top(boyko, 1000)).toEqual({ ok: true });
      const boykoTopUps = (
        await db.execute(sql`
          SELECT id FROM club_charges WHERE member_id = ${boyko}::uuid AND kind = 'wallet'
           ORDER BY created_at`)
      ).rows.map((row) => String(row.id));
      const boykoInvoices: string[] = [];
      for (const chargeId of boykoTopUps) {
        const issued = await issueInvoice(db, owner, { chargeId, buyer: person });
        if (!issued.ok) throw new Error(issued.error);
        boykoInvoices.push(issued.invoiceId);
      }
      expect(
        await payOutWallet(db, owner, {
          memberId: boyko,
          amountCents: 1500,
          method: 'cash',
          receivedOn: today,
        }),
      ).toEqual({ ok: true });
      const boykoCredited = await Promise.all(
        boykoInvoices.map(async (id) => (await invoiceById(owner, id))?.creditedCents),
      );
      expect([...boykoCredited].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([500, 1000]);
      expect(await credit(boyko)).toBe(500);
      expect(await invoicesOwingCredit(owner)).toEqual([]);
      // A refund made in Stripe on the half-paid-out top-up: its invoice is
      // corrected by exactly that, once — a repeated form finds nothing left —
      // and the rest of the credit is still paid out with its own note.
      const halfIndex = boykoCredited.indexOf(500);
      const halfInvoice = boykoInvoices[halfIndex] ?? '';
      const halfTopUp = boykoTopUps[halfIndex] ?? '';
      await db.execute(sql`
        INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                   provider, provider_ref, received_on)
        VALUES (${clubId}::uuid, ${halfTopUp}::uuid, ${boyko}::uuid, 'refund', -200, 'card_online',
                'fake', 'fake_re_owing_2', current_date)`);
      expect(await invoicesOwingCredit(owner)).toEqual([
        expect.objectContaining({ id: halfInvoice, uncoveredCents: 200 }),
      ]);
      const stripeNote = () =>
        issueCreditNote(db, owner, halfInvoice, 'Възстановено в Stripe', { amountCents: 200 });
      expect(await stripeNote()).toMatchObject({ ok: true });
      expect(await stripeNote()).toEqual({ ok: false, error: 'already_credited' });
      expect(await credit(boyko)).toBe(300);
      expect(
        await payOutWallet(db, owner, {
          memberId: boyko,
          amountCents: 300,
          method: 'cash',
          receivedOn: today,
        }),
      ).toEqual({ ok: true });
      expect(await invoiceById(owner, halfInvoice)).toMatchObject({ creditedCents: 1000 });
      expect(await invoicesOwingCredit(owner)).toEqual([]);

      // ── A downgraded club: no new credit, but the client's money still goes
      // back, the record can then be erased, and an invoice can be corrected.
      await db.execute(sql`UPDATE clubs SET tier = 'community' WHERE id = ${clubId}::uuid`);
      try {
        expect(await top(ana, 500)).toEqual({ ok: false, error: 'feature_unavailable' });
        const otherSale = await sell(ana, 'wallet');
        expect(otherSale.ok).toBe(false);
        expect(await credit(ana)).toBe(500);
        expect(await issueCreditNote(db, owner, zeroInvoice.invoiceId, 'Отказ')).toMatchObject({
          ok: true,
        });
        // The invoiced credit still goes back, its credit note with it; the
        // 200 that was used stays declared.
        expect(await ownerPayOut(500)).toEqual({ ok: true });
        expect(await credit(ana)).toBe(0);
        expect(await invoiceById(owner, anaInvoice.invoiceId)).toMatchObject({
          creditedCents: 800,
        });
        // What is left of a corrected invoice is cancelled as one line.
        expect(
          await issueCreditNote(db, owner, anaInvoice.invoiceId, 'Анулиране на остатъка'),
        ).toMatchObject({ ok: true });
        expect(await invoiceById(owner, anaInvoice.invoiceId)).toMatchObject({
          creditedCents: 1000,
        });
      } finally {
        await db.execute(sql`UPDATE clubs SET tier = 'standard' WHERE id = ${clubId}::uuid`);
      }
      // Credited, the sale reverses.
      expect(await reverseSale(db, owner, zeroSale.saleId)).toBe('ok');

      // ── Another club's charge is not this club's to invoice.
      const foreignCharge = String(
        (
          await db.execute(sql`
            INSERT INTO club_charges (club_id, kind, label, amount_cents, issued_on, due_on)
            SELECT id, 'other', 'Чужда', 1000, current_date, current_date
              FROM clubs WHERE slug LIKE 'e2e-jr-b-%' LIMIT 1
            RETURNING id`)
        ).rows[0]?.id,
      );
      expect(await issueInvoice(db, owner, { chargeId: foreignCharge, buyer: person })).toEqual({
        ok: false,
        error: 'not_allowed',
      });
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
    expect(await eraseMember(db, desk, childId)).toBe('not_found');
    expect(await eraseMember(db, owner, childId)).toBe('ok');
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
