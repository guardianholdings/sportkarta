import { randomUUID } from 'node:crypto';

import { applyCheckoutPaid, getDb, getPool, recordPaymentEvent, sql } from '@sportkarta/db';
import { addDaysIso, sofiaToday } from '@sportkarta/lib/clubs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  connectAccount,
  disconnectAccount,
  fakeSettle,
  refundOnlinePayment,
  startChargeCheckout,
  startPlanCheckout,
  stopProviderSubscriptions,
} from '@/lib/clubs/payments';
import type { ClubActor } from '@/lib/clubs/scope';
import { memberStopRenewal } from '@/lib/clubs/self-service';

import { runClubPaymentEvent } from '../../../worker/src/club-payments-job';

import { hasDb } from './db';

// lib/clubs/payments.ts is `server-only`, a marker Next resolves from its own
// bundle; plain Node has no such package. (Hoisted above the imports.)
vi.mock('server-only', () => ({}));

/**
 * Online payments (0046) through the app's OWN functions and the worker's own
 * event code, against real Postgres — the paths the 2026-11-14 payment review
 * found wrong, each held by the test that failed before its fix:
 *
 *   * a card subscription is booked from the day it is paid: Stripe bills from
 *     the moment of purchase, so a later start would let the money run ahead
 *     of the periods it pays for;
 *   * one purchase in flight per client — a second click replaces the first,
 *     and is refused while the first is paid and still being applied;
 *   * an account is not let go while a paid checkout waits for its event, and
 *     a paid checkout whose account can no longer be asked is listed for the
 *     office instead of staying open for ever;
 *   * replacing or disconnecting an account lets it go AT STRIPE too, and the
 *     owner is told when Stripe did not confirm;
 *   * a second online payment on a charge a partial refund re-opened can be
 *     refunded;
 *   * a subscription already ended at Stripe counts as stopped — also inside
 *     the member's own notice, which holds the chain locked.
 *
 * Two providers: the fake one (/dev/plashtane) where the books alone are under
 * test, and Stripe with its HTTP API stubbed at `fetch` — the real client, the
 * real requests, scripted answers. No Stripe key exists here.
 *
 * COMMITS under its own `e2e-jp-*` clubs and `e2e_club_jp_*` accounts, removed
 * through the real purge path.
 */

const PREFIX = 'e2e_club_jp_';
const rand = () => Math.random().toString(36).slice(2, 10);

async function cleanup(): Promise<void> {
  const db = getDb();
  const clubs = await db.execute(sql`SELECT id FROM clubs WHERE slug LIKE 'e2e-jp-%'`);
  for (const row of clubs.rows) {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('pops.purging_club', ${String(row.id)}, true)`);
      await tx.execute(sql`DELETE FROM clubs WHERE id = ${String(row.id)}::uuid`);
    });
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE ${`${PREFIX}%`}`);
  await db.execute(sql`DELETE FROM club_payment_events WHERE event_id LIKE 'evt_test_jp_%'`);
}

interface StripeCall {
  method: string;
  /** Host and path, e.g. `api.stripe.com/v1/checkout/sessions/cs_1`. */
  path: string;
  account: string | null;
  idempotencyKey: string | null;
  form: URLSearchParams;
}

interface StripeReply {
  status?: number;
  body: unknown;
}

/** Stripe's API, scripted: every request the real client makes lands here. */
function stripeStub(route: (call: StripeCall) => StripeReply): StripeCall[] {
  const calls: StripeCall[] = [];
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: StripeCall = {
      method: init?.method ?? 'GET',
      path: `${url.host}${url.pathname}`,
      account: headers['Stripe-Account'] ?? null,
      idempotencyKey: headers['Idempotency-Key'] ?? null,
      form: new URLSearchParams(typeof init?.body === 'string' ? init.body : ''),
    };
    calls.push(call);
    const reply = route(call);
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  });
  return calls;
}

const missing: StripeReply = {
  status: 404,
  body: { error: { type: 'invalid_request_error', code: 'resource_missing' } },
};
const outage: StripeReply = { status: 500, body: { error: { type: 'api_error' } } };
/** What Stripe answers once an account no longer lets the platform in. */
const revokedReply: StripeReply = {
  status: 403,
  body: { error: { type: 'invalid_request_error', code: 'account_invalid' } },
};

function fakeMode(): void {
  vi.stubEnv('CLUB_PAYMENTS_ENABLED', 'true');
  vi.stubEnv('PAYMENT_PROVIDER', 'fake');
}

function stripeMode(): void {
  vi.stubEnv('CLUB_PAYMENTS_ENABLED', 'true');
  vi.stubEnv('PAYMENT_PROVIDER', 'stripe');
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_0123456789abcdef');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test0123456789abcdef');
  vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', 'ca_test0123456789abcdef');
}

interface Club {
  id: string;
  slug: string;
  accountRef: string;
  owner: ClubActor;
}

interface Buyer {
  memberId: string;
  userId: string;
}

