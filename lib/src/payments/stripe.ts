/**
 * A minimal Stripe REST client — the dozen calls the club module makes, over
 * `fetch`, with no SDK (plan 2026-10-25). Server-only by use: it carries the
 * platform's secret key, so only route handlers, server actions and the
 * worker import it, never a client component (client-imports.test.ts).
 *
 * WHY NOT THE SDK: the surface we need is small and stable (Checkout
 * Sessions, invoices, subscriptions, refunds, charges, accounts, Connect
 * OAuth), a hand-written client is trivially faked in tests, and a payment
 * path with fewer dependencies is a smaller supply chain.
 *
 * CONNECT: every call that acts for a club passes `account` — the club's
 * connected account id — as the `Stripe-Account` header, so the charge is a
 * DIRECT charge on the club's account: the club is the merchant of record,
 * the money never touches the NGO's balance.
 *
 * Writes carry an `Idempotency-Key` from the caller (a row id we already
 * own), so a retried request cannot create a second Checkout Session or a
 * second refund.
 */

export interface StripeRequestOptions {
  /** The connected account to act for (Stripe-Account header). */
  account?: string;
  idempotencyKey?: string;
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    /** Stripe's error type/code — never a card detail or a person. */
    readonly code: string,
  ) {
    super(`stripe ${String(status)} ${code}`);
  }
}

type Param = string | number | boolean | null | undefined | Param[] | { [key: string]: Param };

/** Stripe's form encoding: nested objects as a[b]=…, arrays as a[0][b]=…. */
export function encodeForm(params: Record<string, Param>, prefix = ''): string {
  const parts: string[] = [];
  const walk = (value: Param, key: string) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${key}[${String(index)}]`));
    } else if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${key}[${k}]`);
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  };
  for (const [k, v] of Object.entries(params)) walk(v, prefix ? `${prefix}[${k}]` : k);
  return parts.join('&');
}

export interface CheckoutSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  amount_total: number | null;
  currency: string | null;
  payment_intent: string | null;
  subscription: string | null;
  /** Subscription mode: the first invoice (its payment_intent is the payment). */
  invoice: string | null;
  client_reference_id: string | null;
  metadata: Record<string, string>;
}

export interface Invoice {
  id: string;
  status: string;
  amount_paid: number;
  /** What the invoice asks for — the figure of a failed collection. */
  amount_due: number;
  currency: string;
  subscription: string | null;
  payment_intent: string | null;
  billing_reason: string | null;
  period_start: number;
  period_end: number;
  lines?: { data: { period: { start: number; end: number } }[] };
}

export interface Subscription {
  id: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: number;
  metadata: Record<string, string>;
}

export interface Refund {
  id: string;
  amount: number;
  currency: string;
  status: string;
  payment_intent: string | null;
}

export interface Charge {
  id: string;
  payment_intent: string | null;
  amount_refunded: number;
  refunds?: { data: Refund[] };
}

export interface Account {
  id: string;
  charges_enabled: boolean;
  details_submitted: boolean;
}

export interface StripeClient {
  createCheckoutSession(
    params: Record<string, Param>,
    options: StripeRequestOptions,
  ): Promise<CheckoutSession>;
  retrieveCheckoutSession(id: string, options: StripeRequestOptions): Promise<CheckoutSession>;
  retrieveInvoice(id: string, options: StripeRequestOptions): Promise<Invoice>;
  retrieveSubscription(id: string, options: StripeRequestOptions): Promise<Subscription>;
  cancelSubscriptionAtPeriodEnd(id: string, options: StripeRequestOptions): Promise<Subscription>;
  /**
   * End a subscription at a moment (unix seconds) — the end of a member's
   * notice — with no proration, so billing stops where the contract does.
   */
  cancelSubscriptionAt(
    id: string,
    atUnixSeconds: number,
    options: StripeRequestOptions,
  ): Promise<Subscription>;
  /** End a subscription now (the member's record is being erased). */
  cancelSubscriptionNow(id: string, options: StripeRequestOptions): Promise<Subscription>;
  /** Close an open Checkout Session so it can no longer be paid. */
  expireCheckoutSession(id: string, options: StripeRequestOptions): Promise<CheckoutSession>;
  createRefund(
    params: { payment_intent: string; amount: number },
    options: StripeRequestOptions,
  ): Promise<Refund>;
  retrieveCharge(id: string, options: StripeRequestOptions): Promise<Charge>;
  retrieveAccount(id: string): Promise<Account>;
  /** Connect OAuth: exchange the authorisation code for the connected account id. */
  oauthToken(code: string): Promise<{ stripe_user_id: string }>;
  /** Connect OAuth: the platform lets go of a connected account. */
  oauthDeauthorize(clientId: string, accountId: string): Promise<void>;
}

