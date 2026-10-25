import 'server-only';

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  applyCheckoutPaid,
  getDb,
  recordProviderRefund,
  sql,
  subscriptionRefsFor,
  type SQL,
} from '@sportkarta/db';
import { addDaysIso, isIsoDate, sofiaToday, type IsoDate } from '@sportkarta/lib/clubs';
import { zonedToDate } from '@sportkarta/lib/recurrence';
import {
  applicationFeeCents,
  createStripeClient,
  resolvePaymentProvider,
  stripeSettings,
  type PaymentProviderKind,
} from '@sportkarta/lib/payments';

import { resolveAuthSecret } from '../auth-config';
import { siteUrl } from '../seo';

import { clubWritableGuard } from './access';
import { recordClubAudit } from './audit';
import { ensureSelfRecord } from './bookings';
import { voidCharge } from './sales';
import { violatedConstraint } from './errors';
import { clubSwitchOn } from './features';
import { clubActorMay, clubScope, clubWriteScope, memberSelfScope, type ClubActor } from './scope';

/**
 * Online payments for a club (0046; operator decision 2026-10-25): the
 * club's OWN Stripe account, Stripe's HOSTED Checkout reached by redirect,
 * money straight to the club. This module starts things; the worker finishes
 * them, from webhooks it verifies and objects it re-fetches.
 *
 *   connect     an owner/manager links the club's Stripe account (Connect
 *               OAuth; a signed state ties the callback to this club and
 *               this person), or disconnects it;
 *   checkout    a member pays an open charge, or buys a public plan from a
 *               start date — as a one-off payment, or as a Stripe
 *               subscription when the plan renews by calendar months;
 *   refund      the office refunds an online payment through the provider,
 *               and the negative row is recorded at once (the webhook's
 *               copy is then a no-op).
 *
 * WHAT IS NEVER HERE: card data, a payment script, a Stripe key in a client
 * bundle, an amount taken from a form (the server computes every amount).
 *
 * THE FAKE PROVIDER (development and e2e, never production —
 * resolvePaymentProvider): Checkout is /dev/plashtane/<checkoutId>, whose
 * buttons call `fakeSettle` — the same `applyCheckoutPaid` the worker calls.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/** Stripe's minimum charge in EUR. */
export const MIN_ONLINE_CENTS = 50;

export function paymentProvider(): PaymentProviderKind {
  return resolvePaymentProvider(process.env);
}

/** The operator's switch AND a working provider. */
export function paymentsReady(): boolean {
  return clubSwitchOn('payments') && paymentProvider() !== 'disabled';
}

function stripe() {
  const settings = stripeSettings(process.env);
  if (!settings) throw new Error('stripe is not configured');
  return { client: createStripeClient({ secretKey: settings.secretKey }), settings };
}

export interface ClubPaymentAccount {
  provider: 'stripe' | 'fake';
  accountRef: string;
  chargesEnabled: boolean;
  connectedAt: string;
}

export async function clubPaymentAccount(clubId: string): Promise<ClubPaymentAccount | null> {
  const row = (
    await getDb().execute(sql`
      SELECT provider, account_ref, charges_enabled, connected_at FROM club_payment_accounts
       WHERE club_id = ${clubId}::uuid AND disconnected_at IS NULL
    `)
  ).rows[0];
  if (!row) return null;
  return {
    provider: row.provider === 'fake' ? 'fake' : 'stripe',
    accountRef: String(row.account_ref),
    chargesEnabled: row.charges_enabled === true,
    connectedAt: new Date(String(row.connected_at)).toISOString(),
  };
}

// ─── Connect ───────────────────────────────────────────────────────────────

const STATE_LABEL = 'pops/club-connect/v1';
const STATE_TTL_MS = 30 * 60 * 1000;

function stateKey(): Buffer {
  const secret = resolveAuthSecret(process.env);
  if (!secret) throw new Error('no auth secret');
  return createHmac('sha256', secret).update(STATE_LABEL).digest();
}

/** `<clubId>.<userId>.<issuedMs>.<sig>` — the OAuth `state` parameter. */
export function signConnectState(clubId: string, userId: string, now = Date.now()): string {
  const payload = `${clubId}.${userId}.${String(now)}`;
  return `${payload}.${createHmac('sha256', stateKey()).update(payload).digest('base64url')}`;
}