describe.skipIf(!hasDb)('club online payments journey (requires running database)', () => {
  let db: ReturnType<typeof getDb>;
  const back = { base: 'http://localhost', locale: 'bg' as const };

  async function account(label: string): Promise<string> {
    const id = `${PREFIX}${label}_${rand()}`;
    await db.execute(sql`
      INSERT INTO users (id, display_name, email, email_verified)
      VALUES (${id}, ${`Journey ${label}`}, ${`${id}@example.org`}, true)
    `);
    return id;
  }

  /** A paying club with its owner and a live payment account of this provider. */
  async function makeClub(provider: 'fake' | 'stripe'): Promise<Club> {
    const ownerId = await account('owner');
    const slug = `e2e-jp-${rand()}`;
    const club = await db.execute(sql`
      INSERT INTO clubs (slug, name_bg, tier, status, approved_at, paid_until, visible)
      VALUES (${slug}, 'Клуб Плащания', 'standard', 'active', now(),
              (now() + interval '1 year')::date, true)
      RETURNING id
    `);
    const id = String(club.rows[0]?.id);
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${id}::uuid, ${ownerId}, 'owner')
    `);
    const accountRef = `acct_jp_${rand()}`;
    await db.execute(sql`
      INSERT INTO club_payment_accounts (club_id, provider, account_ref, charges_enabled)
      VALUES (${id}::uuid, ${provider}, ${accountRef}, true)
    `);
    return {
      id,
      slug,
      accountRef,
      owner: { userId: ownerId, clubId: id, role: 'owner', ngoAdmin: false },
    };
  }

  /** A client record linked to a POPS account of its own. */
  async function makeBuyer(club: Club, name: string): Promise<Buyer> {
    const userId = await account('member');
    const member = await db.execute(sql`
      INSERT INTO club_members (club_id, display_name) VALUES (${club.id}::uuid, ${name})
      RETURNING id
    `);
    const memberId = String(member.rows[0]?.id);
    await db.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
      VALUES (${memberId}::uuid, ${club.id}::uuid, ${userId}, 'active', 'invite')
    `);
    return { memberId, userId };
  }

  async function makePlan(
    club: Club,
    fields: { autoRenew?: boolean; selfCancel?: boolean } = {},
  ): Promise<string> {
    const plan = await db.execute(sql`
      INSERT INTO club_plans (club_id, name_bg, kind, price_cents, validity_months, auto_renew,
                              self_cancel_allowed)
      VALUES (${club.id}::uuid, ${`План ${rand()}`}, 'unlimited', 2500, 1,
              ${fields.autoRenew === true}, ${fields.selfCancel === true})
      RETURNING id
    `);
    return String(plan.rows[0]?.id);
  }

  const buy = (club: Club, buyer: Buyer, planId: string, startsOn: string | null = null) =>
    startPlanCheckout(
      db,
      buyer.userId,
      { id: club.id, slug: club.slug },
      { planId, memberId: buyer.memberId, startsOn, termsAccepted: true },
      back,
    );

  async function checkoutRow(id: string) {
    const row = await db.execute(sql`
      SELECT status, mode, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, payment_ref
        FROM club_checkouts WHERE id = ${id}::uuid
    `);
    return row.rows[0];
  }

  async function openCharge(club: Club, buyer: Buyer, amountCents: number): Promise<string> {
    const charge = await db.execute(sql`
      INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on)
      VALUES (${club.id}::uuid, ${buyer.memberId}::uuid, 'other', 'Онлайн такса', ${amountCents},
              ${sofiaToday()}::date, ${sofiaToday()}::date)
      RETURNING id
    `);
    return String(charge.rows[0]?.id);
  }

  /** An open Stripe checkout for a charge, as startChargeCheckout leaves it. */
  async function stripeCheckout(club: Club, buyer: Buyer, sessionRef: string): Promise<string> {
    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO club_checkouts (id, club_id, purpose, member_id, charge_id, amount_cents,
                                  provider, account_ref, session_ref)
      VALUES (${id}::uuid, ${club.id}::uuid, 'charge', ${buyer.memberId}::uuid,
              ${await openCharge(club, buyer, 3000)}::uuid, 3000, 'stripe', ${club.accountRef},
              ${sessionRef})
    `);
    return id;
  }

  /** A renewing chain whose card subscription was opened on the club's live account. */
  async function subscribed(
    club: Club,
    buyer: Buyer,
    planId: string,
    subscriptionRef: string,
  ): Promise<string> {
    const checkoutId = randomUUID();
    await db.execute(sql`
      INSERT INTO club_checkouts (id, club_id, purpose, member_id, plan_id, starts_on,
                                  amount_cents, mode, provider, account_ref)
      VALUES (${checkoutId}::uuid, ${club.id}::uuid, 'membership', ${buyer.memberId}::uuid,
              ${planId}::uuid, ${sofiaToday()}::date, 2500, 'subscription', 'stripe',
              ${club.accountRef})
    `);
    const applied = await applyCheckoutPaid(db, {
      checkoutId,
      provider: 'stripe',
      paymentRef: `pi_test_jp_${rand()}`,
      amountCents: 2500,
      currency: 'eur',
      subscriptionRef,
    });
    expect(applied.applied).toBe(true);
    const membership = await db.execute(sql`
      SELECT id FROM club_memberships WHERE provider_subscription_ref = ${subscriptionRef}
    `);
    return String(membership.rows[0]?.id);
  }

  async function renews(subscriptionRef: string): Promise<unknown[]> {
    const rows = await db.execute(sql`
      SELECT renews FROM club_memberships WHERE provider_subscription_ref = ${subscriptionRef}
    `);
    return rows.rows.map((row) => row.renews);
  }

  async function liveAccountRef(club: Club): Promise<string | null> {
    const row = await db.execute(sql`
      SELECT account_ref FROM club_payment_accounts
       WHERE club_id = ${club.id}::uuid AND disconnected_at IS NULL
    `);
    return row.rows[0] ? String(row.rows[0].account_ref) : null;
  }

  async function audit(club: Club, action: string): Promise<unknown[]> {
    const rows = await db.execute(sql`
      SELECT detail FROM club_audit
       WHERE club_id = ${club.id}::uuid AND action = ${action} ORDER BY id
    `);
    return rows.rows.map((row) => row.detail);
  }

  beforeAll(async () => {
    db = getDb();
    await cleanup();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await cleanup();
    await getPool().end();
  });

  it('books a card subscription from the day it is paid, whatever start was asked', async () => {
    fakeMode();
    const club = await makeClub('fake');
    const buyer = await makeBuyer(club, 'Абонат');
    const today = sofiaToday();
    const later = addDaysIso(today, 30);
    const oneOff = await makePlan(club);
    const renewing = await makePlan(club, { autoRenew: true });
    // They hold an abonnement that runs three more weeks.
    await db.execute(sql`
      INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                    price_cents, starts_on, ends_on)
      VALUES (${club.id}::uuid, ${buyer.memberId}::uuid, ${oneOff}::uuid, 'Текущ', 'unlimited',
              'all', 2500, ${addDaysIso(today, -9)}::date, ${addDaysIso(today, 20)}::date)
    `);

    // A one-off purchase starts when the buyer says.
    const single = await buy(club, buyer, oneOff, later);
    if (!single.ok) throw new Error(single.error);
    expect(await checkoutRow(single.checkoutId)).toMatchObject({
      mode: 'payment',
      starts_on: later,
    });

    // A subscription is billed by Stripe from the moment it is bought: a
    // later start would put every period a month behind the money.
    const asked = await buy(club, buyer, renewing, later);
    if (!asked.ok) throw new Error(asked.error);
    expect(await checkoutRow(asked.checkoutId)).toMatchObject({
      mode: 'subscription',
      starts_on: today,
    });
    // Nor does it default to the day after the abonnement they already hold.
    const byDefault = await buy(club, buyer, renewing);
    if (!byDefault.ok) throw new Error(byDefault.error);
    expect(await checkoutRow(byDefault.checkoutId)).toMatchObject({
      mode: 'subscription',
      starts_on: today,
    });
    expect(await fakeSettle(byDefault.checkoutId, 'paid')).toBe(true);
    const sold = await db.execute(sql`
      SELECT to_char(starts_on, 'YYYY-MM-DD') AS starts_on, renews FROM club_memberships
       WHERE member_id = ${buyer.memberId}::uuid AND provider_subscription_ref IS NOT NULL
    `);
    expect(sold.rows).toEqual([{ starts_on: today, renews: true }]);
  });

  it('keeps one purchase in flight per client: a second click replaces the first', async () => {
    fakeMode();
    const club = await makeClub('fake');
    const buyer = await makeBuyer(club, 'Купувач');
    const first = await buy(club, buyer, await makePlan(club));
    if (!first.ok) throw new Error(first.error);
    // Another plan, even: the earlier attempt can no longer be paid.
    const second = await buy(club, buyer, await makePlan(club));
    if (!second.ok) throw new Error(second.error);
    expect((await checkoutRow(first.checkoutId))?.status).toBe('expired');
    expect((await checkoutRow(second.checkoutId))?.status).toBe('open');
    // Somebody else's purchase is nobody's business.
    const other = await makeBuyer(club, 'Друг');
    const theirs = await buy(club, other, await makePlan(club));
    if (!theirs.ok) throw new Error(theirs.error);
    expect((await checkoutRow(second.checkoutId))?.status).toBe('open');
    // Two first clicks at the very same moment — neither sees the other
    // before it starts. Made to overlap for certain: the client's row is held
    // until both are inside their transactions, waiting for it.
    const racer = await makeBuyer(club, 'Двоен');
    const raced = await makePlan(club);
    const holder = await getPool().connect();
    let both: Awaited<ReturnType<typeof buy>>[];
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM club_members WHERE id = $1 FOR NO KEY UPDATE', [
        racer.memberId,
      ]);
      const held = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pending = Promise.all([buy(club, racer, raced), buy(club, racer, raced)]);
      let queued = 0;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        // Everything queued behind the holder: the first waits on it, the
        // second on the first. Asked from ANOTHER connection — inside a
        // transaction pg_stat_activity is a snapshot that never moves.
        const waiting = await db.execute(sql`
          WITH RECURSIVE queued AS (
            SELECT pid FROM pg_stat_activity
             WHERE pg_blocking_pids(pid) @> ARRAY[${held.rows[0]?.pid ?? 0}::int]
            UNION
            SELECT a.pid FROM pg_stat_activity a
              JOIN queued q ON pg_blocking_pids(a.pid) @> ARRAY[q.pid]
          )
          SELECT count(*)::int AS n FROM queued
        `);
        queued = Number(waiting.rows[0]?.n ?? 0);
        if (queued >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await holder.query('COMMIT');
      both = await pending;
      // Both really did overlap — or this test proves nothing.
      expect(queued).toBe(2);
    } finally {
      // Never hand a connection back with the row still held (a no-op after
      // the COMMIT above).
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    // One attempt that can be paid, and the other click is told why.
    expect(both.map((result) => (result.ok ? 'ok' : result.error)).sort()).toEqual([
      'in_progress',
      'ok',
    ]);
    const open = await db.execute(sql`
      SELECT count(*)::int AS n FROM club_checkouts
       WHERE member_id = ${racer.memberId}::uuid AND status = 'open'
    `);
    expect(open.rows[0]?.n).toBe(1);
  });

  it('refuses a second purchase while the first is paid and still being applied', async () => {
    stripeMode();
    const club = await makeClub('stripe');
    const buyer = await makeBuyer(club, 'Нетърпелив');
    const planId = await makePlan(club, { autoRenew: true });
    let created = 0;
    const calls = stripeStub((call) => {
      if (call.method === 'POST' && call.path === 'api.stripe.com/v1/checkout/sessions') {
        created += 1;
        return {
          body: {
            id: `cs_test_jp_${rand()}`,
            url: 'https://checkout.stripe.test/pay',
            status: 'open',
          },
        };
      }
      // The buyer paid on the first page; its event has not been applied yet.
      if (call.method === 'GET' && call.path.startsWith('api.stripe.com/v1/checkout/sessions/')) {
        return { body: { status: 'complete', payment_status: 'paid', url: null } };
      }
      return outage;
    });
    const first = await buy(club, buyer, planId);
    if (!first.ok) throw new Error(first.error);
    expect(await buy(club, buyer, planId)).toEqual({ ok: false, error: 'in_progress' });
    expect(created).toBe(1);
    // Every request acted for the club's own account, never the platform's.
    expect(new Set(calls.map((call) => call.account))).toEqual(new Set([club.accountRef]));
    const open = await db.execute(sql`
      SELECT count(*)::int AS n FROM club_checkouts
       WHERE club_id = ${club.id}::uuid AND status = 'open'
    `);
    expect(open.rows[0]?.n).toBe(1);
  });

  it('ends the second subscription when two purchases were both paid', async () => {
    stripeMode();
    const club = await makeClub('stripe');
    const buyer = await makeBuyer(club, 'Двоен абонат');
    const planId = await makePlan(club, { autoRenew: true });
    const first = `sub_test_jp_${rand()}`;
    const second = `sub_test_jp_${rand()}`;
    await subscribed(club, buyer, planId, first);
    // The other tab's purchase, paid a moment later: its event arrives now.
    const sessionRef = `cs_test_jp_${rand()}`;
    const checkoutId = randomUUID();
    await db.execute(sql`
      INSERT INTO club_checkouts (id, club_id, purpose, member_id, plan_id, starts_on,
                                  amount_cents, mode, provider, account_ref, session_ref)
      VALUES (${checkoutId}::uuid, ${club.id}::uuid, 'membership', ${buyer.memberId}::uuid,
              ${planId}::uuid, ${sofiaToday()}::date, 2500, 'subscription', 'stripe',
              ${club.accountRef}, ${sessionRef})
    `);
    const calls = stripeStub((call) => {
      if (call.method === 'GET' && call.path.endsWith(`/checkout/sessions/${sessionRef}`)) {
        return {
          body: {
            id: sessionRef,
            status: 'complete',
            payment_status: 'paid',
            amount_total: 2500,
            currency: 'eur',
            payment_intent: null,
            subscription: second,
            invoice: 'in_test_jp_second',
          },
        };
      }
      if (call.method === 'GET' && call.path.endsWith('/invoices/in_test_jp_second')) {
        return { body: { id: 'in_test_jp_second', payment_intent: 'pi_test_jp_second' } };
      }
      if (call.method === 'DELETE' && call.path.endsWith(`/subscriptions/${second}`)) {
        return { body: { id: second, status: 'canceled' } };
      }
      return outage;
    });
    const eventId = await recordPaymentEvent(db, {
      eventId: `evt_test_jp_${rand()}`,
      type: 'checkout.session.completed',
      accountRef: club.accountRef,
      objectRef: sessionRef,
    });
    expect(await runClubPaymentEvent(eventId ?? 0, async () => undefined)).toEqual({
      type: 'checkout.session.completed',
      outcome: 'failed',
    });
    // The money is listed for the office; no second chain is opened …
    expect(await checkoutRow(checkoutId)).toMatchObject({
      status: 'unapplied',
      payment_ref: 'pi_test_jp_second',
    });
    const chains = await db.execute(sql`
      SELECT provider_subscription_ref FROM club_memberships
       WHERE member_id = ${buyer.memberId}::uuid
    `);
    expect(chains.rows).toEqual([{ provider_subscription_ref: first }]);
    // … and the card is not billed for it again: ended at Stripe, on the
    // club's own account. The first chain is untouched.
    const ended = calls.filter((call) => call.method === 'DELETE');
    expect(ended.map((call) => [call.path, call.account])).toEqual([
      [`api.stripe.com/v1/subscriptions/${second}`, club.accountRef],
    ]);
    expect(await renews(first)).toEqual([true]);
  });

  it('does not let go of an account while a paid checkout waits to be applied', async () => {
    stripeMode();
    const club = await makeClub('stripe');
    const buyer = await makeBuyer(club, 'Платил');
    const checkoutId = await stripeCheckout(club, buyer, `cs_test_jp_${rand()}`);
    let session: 'complete' | 'open' = 'complete';
    const calls = stripeStub((call) => {
      if (call.path === 'connect.stripe.com/oauth/deauthorize') {
        return { body: { stripe_user_id: call.form.get('stripe_user_id') } };
      }
      if (call.method === 'GET') return { body: { status: session } };
      if (call.path.endsWith('/expire')) return { body: { status: 'expired' } };
      return outage;
    });
    const released = () => calls.filter((c) => c.path === 'connect.stripe.com/oauth/deauthorize');

    // Paid at Stripe, its event still on the way: once the account is let go
    // nobody could fetch that session again, so the disconnect waits.
    expect(await disconnectAccount(db, club.owner)).toBe('checkouts_in_progress');
    expect(await liveAccountRef(club)).toBe(club.accountRef);
    expect((await checkoutRow(checkoutId))?.status).toBe('open');
    expect(released()).toEqual([]);

    // A session nobody paid is closed at Stripe, and the account is let go.
    session = 'open';
    expect(await disconnectAccount(db, club.owner)).toBe('ok');
    expect(await liveAccountRef(club)).toBeNull();
    expect((await checkoutRow(checkoutId))?.status).toBe('expired');
    expect(released().map((c) => Object.fromEntries(c.form))).toEqual([
      { client_id: 'ca_test0123456789abcdef', stripe_user_id: club.accountRef },
    ]);
    expect(await audit(club, 'payment_account_disconnected')).toEqual([
      { provider: 'stripe', grant: 'released' },
    ]);
  });

  it('lists a paid checkout as unapplied when its account can no longer be asked', async () => {
    stripeMode();
    const club = await makeClub('stripe');
    const buyer = await makeBuyer(club, 'Забравен');
    const sessionRef = `cs_test_jp_${rand()}`;
    const checkoutId = await stripeCheckout(club, buyer, sessionRef);
    const otherRef = `cs_test_jp_${rand()}`;
    const other = await stripeCheckout(club, buyer, otherRef);
    let reply: StripeReply = revokedReply;
    stripeStub(() => reply);
    const event = async (type: string, objectRef: string) =>
      (await recordPaymentEvent(db, {
        eventId: `evt_test_jp_${rand()}`,
        type,
        accountRef: club.accountRef,
        objectRef,
      })) ?? 0;
    const enqueue = async () => undefined;

    // The club revoked access in its Stripe dashboard: the fetch is refused.
    expect(
      await runClubPaymentEvent(await event('checkout.session.completed', sessionRef), enqueue),
    ).toEqual({ type: 'checkout.session.completed', outcome: 'failed' });
    // Not open for ever, shown to nobody: on the office's list, to look up in Stripe.
    expect(await checkoutRow(checkoutId)).toMatchObject({
      status: 'unapplied',
      payment_ref: sessionRef,
    });
    // An event that is not a paid checkout marks nothing.
    expect(
      await runClubPaymentEvent(await event('charge.refunded', 'ch_test_jp_1'), enqueue),
    ).toEqual({ type: 'charge.refunded', outcome: 'failed' });
    expect((await checkoutRow(other))?.status).toBe('open');

    // A refusal that is about the PLATFORM's own key — the account still
    // connected here, Stripe not saying it is gone — shelves nothing: the
    // operator fixes the key and the money can still be applied.
    reply = { status: 403, body: { error: { type: 'invalid_request_error' } } };
    expect(
      await runClubPaymentEvent(await event('checkout.session.completed', otherRef), enqueue),
    ).toEqual({ type: 'checkout.session.completed', outcome: 'failed' });
    expect((await checkoutRow(other))?.status).toBe('open');
    // The same refusal once the books know the account is gone: listed.
    await db.execute(sql`
      UPDATE club_payment_accounts SET disconnected_at = now(), charges_enabled = false
       WHERE club_id = ${club.id}::uuid AND disconnected_at IS NULL
    `);
    expect(
      await runClubPaymentEvent(await event('checkout.session.completed', otherRef), enqueue),
    ).toEqual({ type: 'checkout.session.completed', outcome: 'failed' });
    expect((await checkoutRow(other))?.status).toBe('unapplied');
  });

  it('leaves nothing open on an account it lets go', async () => {
    stripeMode();
    const club = await makeClub('stripe');
    const buyer = await makeBuyer(club, 'По средата');
    const planId = await makePlan(club);
    const old = club.accountRef;
    // A purchase the buyer is still paying when the owner disconnects.
    const sessionRef = `cs_test_jp_${rand()}`;
    const stuck = randomUUID();
    await db.execute(sql`
      INSERT INTO club_checkouts (id, club_id, purpose, member_id, plan_id, starts_on,
                                  amount_cents, mode, provider, account_ref, session_ref)
      VALUES (${stuck}::uuid, ${club.id}::uuid, 'membership', ${buyer.memberId}::uuid,
              ${planId}::uuid, ${sofiaToday()}::date, 2500, 'payment', 'stripe', ${old},
              ${sessionRef})
    `);
    let released = false;
    stripeStub((call) => {
      if (call.path === 'connect.stripe.com/oauth/deauthorize') {
        released = true;
        return { body: { stripe_user_id: old } };
      }
      // The old account: Stripe is down while it is asked about the session,
      // and refuses for good once POPS has let the account go.
      if (call.account === old) return released ? revokedReply : outage;
      if (call.method === 'POST' && call.path === 'api.stripe.com/v1/checkout/sessions') {
        return {
          body: {
            id: `cs_test_jp_${rand()}`,
            url: 'https://checkout.stripe.test/pay',
            status: 'open',
          },
        };
      }
      return outage;
    });

    // An outage does not keep the club connected — and nothing stays open on
    // an account nobody can ask again: it would refuse this client's every
    // later purchase.
    expect(await disconnectAccount(db, club.owner)).toBe('ok');
    expect((await checkoutRow(stuck))?.status).toBe('expired');
    // The buyer did pay on that page: the event's fetch is refused, and the
    // money is listed for the office.
    const eventId = await recordPaymentEvent(db, {
      eventId: `evt_test_jp_${rand()}`,
      type: 'checkout.session.completed',
      accountRef: old,
      objectRef: sessionRef,
    });
    expect(await runClubPaymentEvent(eventId ?? 0, async () => undefined)).toEqual({
      type: 'checkout.session.completed',
      outcome: 'failed',
    });
    expect(await checkoutRow(stuck)).toMatchObject({
      status: 'unapplied',
      payment_ref: sessionRef,
    });
    // On the club's next account the same client buys as usual.
    expect(
      await connectAccount(db, club.owner, {
        provider: 'stripe',
        accountRef: `acct_jp_${rand()}`,
        chargesEnabled: true,
      }),
    ).toBe('ok');
    expect((await buy(club, buyer, planId)).ok).toBe(true);
  });

  it('touches nothing at the provider for somebody who may not manage payments', async () => {
    stripeMode();
    const club = await makeClub('stripe');
    const buyer = await makeBuyer(club, 'Чакащ');
    const checkoutId = await stripeCheckout(club, buyer, `cs_test_jp_${rand()}`);
    const deskId = await account('desk');
    await db.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role) VALUES (${club.id}::uuid, ${deskId}, 'desk')
    `);
    const desk: ClubActor = { userId: deskId, clubId: club.id, role: 'desk', ngoAdmin: false };
    const calls = stripeStub(() => ({ body: { status: 'open' } }));

    expect(await disconnectAccount(db, desk)).toBe('not_allowed');
    expect(
      await connectAccount(db, desk, {
        provider: 'stripe',
        accountRef: `acct_jp_${rand()}`,
        chargesEnabled: true,
      }),
    ).toBe('not_allowed');
    // No session closed, no grant released, nothing changed.
    expect(calls).toEqual([]);
    expect((await checkoutRow(checkoutId))?.status).toBe('open');
    expect(await liveAccountRef(club)).toBe(club.accountRef);
  });

  it('lets a replaced account go at Stripe, and says when Stripe did not confirm', async () => {
    stripeMode();
    const club = await makeClub('stripe');
    let stripeUp = true;
    const calls = stripeStub((call) =>
      call.path === 'connect.stripe.com/oauth/deauthorize' && stripeUp
        ? { body: { stripe_user_id: call.form.get('stripe_user_id') } }
        : outage,
    );
    const released = () =>
      calls
        .filter((c) => c.path === 'connect.stripe.com/oauth/deauthorize')
        .map((c) => c.form.get('stripe_user_id'));
    const connect = (accountRef: string) =>
      connectAccount(db, club.owner, { provider: 'stripe', accountRef, chargesEnabled: true });
    const second = `acct_jp_${rand()}`;
    const third = `acct_jp_${rand()}`;
    // A checkout Stripe cannot be asked about while the account is replaced.
    const left = await stripeCheckout(
      club,
      await makeBuyer(club, 'Останал'),
      `cs_test_jp_${rand()}`,
    );

    // Another account replaces the live one: POPS keeps no grant on the old,
    // and nothing stays open on it.
    expect(await connect(second)).toBe('ok');
    expect(released()).toEqual([club.accountRef]);
    expect(await liveAccountRef(club)).toBe(second);
    expect((await checkoutRow(left))?.status).toBe('expired');
    // Authorising the SAME account again lets nothing go.
    expect(await connect(second)).toBe('ok');
    expect(released()).toEqual([club.accountRef]);

    // Stripe does not answer: the new account is connected all the same, and
    // the owner is told the old grant is still there.
    stripeUp = false;
    expect(await connect(third)).toBe('ok_grant_kept');
    expect(await liveAccountRef(club)).toBe(third);
    expect(await audit(club, 'payment_account_connected')).toEqual([
      { provider: 'stripe', replaced: 'released' },
      { provider: 'stripe' },
      { provider: 'stripe', replaced: 'failed' },
    ]);
    // The same on a disconnect: done here, and said — not «disconnected» alone.
    expect(await disconnectAccount(db, club.owner)).toBe('ok_grant_kept');
    expect(await liveAccountRef(club)).toBeNull();
    expect(await audit(club, 'payment_account_disconnected')).toEqual([
      { provider: 'stripe', grant: 'failed' },
    ]);
  });

  it('refunds a second online payment on a charge a partial refund re-opened', async () => {
    fakeMode();
    const club = await makeClub('fake');
    const buyer = await makeBuyer(club, 'Върнал');
    const chargeId = await openCharge(club, buyer, 3000);
    const payOnline = async (): Promise<number> => {
      const started = await startChargeCheckout(
        db,
        buyer.userId,
        { id: club.id, slug: club.slug },
        chargeId,
        back,
      );
      if (!started.ok) throw new Error(started.error);
      expect(await fakeSettle(started.checkoutId, 'paid')).toBe(true);
      const paid = await db.execute(sql`
        SELECT id FROM club_payments
         WHERE charge_id = ${chargeId}::uuid AND kind = 'payment' AND method = 'card_online'
         ORDER BY id DESC LIMIT 1
      `);
      return Number(paid.rows[0]?.id);
    };
    const first = await payOnline();
    // 10,00 € of 30,00 € go back: the charge owes 10,00 € again, paid online.
    expect(await refundOnlinePayment(db, club.owner, first, 1000)).toEqual({ ok: true });
    const second = await payOnline();
    expect(second).not.toBe(first);

    // The earlier refund was of the FIRST payment — it was made before the
    // second existed — so the second is refundable in full.
    expect(await refundOnlinePayment(db, club.owner, second, null)).toEqual({ ok: true });
    // And the first keeps exactly what it has left: 20,00 €, not 30,00 €.
    expect(await refundOnlinePayment(db, club.owner, first, 2500)).toEqual({
      ok: false,
      error: 'amount_invalid',
    });
    expect(await refundOnlinePayment(db, club.owner, first, null)).toEqual({ ok: true });
    const books = await db.execute(sql`
      SELECT amount_cents FROM club_payments WHERE charge_id = ${chargeId}::uuid ORDER BY id
    `);
    expect(books.rows.map((row) => row.amount_cents)).toEqual([3000, -1000, 1000, -1000, -2000]);
  });

  it('sends two equal refunds of one payment as two requests', async () => {
    stripeMode();
    const club = await makeClub('stripe');
    const buyer = await makeBuyer(club, 'Два пъти');
    const chargeId = await openCharge(club, buyer, 3000);
    /** An online payment of what the charge owes, applied as the worker applies it. */
    const paid = async (amountCents: number): Promise<number> => {
      const id = randomUUID();
      const paymentRef = `pi_test_jp_${rand()}`;
      await db.execute(sql`
        INSERT INTO club_checkouts (id, club_id, purpose, member_id, charge_id, amount_cents,
                                    provider, account_ref, session_ref)
        VALUES (${id}::uuid, ${club.id}::uuid, 'charge', ${buyer.memberId}::uuid,
                ${chargeId}::uuid, ${amountCents}, 'stripe', ${club.accountRef},
                ${`cs_test_jp_${rand()}`})
      `);
      const applied = await applyCheckoutPaid(db, {
        checkoutId: id,
        provider: 'stripe',
        paymentRef,
        amountCents,
        currency: 'eur',
        subscriptionRef: null,
      });
      expect(applied.applied).toBe(true);
      const row = await db.execute(sql`
        SELECT id FROM club_payments WHERE provider_ref = ${paymentRef}
      `);
      return Number(row.rows[0]?.id);
    };
    // Stripe as it behaves: the same Idempotency-Key replays the first answer.
    const answered = new Map<string, string>();
    stripeStub((call) => {
      if (call.method !== 'POST' || call.path !== 'api.stripe.com/v1/refunds') return outage;
      const key = call.idempotencyKey ?? '';
      if (!answered.has(key)) answered.set(key, `re_test_jp_${rand()}`);
      return {
        body: {
          id: answered.get(key),
          amount: Number(call.form.get('amount')),
          currency: 'eur',
          status: 'succeeded',
        },
      };
    });
    const first = await paid(3000);
    expect(await refundOnlinePayment(db, club.owner, first, 1000)).toEqual({ ok: true });
    await paid(1000);
    // Two online payments stand on the charge. 5,00 € of the first goes back,
    // and then 5,00 € more: a second request, not a replay of the first.
    expect(await refundOnlinePayment(db, club.owner, first, 500)).toEqual({ ok: true });
    expect(await refundOnlinePayment(db, club.owner, first, 500)).toEqual({ ok: true });
    expect(answered.size).toBe(3);
    const books = await db.execute(sql`
      SELECT amount_cents FROM club_payments WHERE charge_id = ${chargeId}::uuid ORDER BY id
    `);
    expect(books.rows.map((row) => row.amount_cents)).toEqual([3000, -1000, 1000, -500, -500]);
  });

  it('treats a subscription already ended at Stripe as stopped', async () => {
    stripeMode();
    const club = await makeClub('stripe');
    const planId = await makePlan(club, { autoRenew: true });
    const gone = `sub_test_jp_${rand()}`;
    const ended = `sub_test_jp_${rand()}`;
    const live = `sub_test_jp_${rand()}`;
    const down = `sub_test_jp_${rand()}`;
    const buyers = {
      gone: await makeBuyer(club, 'Първи'),
      ended: await makeBuyer(club, 'Втори'),
      live: await makeBuyer(club, 'Трети'),
      down: await makeBuyer(club, 'Четвърти'),
    };
    await subscribed(club, buyers.gone, planId, gone);
    await subscribed(club, buyers.ended, planId, ended);
    await subscribed(club, buyers.live, planId, live);
    await subscribed(club, buyers.down, planId, down);
    stripeStub((call) => {
      const ref = call.path.split('/').pop();
      // Ended in the club's dashboard; its event never reached the books.
      if (ref === gone) return missing;
      // Stripe refuses to change an ended subscription with no code at all;
      // asked what it is now, it says.
      if (ref === ended) {
        return call.method === 'GET'
          ? { body: { id: ended, status: 'canceled' } }
          : { status: 400, body: { error: { type: 'invalid_request_error' } } };
      }
      // A refusal for a subscription that is alive is a refusal.
      if (ref === live) {
        return call.method === 'GET'
          ? { body: { id: live, status: 'active' } }
          : { status: 400, body: { error: { type: 'invalid_request_error' } } };
      }
      return outage;
    });
    const stop = (buyer: Buyer, when: 'now' | 'period_end') =>
      stopProviderSubscriptions(club.id, { memberId: buyer.memberId }, when);

    // Nothing left to stop: the erase, the archive, the cancel go ahead — and
    // the books stop expecting a renewal no event will ever report.
    expect(await stop(buyers.gone, 'now')).toBe(true);
    expect(await renews(gone)).toEqual([false]);
    expect(await stop(buyers.ended, 'period_end')).toBe(true);
    expect(await renews(ended)).toEqual([false]);
    // Still billing, or Stripe not answering: refused, and nothing is touched.
    expect(await stop(buyers.live, 'period_end')).toBe(false);
    expect(await renews(live)).toEqual([true]);
    expect(await stop(buyers.down, 'now')).toBe(false);
    expect(await renews(down)).toEqual([true]);
  });

  it("records a member's notice when their subscription is already gone at Stripe", async () => {
    stripeMode();
    const club = await makeClub('stripe');
    const buyer = await makeBuyer(club, 'Напускащ');
    const subscriptionRef = `sub_test_jp_${rand()}`;
    const membershipId = await subscribed(
      club,
      buyer,
      await makePlan(club, { autoRenew: true, selfCancel: true }),
      subscriptionRef,
    );
    stripeStub(() => missing);
    // The notice holds the chain's tail locked while the provider is asked:
    // the chain is marked through the SAME transaction, or it would wait on
    // its own lock for ever.
    const result = await memberStopRenewal(
      db,
      buyer.userId,
      club.id,
      membershipId,
      sofiaToday(),
      (tailId, endsOn, tx) =>
        stopProviderSubscriptions(club.id, { membershipId: tailId }, { at: endsOn }, tx),
    );
    expect(result.ok).toBe(true);
    const chain = await db.execute(sql`
      SELECT renews, renewal_ends_on IS NOT NULL AS noticed FROM club_memberships
       WHERE id = ${membershipId}::uuid
    `);
    expect(chain.rows).toEqual([{ renews: false, noticed: true }]);
  }, 20_000);
});
