import { describe, expect, it } from 'vitest';

import {
  applicationFeeCents,
  createStripeClient,
  encodeForm,
  isStripeAccountId,
  resolvePaymentProvider,
  stripeSettings,
  stripeSignatureFor,
  verifyStripeSignature,
  StripeError,
} from './index.js';

const SECRET = 'whsec_testsecretvalue0001';

describe('Stripe webhook signatures', () => {
  const body = '{"id":"evt_123","type":"checkout.session.completed"}';
  const now = 1_790_000_000;

  it('accepts a genuine, fresh signature', () => {
    const header = `t=${String(now)},v1=${stripeSignatureFor(body, now, SECRET)}`;
    expect(verifyStripeSignature(body, header, SECRET, now)).toEqual({ ok: true, timestamp: now });
  });

  it('accepts any one of several v1 signatures (secret rotation)', () => {
    const good = stripeSignatureFor(body, now, SECRET);
    const header = `t=${String(now)},v1=${'0'.repeat(64)},v1=${good}`;
    expect(verifyStripeSignature(body, header, SECRET, now).ok).toBe(true);
  });

  it('refuses a tampered body and a wrong secret', () => {
    const header = `t=${String(now)},v1=${stripeSignatureFor(body, now, SECRET)}`;
    expect(verifyStripeSignature(`${body} `, header, SECRET, now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
    expect(verifyStripeSignature(body, header, 'whsec_other', now)).toEqual({
      ok: false,
      reason: 'mismatch',
    });
  });

  it('checks the signature BEFORE the time: a forgery is a mismatch, not stale', () => {
    const old = now - 3600;
    expect(
      verifyStripeSignature(body, `t=${String(old)},v1=${'a'.repeat(64)}`, SECRET, now),
    ).toEqual({ ok: false, reason: 'mismatch' });
    const genuineOld = `t=${String(old)},v1=${stripeSignatureFor(body, old, SECRET)}`;
    expect(verifyStripeSignature(body, genuineOld, SECRET, now)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('refuses a malformed or missing header', () => {
    expect(verifyStripeSignature(body, null, SECRET, now).ok).toBe(false);
    expect(verifyStripeSignature(body, 'v1=abc', SECRET, now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyStripeSignature(body, `t=${String(now)}`, SECRET, now)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

describe('the provider resolves fail-closed', () => {
  const stripeEnv = {
    STRIPE_SECRET_KEY: 'sk_test_abcdefghijklmnop',
    STRIPE_WEBHOOK_SECRET: 'whsec_abcdefghijklmnop',
    STRIPE_CONNECT_CLIENT_ID: 'ca_abcdefghijklmnop',
  };

  it('never resolves the fake provider in production', () => {
    expect(resolvePaymentProvider({ NODE_ENV: 'production', PAYMENT_PROVIDER: 'fake' })).toBe(
      'disabled',
    );
    expect(resolvePaymentProvider({ NODE_ENV: 'production' })).toBe('disabled');
    expect(resolvePaymentProvider({ NODE_ENV: 'development' })).toBe('fake');
  });

  it('needs every Stripe setting for stripe', () => {
    expect(resolvePaymentProvider({ PAYMENT_PROVIDER: 'stripe', ...stripeEnv })).toBe('stripe');
    expect(
      resolvePaymentProvider({
        PAYMENT_PROVIDER: 'stripe',
        ...stripeEnv,
        STRIPE_WEBHOOK_SECRET: '',
      }),
    ).toBe('disabled');
    expect(resolvePaymentProvider({ PAYMENT_PROVIDER: 'nonsense' })).toBe('disabled');
  });

  it('caps the platform fee and never charges more than the amount', () => {
    expect(
      stripeSettings({ ...stripeEnv, STRIPE_APPLICATION_FEE_BP: '99999' })?.applicationFeeBp,
    ).toBe(0);
    expect(
      stripeSettings({ ...stripeEnv, STRIPE_APPLICATION_FEE_BP: '150' })?.applicationFeeBp,
    ).toBe(150);
    expect(applicationFeeCents(5000, 150)).toBe(75);
    expect(applicationFeeCents(5000, 0)).toBe(0);
    expect(applicationFeeCents(1, 2000)).toBe(0);
  });
});

describe('the Stripe client', () => {
  it('form-encodes nested objects and arrays the Stripe way', () => {
    expect(
      encodeForm({
        mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: 'eur', unit_amount: 5000 } }],
        metadata: { checkout: 'abc' },
        skip: undefined,
      }),
    ).toBe(
      'mode=payment&line_items%5B0%5D%5Bquantity%5D=1' +
        '&line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=eur' +
        '&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=5000&metadata%5Bcheckout%5D=abc',
    );
  });

  it('acts for the club with Stripe-Account and an idempotency key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createStripeClient({
      secretKey: 'sk_test_abcdefghijklmnop',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(
          JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/x' }),
          {
            status: 200,
          },
        );
      }) as unknown as typeof fetch,
    });
    const session = await client.createCheckoutSession(
      { mode: 'payment' },
      { account: 'acct_1234567890', idempotencyKey: 'chk_1' },
    );
    expect(session.id).toBe('cs_test_1');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(headers['Stripe-Account']).toBe('acct_1234567890');
    expect(headers['Idempotency-Key']).toBe('chk_1');
    expect(headers.Authorization).toBe('Bearer sk_test_abcdefghijklmnop');
  });

  it('ends a subscription at the notice, with no proration', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createStripeClient({
      secretKey: 'sk_test_abcdefghijklmnop',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ id: 'sub_1', status: 'active' }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.cancelSubscriptionAt('sub_1', 1_790_000_000, { account: 'acct_1234567890' });
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/subscriptions/sub_1');
    expect(calls[0]?.init.method).toBe('POST');
    expect(String(calls[0]?.init.body)).toBe('cancel_at=1790000000&proration_behavior=none');
  });

  it('turns an error response into a coded StripeError without the message', async () => {
    const client = createStripeClient({
      secretKey: 'sk_test_abcdefghijklmnop',
      fetch: (async () =>
        new Response(JSON.stringify({ error: { type: 'card_error', code: 'card_declined' } }), {
          status: 402,
        })) as unknown as typeof fetch,
    });
    await expect(client.retrieveCheckoutSession('cs_1', {})).rejects.toMatchObject({
      status: 402,
      code: 'card_declined',
    });
    await expect(client.retrieveCheckoutSession('cs_1', {})).rejects.toBeInstanceOf(StripeError);
  });

  it('recognises connected account ids', () => {
    expect(isStripeAccountId('acct_1Nv0FGQ9RKHgCVdK')).toBe(true);
    expect(isStripeAccountId('acct_')).toBe(false);
    expect(isStripeAccountId('cus_1Nv0FGQ9RKHgCVdK')).toBe(false);
  });
});