export function verifyConnectState(
  state: string,
  now = Date.now(),
): { clubId: string; userId: string } | null {
  const parts = state.split('.');
  if (parts.length !== 4) return null;
  const [clubId, userId, issued, signature] = parts as [string, string, string, string];
  const expected = Buffer.from(
    createHmac('sha256', stateKey()).update(`${clubId}.${userId}.${issued}`).digest('base64url'),
  );
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const at = Number(issued);
  if (!Number.isFinite(at) || now - at > STATE_TTL_MS || at > now + 60_000) return null;
  return { clubId, userId };
}

/** Where «Свържете Stripe» sends the owner; null for the fake provider. */
export function connectStartUrl(actor: ClubActor): string | null {
  if (paymentProvider() !== 'stripe') return null;
  const { settings } = stripe();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: settings.connectClientId,
    scope: 'read_write',
    state: signConnectState(actor.clubId, actor.userId),
    redirect_uri: `${siteUrl()}/api/clubs/stripe/connect`,
  });
  return `https://connect.stripe.com/oauth/authorize?${params.toString()}`;
}

/**
 * Record the club's connected account (a reconnect replaces the live one).
 * settings.manage, on a writable club, in the statement.
 */
export async function connectAccount(
  db: TransactionalDb,
  actor: ClubActor,
  account: { provider: 'stripe' | 'fake'; accountRef: string; chargesEnabled: boolean },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE club_payment_accounts a SET disconnected_at = now(), charges_enabled = false
       WHERE a.club_id = ${actor.clubId}::uuid AND a.disconnected_at IS NULL
         AND ${clubActorMay(actor, 'settings.manage', { write: true })}
    `);
    const inserted = await tx.execute(sql`
      INSERT INTO club_payment_accounts (club_id, provider, account_ref, charges_enabled, connected_by)
      SELECT ${actor.clubId}::uuid, ${account.provider}, ${account.accountRef},
             ${account.chargesEnabled}, ${actor.userId}
       WHERE ${clubActorMay(actor, 'settings.manage', { write: true })}
      RETURNING id
    `);
    if (inserted.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'payment_account_connected',
      detail: { provider: account.provider },
    });
    return true;
  });
}

export type DisconnectResult = 'ok' | 'not_allowed' | 'subscriptions_live';

/**
 * Disconnect the club's Stripe account. Refused while members hold renewing
 * subscriptions on it: after a disconnect the platform hears nothing from that
 * account, so Stripe would keep billing cards for periods nobody records, and
 * those members could never be cancelled or erased from here (the 0046
 * review). Open checkouts are closed at Stripe first.
 */
export async function disconnectAccount(
  db: TransactionalDb,
  actor: ClubActor,
): Promise<DisconnectResult> {
  const live = await clubPaymentAccount(actor.clubId);
  if (!live) return 'not_allowed';
  const subscriptions = (await subscriptionRefsFor(getDb(), actor.clubId, { club: true })).filter(
    (s) => s.reachable && s.accountRef === live.accountRef,
  );
  if (subscriptions.length > 0) return 'subscriptions_live';
  await closeOpenCheckouts(actor.clubId, null);
  const done = await db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_payment_accounts a SET disconnected_at = now(), charges_enabled = false
       WHERE a.club_id = ${actor.clubId}::uuid AND a.disconnected_at IS NULL
         AND ${clubActorMay(actor, 'settings.manage', { write: true })}
      RETURNING a.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'payment_account_disconnected',
      detail: { provider: live.provider },
    });
    return true;
  });
  // Let go at Stripe too — after our own row, so a Stripe outage cannot keep
  // the club connected here. account.application.deauthorized follows.
  if (done && live.provider === 'stripe' && paymentProvider() === 'stripe') {
    const { client, settings } = stripe();
    await client.oauthDeauthorize(settings.connectClientId, live.accountRef).catch(() => undefined);
  }
  return done ? 'ok' : 'not_allowed';
}

/**
 * Close a club's open checkouts (all, or one member's) where the provider
 * confirms they can no longer be paid — before the member is erased or the
 * account disconnected. A session already paid stays open for its event; if
 * it then cannot be applied it lands as `unapplied` (and its subscription is
 * cancelled by the worker), never lost.
 */
export async function closeOpenCheckouts(clubId: string, memberId: string | null): Promise<void> {
  const open = await getDb().execute(sql`
    SELECT id, provider, session_ref, account_ref FROM club_checkouts
     WHERE club_id = ${clubId}::uuid AND status = 'open'
       AND ${memberId === null ? sql`true` : sql`member_id = ${memberId}::uuid`}
  `);
  for (const row of open.rows) {
    await closePrevious({
      id: String(row.id),
      provider: String(row.provider),
      sessionRef: text(row.session_ref),
      accountRef: String(row.account_ref),
    });
  }
}

// ─── Checkout ──────────────────────────────────────────────────────────────

export type CheckoutStart =
  | { ok: true; url: string; checkoutId: string }
  | {
      ok: false;
      error:
        | 'unavailable'
        | 'not_allowed'
        | 'too_small'
        | 'claim_first'
        | 'link_pending'
        | 'audience_mismatch'
        | 'provider_error'
        /** An earlier attempt is paid at the provider and still being applied. */
        | 'in_progress'
        /** The member already has a renewing abonnement; stop it first. */
        | 'already_renewing'
        | 'member_cap'
        | 'terms_required';
    };

export interface Return {
  /** Absolute site base with the locale prefix, e.g. https://pops.bg or …/en. */
  base: string;
  locale: 'bg' | 'en';
}

async function liveAccount(clubId: string): Promise<ClubPaymentAccount | null> {
  if (!paymentsReady()) return null;
  const account = await clubPaymentAccount(clubId);
  if (!account || !account.chargesEnabled) return null;
  if (account.provider !== paymentProvider()) return null;
  return account;
}

/** Whether members of this club can pay online right now (what the buttons ask). */
export async function clubTakesPayments(clubId: string): Promise<boolean> {
  return (await liveAccount(clubId)) !== null;
}

/** Where the provider sends the member back: the site, in the member's locale. */
export function checkoutReturn(locale: string): Return {
  return locale === 'en'
    ? { base: `${siteUrl()}/en`, locale: 'en' }
    : { base: siteUrl(), locale: 'bg' };
}

/**
 * Create the provider's session for a checkout row that already exists, and
 * store its reference. The row's id is the Idempotency-Key, so a retried call
 * returns the same session.
 */
async function openSession(
  db: SqlRunner,
  input: {
    checkoutId: string;
    clubId: string;
    clubSlug: string;
    account: ClubPaymentAccount;
    label: string;
    amountCents: number;
    subscriptionMonths: number | null;
    email: string | null;
    back: Return;
  },
): Promise<string | null> {
  const success = `${input.back.base}/klub/${input.clubSlug}/az/plashtane/${input.checkoutId}`;
  if (input.account.provider === 'fake') {
    await db.execute(sql`
      UPDATE club_checkouts SET session_ref = ${`fake_cs_${input.checkoutId}`}
       WHERE id = ${input.checkoutId}::uuid
    `);
    // Relative: the stand-in is this same server, whatever SITE_URL says.
    return `${input.back.locale === 'en' ? '/en' : ''}/dev/plashtane/${input.checkoutId}`;
  }
  const { client, settings } = stripe();
  const fee = applicationFeeCents(input.amountCents, settings.applicationFeeBp);
  const subscription = input.subscriptionMonths !== null;
  const session = await client.createCheckoutSession(
    {
      mode: subscription ? 'subscription' : 'payment',
      client_reference_id: input.checkoutId,
      success_url: success,
      cancel_url: `${input.back.base}/klub/${input.clubSlug}/az?rezultat=payment_cancelled`,
      locale: input.back.locale,
      customer_email: input.email ?? undefined,
      metadata: { checkout: input.checkoutId },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: input.amountCents,
            product_data: { name: input.label.slice(0, 120) },
            ...(subscription
              ? { recurring: { interval: 'month', interval_count: input.subscriptionMonths } }
              : {}),
          },
        },
      ],
      ...(subscription
        ? {
            subscription_data: {
              metadata: { checkout: input.checkoutId },
              ...(settings.applicationFeeBp > 0
                ? { application_fee_percent: settings.applicationFeeBp / 100 }
                : {}),
            },
          }
        : {
            payment_intent_data: {
              metadata: { checkout: input.checkoutId },
              ...(fee > 0 ? { application_fee_amount: fee } : {}),
            },
          }),
    },
    { account: input.account.accountRef, idempotencyKey: `checkout:${input.checkoutId}` },
  );
  if (!session.url) return null;
  await db.execute(sql`
    UPDATE club_checkouts SET session_ref = ${session.id} WHERE id = ${input.checkoutId}::uuid
  `);
  return session.url;
}

async function verifiedEmail(db: SqlRunner, userId: string): Promise<string | null> {
  const row = (
    await db.execute(sql`
      SELECT CASE WHEN email_verified THEN email END AS email FROM users WHERE id = ${userId}
    `)
  ).rows[0];
  return text(row?.email);
}

/**
 * Close the open checkout for a charge before a new one replaces it — but
 * only once the PROVIDER confirms it can no longer be paid. A session the
 * member already completed (paid, not yet applied — or an async method still
 * processing) is left open for its event to apply, and the new attempt is
 * refused; marking it expired here would drop a real payment (the 0046
 * review). A provider error also refuses: the session might still be payable.
 */
async function closePrevious(previous: {
  id: string;
  provider: string;
  sessionRef: string | null;
  accountRef: string;
}): Promise<'closed' | 'in_progress' | 'provider_error'> {
  if (previous.provider === 'stripe' && previous.sessionRef) {
    if (paymentProvider() !== 'stripe') return 'provider_error';
    try {
      const { client } = stripe();
      const options = { account: previous.accountRef };
      const session = await client.retrieveCheckoutSession(previous.sessionRef, options);
      if (session.status === 'complete') return 'in_progress';
      if (session.status === 'open') {
        const expired = await client.expireCheckoutSession(previous.sessionRef, options);
        if (expired.status !== 'expired') return 'in_progress';
      }
    } catch {
      return 'provider_error';
    }
  }
  await getDb().execute(sql`
    UPDATE club_checkouts SET status = 'expired', completed_at = now()
     WHERE id = ${previous.id}::uuid AND status = 'open'
  `);
  return 'closed';
}

/** A member pays one of their (or their child's) open charges online. */
export async function startChargeCheckout(
  db: TransactionalDb,
  userId: string,
  club: { id: string; slug: string },
  chargeId: string,
  back: Return,
): Promise<CheckoutStart> {
  const account = await liveAccount(club.id);
  if (!account) return { ok: false, error: 'unavailable' };
  // Scope first: the charge must be this account's own (or a child's), open.
  const dueQuery = () => sql`
    SELECT cb.due_cents, cb.label, cb.member_id
      FROM club_charge_balances cb
      JOIN club_members m ON m.club_id = cb.club_id AND m.id = cb.member_id
     WHERE cb.charge_id = ${chargeId}::uuid AND cb.status IN ('open', 'partial', 'overdue')
       AND ${memberSelfScope(userId, club.id, 'm')} AND ${clubWritableGuard(club.id)}
  `;
  if ((await getDb().execute(dueQuery())).rows.length === 0) {
    return { ok: false, error: 'not_allowed' };
  }
  // One open checkout per charge (0046): a second click replaces the first —
  // after the provider confirms the first can no longer be paid. No lock is
  // held across that call; the unique index settles a race.
  const previous = (
    await getDb().execute(sql`
      SELECT id, provider, session_ref, account_ref FROM club_checkouts
       WHERE charge_id = ${chargeId}::uuid AND purpose = 'charge' AND status = 'open'
    `)
  ).rows[0];
  if (previous) {
    const closed = await closePrevious({
      id: String(previous.id),
      provider: String(previous.provider),
      sessionRef: text(previous.session_ref),
      accountRef: String(previous.account_ref),
    });
    if (closed !== 'closed') return { ok: false, error: closed };
  }
  type Created =
    | { error: 'not_allowed' | 'too_small' }
    | { error?: undefined; checkoutId: string; amount: number; label: string };
  let created: Created;
  try {
    created = await db.transaction(async (tx): Promise<Created> => {
      const due = (await tx.execute(dueQuery())).rows[0];
      if (!due) return { error: 'not_allowed' };
      const amount = Number(due.due_cents);
      if (amount < MIN_ONLINE_CENTS) return { error: 'too_small' };
      const checkoutId = randomUUID();
      await tx.execute(sql`
        INSERT INTO club_checkouts (id, club_id, purpose, member_id, charge_id, amount_cents,
                                    provider, account_ref)
        SELECT ${checkoutId}::uuid, m.club_id, 'charge', m.id, ${chargeId}::uuid, ${amount},
               ${account.provider}, ${account.accountRef}
          FROM club_members m
         WHERE m.id = ${String(due.member_id)}::uuid AND ${memberSelfScope(userId, club.id, 'm')}
      `);
      await recordClubAudit(tx, {
        clubId: club.id,
        by: { kind: 'member', userId },
        action: 'checkout_started',
        subjectMemberId: String(due.member_id),
        detail: { purpose: 'charge', amountCents: amount },
      });
      return { checkoutId, amount, label: String(due.label) };
    });
  } catch (error: unknown) {
    // Two first clicks at once: the other one owns the open checkout.
    if (violatedConstraint(error) === 'club_checkouts_one_open_per_charge') {
      return { ok: false, error: 'in_progress' };
    }
    throw error;
  }
  if (created.error !== undefined) return { ok: false, error: created.error };
  try {
    const url = await openSession(getDb(), {
      checkoutId: created.checkoutId,
      clubId: club.id,
      clubSlug: club.slug,
      account,
      label: created.label,
      amountCents: created.amount,
      subscriptionMonths: null,
      email: await verifiedEmail(getDb(), userId),
      back,
    });
    return url
      ? { ok: true, url, checkoutId: created.checkoutId }
      : { ok: false, error: 'provider_error' };
  } catch {
    return { ok: false, error: 'provider_error' };
  }
}

/**
 * Buy a public plan online — for the account's own record (created now if
 * the person is new to the club, as a trial booking would) or a child's. A
 * plan that renews by calendar months becomes a Stripe subscription; any
 * other plan is a one-off payment. The membership is created only when the
 * payment is confirmed, never before.
 */
export async function startPlanCheckout(
  db: TransactionalDb,
  userId: string,
  club: { id: string; slug: string },
  input: {
    planId: string;
    memberId: string | null;
    startsOn: IsoDate | null;
    /** The buyer ticked the club's terms (required only when the club has some). */
    termsAccepted: boolean;
  },
  back: Return,
): Promise<CheckoutStart> {
  const account = await liveAccount(club.id);
  if (!account) return { ok: false, error: 'unavailable' };
  type Refusal =
    | 'not_allowed'
    | 'too_small'
    | 'claim_first'
    | 'link_pending'
    | 'audience_mismatch'
    | 'already_renewing'
    | 'member_cap'
    | 'terms_required';
  interface Created {
    checkoutId: string;
    amount: number;
    label: string;
    months: number | null;
  }
  // Every refusal ROLLS BACK: a self record created for the purchase must not
  // reach the club when nothing was bought.
  class Refused extends Error {
    constructor(readonly code: Refusal) {
      super(code);
    }
  }
  let created: Created;
  try {
    created = await db.transaction(async (tx): Promise<Created> => {
      let memberId = input.memberId;
      if (memberId === null) {
        const self = await ensureSelfRecord(tx, userId, club.id);
        if (!self.ok) throw new Refused(self.error);
        memberId = self.memberId;
      }
      const found = (
        await tx.execute(sql`
          SELECT p.name_bg, p.kind, p.audience, p.price_cents, p.validity_months, p.auto_renew,
                 m.is_minor, c.terms_url, c.member_cap,
                 (SELECT to_char(max(mb.effective_ends_on) + 1, 'YYYY-MM-DD')
                    FROM club_membership_balances mb
                   WHERE mb.club_id = m.club_id AND mb.member_id = m.id
                     AND mb.state IN ('active', 'paused', 'upcoming')) AS next_free,
                 -- A renewing abonnement already bills the period after its end:
                 -- buying online on top of it would bill that period twice.
                 EXISTS (SELECT 1 FROM club_memberships r
                           JOIN club_membership_balances rb ON rb.membership_id = r.id
                          WHERE r.club_id = m.club_id AND r.member_id = m.id AND r.renews
                            AND r.renewal_ends_on IS NULL AND r.cancelled_at IS NULL
                            AND rb.state IN ('active', 'paused', 'upcoming')) AS renewing,
                 EXISTS (SELECT 1 FROM club_membership_balances lb
                          WHERE lb.club_id = m.club_id AND lb.member_id = m.id
                            AND lb.state IN ('active', 'paused', 'upcoming')) AS counted,
                 (SELECT count(DISTINCT cb.member_id)::int FROM club_membership_balances cb
                   WHERE cb.club_id = m.club_id
                     AND cb.state IN ('active', 'paused', 'upcoming')) AS live_members
            FROM club_plans p
            JOIN club_members m ON m.club_id = p.club_id AND m.id = ${memberId}::uuid
            JOIN clubs c ON c.id = p.club_id
           WHERE p.id = ${input.planId}::uuid AND p.club_id = ${club.id}::uuid
             AND p.visibility = 'public' AND p.archived_at IS NULL AND p.kind <> 'trial'
             AND m.archived_at IS NULL
             AND ${memberSelfScope(userId, club.id, 'm')} AND ${clubWritableGuard(club.id)}
        `)
      ).rows[0];
      if (!found) throw new Refused('not_allowed');
      if (found.terms_url !== null && !input.termsAccepted) throw new Refused('terms_required');
      const minor = found.is_minor === true;
      if ((found.audience === 'adults' && minor) || (found.audience === 'minors' && !minor)) {
        throw new Refused('audience_mismatch');
      }
      if (found.renewing === true) throw new Refused('already_renewing');
      // The tier's member cap, as a desk sale checks it (sellMembership).
      if (
        found.member_cap !== null &&
        found.counted !== true &&
        Number(found.live_members) >= Number(found.member_cap)
      ) {
        throw new Refused('member_cap');
      }
      const amount = Number(found.price_cents);
      if (amount < MIN_ONLINE_CENTS) throw new Refused('too_small');
      const today = sofiaToday();
      // Default start: today, or the day after the abonnement they already hold.
      const earliest = text(found.next_free) ?? today;
      const wanted = input.startsOn && isIsoDate(input.startsOn) ? input.startsOn : earliest;
      const startsOn =
        wanted < today ? today : wanted > addDaysIso(today, 60) ? addDaysIso(today, 60) : wanted;
      const months =
        found.auto_renew === true && found.validity_months !== null
          ? Number(found.validity_months)
          : null;
      const checkoutId = randomUUID();
      await tx.execute(sql`
      INSERT INTO club_checkouts (id, club_id, purpose, member_id, plan_id, starts_on,
                                  amount_cents, mode, provider, account_ref)
      VALUES (${checkoutId}::uuid, ${club.id}::uuid, 'membership', ${memberId}::uuid,
              ${input.planId}::uuid, ${startsOn}::date, ${amount},
              ${months === null ? 'payment' : 'subscription'}, ${account.provider},
              ${account.accountRef})
    `);
      await recordClubAudit(tx, {
        clubId: club.id,
        by: { kind: 'member', userId },
        action: 'checkout_started',
        subjectMemberId: memberId,
        detail: { purpose: 'membership', amountCents: amount },
      });
      return { checkoutId, amount, label: String(found.name_bg), months };
    });
  } catch (error: unknown) {
    if (error instanceof Refused) return { ok: false, error: error.code };
    throw error;
  }
  try {
    const url = await openSession(getDb(), {
      checkoutId: created.checkoutId,
      clubId: club.id,
      clubSlug: club.slug,
      account,
      label: created.label,
      amountCents: created.amount,
      subscriptionMonths: created.months,
      email: await verifiedEmail(getDb(), userId),
      back,
    });
    return url
      ? { ok: true, url, checkoutId: created.checkoutId }
      : { ok: false, error: 'provider_error' };
  } catch {
    return { ok: false, error: 'provider_error' };
  }
}

export interface MemberCheckout {
  id: string;
  /** 0046's states; `unapplied` is paid at the provider, waiting for the club. */
  status: 'open' | 'paid' | 'expired' | 'unapplied';
  amountCents: number;
  purpose: 'charge' | 'membership';
  provider: 'stripe' | 'fake';
}

/** A checkout of the account's own record (or a child's) — the return page. */
export async function checkoutForMember(
  userId: string,
  clubId: string,
  checkoutId: string,
): Promise<MemberCheckout | null> {
  const row = (
    await getDb().execute(sql`
      SELECT k.id, k.status, k.amount_cents, k.purpose, k.provider
        FROM club_checkouts k
        JOIN club_members m ON m.club_id = k.club_id AND m.id = k.member_id
       WHERE k.id = ${checkoutId}::uuid AND ${memberSelfScope(userId, clubId, 'm')}
    `)
  ).rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    status: String(row.status) as MemberCheckout['status'],
    amountCents: Number(row.amount_cents),
    purpose: row.purpose === 'membership' ? 'membership' : 'charge',
    provider: row.provider === 'fake' ? 'fake' : 'stripe',
  };
}

/**
 * The fake provider's «Плати» / «Откажи» (development only): settle the
 * checkout exactly as the worker would after re-fetching a Stripe session.
 */
export async function fakeSettle(
  checkoutId: string,
  outcome: 'paid' | 'cancelled',
): Promise<boolean> {
  if (paymentProvider() !== 'fake') return false;
  const row = (
    await getDb().execute(sql`
      SELECT amount_cents, mode FROM club_checkouts
       WHERE id = ${checkoutId}::uuid AND provider = 'fake' AND status = 'open'
    `)
  ).rows[0];
  if (!row) return false;
  if (outcome === 'cancelled') {
    await getDb().execute(sql`
      UPDATE club_checkouts SET status = 'expired', completed_at = now()
       WHERE id = ${checkoutId}::uuid AND status = 'open'
    `);
    return true;
  }
  const result = await applyCheckoutPaid(getDb(), {
    checkoutId,
    provider: 'fake',
    paymentRef: `fake_pi_${checkoutId}`,
    amountCents: Number(row.amount_cents),
    subscriptionRef: row.mode === 'subscription' ? `fake_sub_${checkoutId}` : null,
  });
  return result.applied;
}

// ─── Unapplied payments (office) ───────────────────────────────────────────

export interface UnappliedCheckout {
  id: string;
  memberId: string | null;
  memberName: string | null;
  amountCents: number;
  completedAt: string;
  provider: 'stripe' | 'fake';
  paymentRef: string;
}

/**
 * Money a member paid online that could not be applied — the charge was
 * settled at the desk while they were on Stripe's page (0046 `unapplied`).
 * The office refunds it in the club's own Stripe dashboard; the list keeps
 * the last 90 days in view.
 */
export async function unappliedCheckouts(actor: ClubActor): Promise<UnappliedCheckout[]> {
  const result = await getDb().execute(sql`
    SELECT kc.id, kc.member_id, m.display_name, kc.amount_cents, kc.completed_at, kc.provider,
           kc.payment_ref
      FROM club_checkouts kc
      LEFT JOIN club_members m ON m.club_id = kc.club_id AND m.id = kc.member_id
     WHERE ${clubScope(actor, 'payments.view', 'kc')} AND kc.status = 'unapplied'
       AND kc.completed_at > now() - interval '90 days'
     ORDER BY kc.completed_at DESC
     LIMIT 50
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    memberId: text(row.member_id),
    memberName: text(row.display_name),
    amountCents: Number(row.amount_cents),
    completedAt: new Date(String(row.completed_at)).toISOString(),
    provider: row.provider === 'fake' ? 'fake' : 'stripe',
    paymentRef: String(row.payment_ref),
  }));
}

