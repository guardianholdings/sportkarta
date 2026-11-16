import { randomUUID } from 'node:crypto';

import {
  clubMonthFigures,
  clubWeekFigures,
  getDb,
  getPool,
  materializeClubClasses,
  sql,
} from '@sportkarta/db';
import { addDaysIso, isoWeekKey, isoWeekMonday, sofiaToday } from '@sportkarta/lib/clubs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { approveClub } from '@/lib/clubs/admin';
import { applyForClub } from '@/lib/clubs/apply';
import { bookAtDesk } from '@/lib/clubs/bookings';
import { dashboardData } from '@/lib/clubs/dashboard';
import type { ClassInput } from '@/lib/clubs/input';
import { createMember } from '@/lib/clubs/members';
import { portalView } from '@/lib/clubs/portal';
import { savePromotion } from '@/lib/clubs/promotions';
import { activeByMonth } from '@/lib/clubs/reports';
import {
  cancelMembership,
  openCharges,
  paidCharge,
  paymentLedger,
  recordPayment,
  savePlan,
  sellMembership,
  setMembershipRenewal,
} from '@/lib/clubs/sales';
import {
  ClassCapacityTaken,
  saveClass,
  weekOccurrences,
  type ClassSaveReport,
} from '@/lib/clubs/schedule';
import type { ClubActor } from '@/lib/clubs/scope';
import { saveLocation } from '@/lib/clubs/settings';
import { memberWallet, topUpWallet } from '@/lib/clubs/wallet';

import { hasDb } from './db';

vi.mock('server-only', () => ({}));

/**
 * The desk's money and seats, as the 2026-11-14 audit of the «Клубове» module
 * found them wrong — each case below failed before its fix:
 *
 *   - a second sale of a plan the client already holds on auto-renewal started
 *     a second chain, billed every period from then on;
 *   - a period that renews by itself sat under «Изтичащи абонаменти» with a
 *     «Поднови» button beside it (which is how that second sale happened);
 *   - a start date with a mistyped year sold a membership already over;
 *   - a charge paid in full could not be chosen in the payment form, so it
 *     could never be refunded;
 *   - a membership the client cancelled vanished from the month it was valid in;
 *   - fewer places on a class moved confirmed people to the waiting list, and
 *     more places seated the waiting ones with nobody told;
 *   - a typed voucher that merely lost to a better automatic offer was refused
 *     as «used up»;
 *   - one top-up form sent twice at the same moment loaded the credit twice.
 *
 * It COMMITS, like ./clubs.test.ts (the readers take the shared pool): every
 * row hangs off one `e2e-ad-*` club and `e2e_club_ad_*` accounts, removed in
 * afterAll through the purge path.
 */

const PREFIX = 'e2e_club_ad_';

const PLAN = {
  nameEn: null,
  descriptionBg: null,
  descriptionEn: null,
  kind: 'unlimited',
  audience: 'all',
  validityDays: null,
  validityMonths: 1,
  visitsCount: null,
  visibility: 'public',
  minTermMonths: null,
  noticeDays: 0,
  selfPauseAllowed: false,
  selfCancelAllowed: false,
} as const;

async function user(label: string, role: 'user' | 'admin' = 'user'): Promise<string> {
  const id = `${PREFIX}${label}_${Math.random().toString(36).slice(2, 8)}`;
  await getDb().execute(sql`
    INSERT INTO users (id, display_name, email, email_verified, role)
    VALUES (${id}, ${`Audit ${label}`}, ${`${id}@example.org`}, true, ${role}::user_role)
  `);
  return id;
}

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-ad-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
}

