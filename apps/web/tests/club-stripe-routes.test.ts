import { stripeSignatureFor } from '@sportkarta/lib/payments';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two doors Stripe uses into POPS (0046), refused properly:
 *   - the webhook trusts ONLY its signature, records an event once, and
 *     acknowledges (without recording) anything it does not act on;
 *   - the Connect OAuth `state` is ours, fresh, and unforgeable.
 * The database and the queue are stand-ins: what is under test is what each
 * door lets through.
 */

// lib/clubs/payments.ts is `server-only`, a marker Next resolves from its own
// bundle. (Hoisted above the imports, like every vi.mock here.)
vi.mock('server-only', () => ({}));

const recordPaymentEvent = vi.fn<(...args: unknown[]) => Promise<number | null>>();
const send = vi.fn(async () => 'job');
vi.mock('@sportkarta/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sportkarta/db')>()),
  getDb: () => ({}),
  recordPaymentEvent: (...args: unknown[]) => recordPaymentEvent(...args),
}));
vi.mock('@/lib/admin-boss', () => ({
  getBoss: async () => ({ send }),
  recordEnqueueFailure: vi.fn(),
}));
vi.mock('@/lib/clubs/access', () => ({ clubsEnabled: () => true }));

const WEBHOOK_SECRET = 'whsec_test0123456789abcdef';

function stripeEnv(): void {
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_0123456789abcdef');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
  vi.stubEnv('STRIPE_CONNECT_CLIENT_ID', 'ca_test0123456789abcdef');
  vi.stubEnv('AUTH_SECRET', 'a-test-only-auth-secret-of-sufficient-length-0123');
}

function signed(body: string, secret = WEBHOOK_SECRET, headers: Record<string, string> = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  return new Request('http://localhost/api/clubs/stripe/webhook', {
    method: 'POST',
    body,
    headers: {
      'stripe-signature': `t=${String(timestamp)},v1=${stripeSignatureFor(body, timestamp, secret)}`,
      ...headers,
    },
  });
}

function event(type: string, id = 'evt_test_0001') {
  return JSON.stringify({
    id,
    type,
    account: 'acct_test_route01',
    data: { object: { id: 'cs_test_route01' } },
  });
}

describe('the Stripe webhook route', () => {
  beforeEach(() => {
    stripeEnv();
    recordPaymentEvent.mockReset();
    send.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses a body signed with another secret, recording nothing', async () => {
    const { POST } = await import('../app/api/clubs/stripe/webhook/route');
    const response = await POST(
      signed(event('checkout.session.completed'), 'whsec_attacker0123456789'),
    );
    expect(response.status).toBe(400);
    expect(recordPaymentEvent).not.toHaveBeenCalled();
  });

  it('refuses an unsigned body', async () => {
    const { POST } = await import('../app/api/clubs/stripe/webhook/route');
    const response = await POST(
      new Request('http://localhost/api/clubs/stripe/webhook', {
        method: 'POST',
        body: event('checkout.session.completed'),
      }),
    );
    expect(response.status).toBe(400);
    expect(recordPaymentEvent).not.toHaveBeenCalled();
  });

  it('acknowledges an event it does not act on, without recording it', async () => {
    const { POST } = await import('../app/api/clubs/stripe/webhook/route');
    const response = await POST(signed(event('customer.created')));
    expect(response.status).toBe(200);
    expect(recordPaymentEvent).not.toHaveBeenCalled();
  });

  it('records ids only and queues the event once; a re-delivery queues nothing', async () => {
    const { POST } = await import('../app/api/clubs/stripe/webhook/route');
    recordPaymentEvent.mockResolvedValueOnce(42);
    expect((await POST(signed(event('checkout.session.completed')))).status).toBe(200);
    expect(recordPaymentEvent).toHaveBeenCalledWith(expect.anything(), {
      eventId: 'evt_test_0001',
      type: 'checkout.session.completed',
      accountRef: 'acct_test_route01',
      objectRef: 'cs_test_route01',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'club.payment_event',
      { eventId: 42 },
      { singletonKey: '42' },
    );

    recordPaymentEvent.mockResolvedValueOnce(null);
    expect((await POST(signed(event('checkout.session.completed')))).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversized body before reading it', async () => {
    const { POST } = await import('../app/api/clubs/stripe/webhook/route');
    const response = await POST(
      signed(event('checkout.session.completed'), WEBHOOK_SECRET, {
        'content-length': '5000000',
      }),
    );
    expect(response.status).toBe(413);
    expect(recordPaymentEvent).not.toHaveBeenCalled();
  });
});

describe('the Connect OAuth state', () => {
  beforeEach(stripeEnv);
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const CLUB = '00000000-0000-4000-8000-0000000000aa';
  const USER = 'user_test_owner';

  it('round-trips for the club and the person it was issued to', async () => {
    const { signConnectState, verifyConnectState } = await import('@/lib/clubs/payments');
    const now = Date.now();
    expect(verifyConnectState(signConnectState(CLUB, USER, now), now + 1000)).toEqual({
      clubId: CLUB,
      userId: USER,
    });
  });

  it('refuses a state naming another club or person, an expired one, and junk', async () => {
    const { signConnectState, verifyConnectState } = await import('@/lib/clubs/payments');
    const now = Date.now();
    const state = signConnectState(CLUB, USER, now);
    const [, , issued, signature] = state.split('.');
    const otherClub = '00000000-0000-4000-8000-0000000000bb';
    expect(verifyConnectState(`${otherClub}.${USER}.${issued}.${signature}`, now)).toBeNull();
    expect(verifyConnectState(`${CLUB}.user_test_thief.${issued}.${signature}`, now)).toBeNull();
    // 30 minutes is the life of a state; issued in the future is refused too.
    expect(verifyConnectState(state, now + 31 * 60 * 1000)).toBeNull();
    expect(verifyConnectState(signConnectState(CLUB, USER, now + 5 * 60 * 1000), now)).toBeNull();
    expect(verifyConnectState('', now)).toBeNull();
    expect(verifyConnectState('a.b.c', now)).toBeNull();
  });

  it('refuses a state signed under another secret', async () => {
    const { signConnectState, verifyConnectState } = await import('@/lib/clubs/payments');
    const now = Date.now();
    const state = signConnectState(CLUB, USER, now);
    vi.stubEnv('AUTH_SECRET', 'a-different-auth-secret-of-sufficient-length-9876');
    expect(verifyConnectState(state, now)).toBeNull();
  });
});