// ─── Refunds (office) ──────────────────────────────────────────────────────

export type RefundResult =
  | { ok: true }
  | {
      ok: false;
      /** account_changed: paid to an account no longer connected — refund in Stripe. */
      error: 'not_allowed' | 'amount_invalid' | 'provider_error' | 'account_changed';
    };

/**
 * Refund an online payment, all or part, through the provider; the negative
 * row is recorded at once. charges.void (owner, manager) on a writable club.
 *
 * The books follow 0041: a refund on a live charge makes the refunded money
 * owed again. So when the refund leaves NOTHING paid on the charge, the
 * charge is voided in the same step — the member is not asked to pay back
 * their own refund. A partial refund leaves the remainder owed (the confirm
 * text says so); a membership the charge was for is cancelled separately.
 */
export async function refundOnlinePayment(
  db: TransactionalDb,
  actor: ClubActor,
  paymentId: number,
  amountCents: number | null,
): Promise<RefundResult> {
  const payment = (
    await db.execute(sql`
      SELECT pay.provider, pay.provider_ref, pay.amount_cents, pay.charge_id,
             pay.amount_cents + coalesce((SELECT sum(r.amount_cents) FROM club_payments r
                                           WHERE r.charge_id = pay.charge_id AND r.kind = 'refund'
                                             AND r.method = 'card_online'), 0) AS refundable,
             paid_on.account_ref,
             EXISTS (SELECT 1 FROM club_payment_accounts a
                      WHERE a.club_id = pay.club_id AND a.disconnected_at IS NULL
                        AND a.account_ref = paid_on.account_ref) AS reachable
        FROM club_payments pay
        -- The account the money went to: the checkout that took it, or the
        -- one that opened the subscription a renewal was billed on — never
        -- simply whatever the club has connected today.
        LEFT JOIN LATERAL (
          SELECT coalesce(
                   (SELECT k.account_ref FROM club_checkouts k
                     WHERE k.club_id = pay.club_id AND k.payment_ref = pay.provider_ref LIMIT 1),
                   (SELECT k.account_ref FROM club_charges ch
                      JOIN club_memberships ms ON ms.club_id = ch.club_id AND ms.id = ch.membership_id
                      JOIN club_checkouts k ON k.club_id = ms.club_id
                                           AND k.subscription_ref = ms.provider_subscription_ref
                     WHERE ch.id = pay.charge_id LIMIT 1)) AS account_ref
        ) paid_on ON true
       WHERE pay.id = ${paymentId} AND pay.kind = 'payment' AND pay.method = 'card_online'
         AND ${clubWriteScope(actor, 'charges.void', 'pay')}
    `)
  ).rows[0];
  if (!payment || payment.provider_ref === null) return { ok: false, error: 'not_allowed' };
  const refundable = Number(payment.refundable);
  const amount = amountCents ?? refundable;
  if (!Number.isInteger(amount) || amount <= 0 || amount > refundable) {
    return { ok: false, error: 'amount_invalid' };
  }
  const provider = payment.provider === 'fake' ? 'fake' : 'stripe';
  let refundRef: string;
  if (provider === 'fake') {
    refundRef = `fake_re_${randomUUID()}`;
  } else {
    if (paymentProvider() !== 'stripe') return { ok: false, error: 'provider_error' };
    if (payment.account_ref === null || payment.reachable !== true) {
      return { ok: false, error: 'account_changed' };
    }
    try {
      const { client } = stripe();
      const refund = await client.createRefund(
        { payment_intent: String(payment.provider_ref), amount },
        {
          account: String(payment.account_ref),
          idempotencyKey: `refund:${String(paymentId)}:${String(amount)}:${String(refundable)}`,
        },
      );
      refundRef = refund.id;
    } catch {
      return { ok: false, error: 'provider_error' };
    }
  }
  await recordProviderRefund(
    db,
    { provider, paymentRef: String(payment.provider_ref), refundRef, amountCents: amount },
    actor.userId,
  );
  await voidCharge(db, actor, String(payment.charge_id), { onlyIfNothingPaid: true });
  return { ok: true };
}