describe.skipIf(!hasDb)('club desk audit fixes (requires running database)', () => {
  let db: ReturnType<typeof getDb>;
  let clubId = '';
  let owner: ClubActor;
  let locationId = '';
  let renewingPlan = '';
  let plainPlan = '';
  const today = sofiaToday();

  async function member(name: string): Promise<string> {
    const created = await createMember(db, owner, {
      displayName: name,
      email: null,
      phone: null,
      isMinor: false,
      guardianMemberId: null,
      tags: [],
      staffNote: null,
    });
    if (!created.ok) throw new Error(`member ${name}`);
    return created.memberId;
  }

  const sell = (memberId: string, planId: string, startsOn = today, pay = true) =>
    sellMembership(db, owner, {
      memberId,
      planId,
      startsOn,
      dueOn: addDaysIso(today, 7),
      payment: pay ? { method: 'cash', amountCents: null, receivedOn: today } : null,
    });

  beforeAll(async () => {
    db = getDb();
    await cleanup();
    const ownerId = await user('owner');
    const applied = await applyForClub(db, ownerId, {
      nameBg: `E2E AD ${Math.random().toString(36).slice(2, 6)}`,
      kind: 'gym',
      tier: 'standard',
      municipalityId: null,
      sports: ['yoga'],
      websiteUrl: null,
      descriptionBg: null,
    });
    if (!applied.ok) throw new Error('apply');
    clubId = applied.clubId;
    await db.execute(
      sql`UPDATE clubs SET slug = ${`e2e-ad-${applied.slug}`.slice(0, 60)} WHERE id = ${clubId}::uuid`,
    );
    expect(await approveClub(db, await user('admin', 'admin'), clubId)).toBe(true);
    owner = { userId: ownerId, clubId, role: 'owner', ngoAdmin: false };
    locationId =
      (await saveLocation(db, owner, null, {
        name: 'Зала',
        facilityId: null,
        address: 'ул. Одит 1',
      })) ?? '';
    renewingPlan =
      (await savePlan(db, owner, null, {
        ...PLAN,
        nameBg: 'Месечен с подновяване',
        priceCents: 5000,
        autoRenew: true,
      })) ?? '';
    plainPlan =
      (await savePlan(db, owner, null, {
        ...PLAN,
        nameBg: 'Месечен',
        priceCents: 4000,
        autoRenew: false,
      })) ?? '';
    expect(locationId && renewingPlan && plainPlan).not.toBe('');
  });

  afterAll(async () => {
    await cleanup();
    await getPool().end();
  });

  it('refuses a second sale of a plan the client already holds on auto-renewal', async () => {
    const client = await member('Клиент с подновяване');
    const first = await sell(client, renewingPlan);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // The renewals job will add the next period itself: a second sale would
    // start a second chain and bill every period twice.
    expect(await sell(client, renewingPlan)).toEqual({ ok: false, error: 'already_renewing' });
    // Another plan is the desk's call, and still sells.
    expect((await sell(client, plainPlan)).ok).toBe(true);
    // Once the renewal is stopped, the plan can be sold again.
    expect(await setMembershipRenewal(db, owner, first.membershipId, false)).toBe(true);
    expect((await sell(client, renewingPlan)).ok).toBe(true);
    const chains = await db.execute(sql`
      SELECT count(*)::int AS n FROM club_memberships
       WHERE member_id = ${client}::uuid AND plan_id = ${renewingPlan}::uuid AND renews
    `);
    expect(chains.rows[0]?.n).toBe(1);
  });

  it('does not list a period that renews by itself as expiring', async () => {
    const renewing = await member('Подновява се сам');
    const ending = await member('Изтича наистина');
    // One month from 27 days ago: both end within the dashboard's 7 days.
    const started = addDaysIso(today, -27);
    // The owner's Monday mail, sent today for the week that began 7 days ago,
    // counts what ends in the coming week.
    const nextWeek = async () =>
      (await clubWeekFigures(db, addDaysIso(today, -7))).find((f) => f.clubId === clubId)
        ?.expiringNextWeek ?? 0;
    const before = await nextWeek();
    expect((await sell(renewing, renewingPlan, started)).ok).toBe(true);
    expect((await sell(ending, plainPlan, started)).ok).toBe(true);
    const data = await dashboardData(owner);
    const names = data.expiring.map((row) => row.memberName);
    expect(names).toContain('Изтича наистина');
    expect(names).not.toContain('Подновява се сам');
    expect(data.expiringCount).toBe(data.expiring.length);
    // Two periods end next week; one of them renews itself.
    expect(await nextWeek()).toBe(before + 1);
  });

  it('refuses a sale whose period is over before it is sold', async () => {
    const client = await member('Сбъркана година');
    expect(await sell(client, plainPlan, addDaysIso(today, -365))).toEqual({
      ok: false,
      error: 'starts_on_invalid',
    });
    // Entered late but still running: that is an honest back-dated sale.
    expect((await sell(client, plainPlan, addDaysIso(today, -10))).ok).toBe(true);
  });

  it('lets the desk refund a charge that is paid in full', async () => {
    const client = await member('Платил по грешка');
    const sale = await sell(client, plainPlan);
    expect(sale.ok).toBe(true);
    if (!sale.ok || !sale.chargeId) return;
    // Paid, so not owed — the payment form's usual list does not have it.
    expect(await openCharges(owner, { memberId: client })).toEqual([]);
    const paid = await paidCharge(owner, sale.chargeId);
    expect(paid).toMatchObject({ id: sale.chargeId, paidCents: 4000, status: 'paid' });
    expect(
      await recordPayment(db, owner, {
        chargeId: sale.chargeId,
        kind: 'refund',
        method: 'cash',
        amountCents: -4000,
        receivedOn: today,
      }),
    ).toEqual({ ok: true });
    // Nothing is on it any more: nothing left to give back.
    expect(await paidCharge(owner, sale.chargeId)).toBeNull();
    // The month's sums come from the database and net the refund.
    const ledger = await paymentLedger(owner, today.slice(0, 7), null);
    const check = await db.execute(sql`
      SELECT coalesce(sum(amount_cents), 0)::int AS total FROM club_payments
       WHERE club_id = ${clubId}::uuid AND method <> 'wallet'
         AND to_char(received_on, 'YYYY-MM') = ${today.slice(0, 7)}
    `);
    expect(ledger.totalCents).toBe(Number(check.rows[0]?.total));
    expect(ledger.byMethod.cash).toBe(ledger.totalCents);
    // Someone outside the club reads nothing.
    const stranger: ClubActor = { ...owner, userId: await user('stranger'), role: null };
    expect(await paidCharge(stranger, sale.chargeId)).toBeNull();
  });

  it('counts a membership the client cancelled in the month it was valid', async () => {
    const thisMonth = async () => (await activeByMonth(owner)).at(-1)?.value ?? 0;
    // The owner's monthly mail reads the same rule (db/src/clubs/validity.ts).
    const mailed = async () =>
      (await clubMonthFigures(db, `${today.slice(0, 7)}-01`)).find((f) => f.clubId === clubId)
        ?.members[0] ?? 0;
    const before = await thisMonth();
    const mailedBefore = await mailed();
    const left = await member('Напусна');
    const wrong = await member('Грешна продажба');
    const a = await sell(left, plainPlan, today, false);
    const b = await sell(wrong, plainPlan, today, false);
    if (!a.ok || !b.ok) throw new Error('sale');
    expect(await thisMonth()).toBe(before + 2);
    expect(await cancelMembership(db, owner, a.membershipId, 'member_request')).toBe(true);
    expect(await cancelMembership(db, owner, b.membershipId, 'mistake')).toBe(true);
    // The one who left was a member this month; the mistake never was.
    expect(await thisMonth()).toBe(before + 1);
    expect(await mailed()).toBe(mailedBefore + 1);
  });

  it('never moves a confirmed place to the waiting list, and reports who moved up', async () => {
    const tomorrow = addDaysIso(today, 1);
    const weekday = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][
      (new Date(`${tomorrow}T12:00:00Z`).getUTCDay() + 6) % 7
    ] as string;
    const input: ClassInput = {
      title: 'Одит йога',
      description: null,
      sport: 'yoga',
      locationId,
      instructorUserId: null,
      resourceId: null,
      startsAtLocal: `${tomorrow} 08:00:00`,
      rrule: `FREQ=WEEKLY;BYDAY=${weekday}`,
      durationMinutes: 60,
      capacity: 2,
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
    };
    const classId = (await saveClass(db, owner, null, input)) ?? '';
    expect(classId).not.toBe('');
    await materializeClubClasses(getPool(), { classId });
    const monday = isoWeekMonday(isoWeekKey(tomorrow)) ?? tomorrow;
    const occurrence = (await weekOccurrences(owner, monday, null)).find(
      (o) => o.localStart === `${tomorrow} 08:00` && o.title === 'Одит йога',
    );
    expect(occurrence).toBeDefined();
    const seats = [];
    for (const name of ['Първи', 'Втори', 'Трети']) {
      seats.push(await bookAtDesk(db, owner, occurrence?.id ?? '', await member(name)));
    }
    expect(seats.map((s) => (s.ok ? s.status : s.error))).toEqual(['going', 'going', 'waitlisted']);
    // One place for two people going: refused, and nothing changes.
    await expect(saveClass(db, owner, classId, { ...input, capacity: 1 })).rejects.toBeInstanceOf(
      ClassCapacityTaken,
    );
    const still = await db.execute(
      sql`SELECT capacity FROM club_classes WHERE id = ${classId}::uuid`,
    );
    expect(still.rows[0]?.capacity).toBe(2);
    // A third place seats the one who was waiting — and says who.
    const report: ClassSaveReport = { promoted: [] };
    expect(await saveClass(db, owner, classId, { ...input, capacity: 3 }, report)).toBe(classId);
    const third = seats[2];
    expect(report.promoted).toEqual(third?.ok ? [third.bookingId] : []);
    // Saving again with nothing changed moves nobody.
    const quiet: ClassSaveReport = { promoted: [] };
    await saveClass(db, owner, classId, { ...input, capacity: 3 }, quiet);
    expect(quiet.promoted).toEqual([]);
  });

  it('sells with the better automatic offer when a typed voucher loses to it', async () => {
    const offer = { targetIds: null, startsOn: today, endsOn: null, minVisits90d: null } as const;
    const auto = await savePromotion(db, owner, null, {
      ...offer,
      name: 'Нови клиенти',
      code: null,
      kind: 'percent',
      value: 3000,
      target: 'all',
      maxUses: null,
      perMemberMax: null,
      newMembersOnly: true,
    });
    const voucher = await savePromotion(db, owner, null, {
      ...offer,
      name: 'Ваучер',
      code: 'AUD-0001',
      kind: 'amount',
      value: 200,
      target: 'all',
      maxUses: 5,
      perMemberMax: null,
      newMembersOnly: false,
    });
    expect(auto.ok && voucher.ok).toBe(true);
    const client = await member('Нов с ваучер');
    const sale = await sellMembership(db, owner, {
      memberId: client,
      planId: plainPlan,
      startsOn: today,
      dueOn: addDaysIso(today, 7),
      payment: null,
      code: 'AUD-0001',
    });
    // 30% of 40,00 € beats 2,00 €: the sale goes through at the better price,
    // and the voucher — which nobody used — is not reported as used up.
    expect(sale.ok).toBe(true);
    const price = await db.execute(sql`
      SELECT price_cents FROM club_memberships WHERE member_id = ${client}::uuid
    `);
    expect(price.rows[0]?.price_cents).toBe(2800);
  });

  it('shows the portal the true state of club mail', async () => {
    const slug = String(
      (await db.execute(sql`SELECT slug FROM clubs WHERE id = ${clubId}::uuid`)).rows[0]?.slug,
    );
    // A linked member who used the one-click link in an old mail gets no club
    // mail (db/src/clubs/mail.ts reads both switches) — so the portal must
    // show «off», not a switch that lies; turning it on there lifts the opt-out.
    const viewer = await member('Отписал се с линк');
    const viewerUser = await user('viewer');
    await db.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method, notify_email)
      VALUES (${viewer}::uuid, ${clubId}::uuid, ${viewerUser}, 'active', 'invite', true)
    `);
    expect((await portalView(viewerUser, slug, 'bg'))?.link?.notifyEmail).toBe(true);
    await db.execute(
      sql`UPDATE club_members SET email_opt_out_at = now() WHERE id = ${viewer}::uuid`,
    );
    expect((await portalView(viewerUser, slug, 'bg'))?.link?.notifyEmail).toBe(false);
  });

  it('loads credit once when one top-up form arrives twice at the same moment', async () => {
    const client = await member('Двоен клик');
    const load = (nonce: string) =>
      topUpWallet(
        db,
        owner,
        { memberId: client, amountCents: 2000, method: 'cash', receivedOn: today, nonce },
        'Кредит',
      );
    // Two connections open and idle first, so the two forms really are in
    // flight together (a cold second connection would arrive after the first
    // form had finished, and the test would prove nothing).
    await Promise.all([
      db.execute(sql`SELECT pg_sleep(0.05)`),
      db.execute(sql`SELECT pg_sleep(0.05)`),
    ]);
    for (let round = 0; round < 5; round += 1) {
      const nonce = randomUUID();
      const results = await Promise.all([load(nonce), load(nonce)]);
      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect((await memberWallet(owner, client)).balanceCents).toBe(2000 * (round + 1));
    }
  });
});