const API = 'https://api.stripe.com/v1';
const CONNECT = 'https://connect.stripe.com/oauth';
/** Pinned so a dashboard default can never change the shapes we read. */
export const STRIPE_API_VERSION = '2024-06-20';

export function createStripeClient(options: {
  secretKey: string;
  fetch?: typeof fetch;
}): StripeClient {
  const doFetch = options.fetch ?? fetch;

  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    params: Record<string, Param> | null,
    request: StripeRequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${options.secretKey}`,
      'Stripe-Version': STRIPE_API_VERSION,
    };
    if (request.account) headers['Stripe-Account'] = request.account;
    if (request.idempotencyKey) headers['Idempotency-Key'] = request.idempotencyKey;
    let target = url;
    let body: string | undefined;
    if (params && method === 'GET') {
      const query = encodeForm(params);
      if (query) target = `${url}?${query}`;
    } else if (params) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(params);
    }
    const response = await doFetch(target, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(15_000),
    });
    interface StripeBody {
      error?: { type?: string; code?: string };
    }
    let json: StripeBody | null = null;
    try {
      json = (await response.json()) as StripeBody;
    } catch {
      json = null;
    }
    if (!response.ok) {
      throw new StripeError(response.status, json?.error?.code ?? json?.error?.type ?? 'unknown');
    }
    // A 2xx whose body is not JSON (a proxy page, a truncated stream) is NOT an
    // empty object: treated as one, a webhook event would be marked processed
    // with nothing applied. A coded error propagates, so the event is retried.
    if (json === null || typeof json !== 'object')
      throw new StripeError(response.status, 'bad_json');
    return json as T;
  }

  const id = (value: string) => encodeURIComponent(value);
  return {
    createCheckoutSession: (params, request) =>
      call<CheckoutSession>('POST', `${API}/checkout/sessions`, params, request),
    retrieveCheckoutSession: (sessionId, request) =>
      call<CheckoutSession>('GET', `${API}/checkout/sessions/${id(sessionId)}`, null, request),
    retrieveInvoice: (invoiceId, request) =>
      call<Invoice>('GET', `${API}/invoices/${id(invoiceId)}`, null, request),
    retrieveSubscription: (subscriptionId, request) =>
      call<Subscription>('GET', `${API}/subscriptions/${id(subscriptionId)}`, null, request),
    cancelSubscriptionAtPeriodEnd: (subscriptionId, request) =>
      call<Subscription>(
        'POST',
        `${API}/subscriptions/${id(subscriptionId)}`,
        { cancel_at_period_end: true },
        request,
      ),
    cancelSubscriptionAt: (subscriptionId, at, request) =>
      call<Subscription>(
        'POST',
        `${API}/subscriptions/${id(subscriptionId)}`,
        { cancel_at: at, proration_behavior: 'none' },
        request,
      ),
    cancelSubscriptionNow: (subscriptionId, request) =>
      call<Subscription>('DELETE', `${API}/subscriptions/${id(subscriptionId)}`, null, request),
    expireCheckoutSession: (sessionId, request) =>
      call<CheckoutSession>(
        'POST',
        `${API}/checkout/sessions/${id(sessionId)}/expire`,
        null,
        request,
      ),
    createRefund: (params, request) =>
      call<Refund>('POST', `${API}/refunds`, { ...params }, request),
    retrieveCharge: (chargeId, request) =>
      call<Charge>('GET', `${API}/charges/${id(chargeId)}`, { 'expand[]': 'refunds' }, request),
    retrieveAccount: (accountId) => call<Account>('GET', `${API}/accounts/${id(accountId)}`, null),
    oauthToken: (code) =>
      call<{ stripe_user_id: string }>('POST', `${CONNECT}/token`, {
        grant_type: 'authorization_code',
        code,
      }),
    oauthDeauthorize: async (clientId, accountId) => {
      await call<unknown>('POST', `${CONNECT}/deauthorize`, {
        client_id: clientId,
        stripe_user_id: accountId,
      });
    },
  };
}

/** A connected account id, as Stripe issues them. */
export function isStripeAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^acct_[A-Za-z0-9]{8,64}$/.test(value);
}

/** Stripe object ids we store as provider references (cs_, pi_, in_, sub_, re_, ch_). */
export function isStripeObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]{2,4}_[A-Za-z0-9_]{8,200}$/.test(value);
}