// ─── Stopping subscriptions ────────────────────────────────────────────────

/**
 * Stop the Stripe subscription behind a member's chain (or one membership's)
 * BEFORE the books stop expecting it — otherwise Stripe keeps charging a card
 * for periods nobody records (the 0046 review). `period_end` lets the paid
 * period run (cancelling, giving notice); `now` ends it at once (erasing the
 * client's record). Returns false when the provider refused, so the caller
 * can stop and say so instead of erasing a record that is still billed.
 *
 * Callers are office actions behind requireClubStaff for THIS club, or the
 * portal after a memberSelfScope-checked write succeeded: the lookup is
 * pinned to `clubId` either way.
 */
export async function stopProviderSubscriptions(
  clubId: string,
  target: { memberId: string } | { membershipId: string } | { club: true },
  when: 'now' | 'period_end' | { at: IsoDate },
): Promise<boolean> {
  const subscriptions = await subscriptionRefsFor(getDb(), clubId, target);
  if (subscriptions.length === 0) return true;
  let ok = true;
  for (const subscription of subscriptions) {
    if (subscription.provider === 'fake') continue;
    // Opened on an account the club has since revoked at Stripe: the club
    // controls it there, and nothing from here can reach it. Blocking an
    // erasure on it forever would help nobody.
    if (!subscription.reachable || subscription.accountRef === null) continue;
    if (paymentProvider() !== 'stripe') {
      ok = false;
      continue;
    }
    try {
      const { client } = stripe();
      const options = { account: subscription.accountRef };
      if (when === 'now') await client.cancelSubscriptionNow(subscription.subscriptionRef, options);
      else if (when === 'period_end') {
        await client.cancelSubscriptionAtPeriodEnd(subscription.subscriptionRef, options);
      } else {
        // Billing stops where the contract does: the first Sofia midnight
        // after the notice's last day.
        const [year, month, day] = addDaysIso(when.at, 1).split('-').map(Number);
        const at = zonedToDate(
          { year: year ?? 0, month: month ?? 1, day: day ?? 1, hour: 0, minute: 0 },
          'Europe/Sofia',
        );
        await client.cancelSubscriptionAt(
          subscription.subscriptionRef,
          Math.floor(at.getTime() / 1000),
          options,
        );
      }
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** A purged club's connection is let go at Stripe too (best effort). */
export async function releaseClubAccount(clubId: string): Promise<void> {
  const live = await clubPaymentAccount(clubId);
  if (!live || live.provider !== 'stripe' || paymentProvider() !== 'stripe') return;
  const { client, settings } = stripe();
  await client.oauthDeauthorize(settings.connectClientId, live.accountRef).catch(() => undefined);
}
