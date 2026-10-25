import { getDb, recordPaymentEvent } from '@sportkarta/db';
import { CLUB_PAYMENT_EVENT_QUEUE, type ClubPaymentEventJob } from '@sportkarta/lib/clubs';
import { stripeSettings, verifyStripeSignature } from '@sportkarta/lib/payments';

import { getBoss, recordEnqueueFailure } from '@/lib/admin-boss';
import { clubsEnabled } from '@/lib/clubs/access';

/**
 * Stripe → POPS (0046). The ONLY thing this route trusts is the signature:
 * it verifies `Stripe-Signature` over the raw body, records the event id,
 * type, connected account and object id — never the payload — and hands the
 * row to the worker, which RE-FETCHES the object from Stripe before acting.
 * A forged or replayed body therefore changes nothing: it either fails the
 * signature or names an object whose real state the worker reads itself.
 *
 * Answers fast and always 2xx for a verified event, even one we ignore, so
 * Stripe stops retrying; 400 for anything that does not verify. The event id
 * is UNIQUE in club_payment_events, so Stripe's retries are recorded once.
 * Outside the i18n middleware (/api), so no cookie is ever set.
 */

export const dynamic = 'force-dynamic';

/** The events the worker acts on; everything else is acknowledged and dropped. */
const HANDLED = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'invoice.paid',
  'customer.subscription.deleted',
  'charge.refunded',
  'account.updated',
  'account.application.deauthorized',
]);

function reply(status: number): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  if (!clubsEnabled()) return reply(404);
  const settings = stripeSettings(process.env);
  if (!settings) return reply(404);
  // Refuse an oversized body before reading it; the second check catches a
  // request that lied about (or omitted) its length.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > 1_000_000) return reply(413);
  const raw = await request.text();
  if (raw.length > 1_000_000) return reply(413);
  const verdict = verifyStripeSignature(
    raw,
    request.headers.get('stripe-signature'),
    settings.webhookSecret,
  );
  if (!verdict.ok) return reply(400);

  let event: {
    id?: unknown;
    type?: unknown;
    account?: unknown;
    data?: { object?: { id?: unknown } };
  };
  try {
    event = JSON.parse(raw) as typeof event;
  } catch {
    return reply(400);
  }
  const type = typeof event.type === 'string' ? event.type : '';
  const eventId = typeof event.id === 'string' ? event.id : '';
  if (!HANDLED.has(type) || !/^evt_[A-Za-z0-9_]{4,255}$/.test(eventId)) return reply(200);
  const account =
    typeof event.account === 'string' && /^acct_[A-Za-z0-9_]{4,64}$/.test(event.account)
      ? event.account
      : null;
  const objectId = event.data?.object?.id;
  const objectRef =
    typeof objectId === 'string' && /^[A-Za-z0-9_-]{1,255}$/.test(objectId) ? objectId : null;

  const id = await recordPaymentEvent(getDb(), { eventId, type, accountRef: account, objectRef });
  if (id !== null) {
    const job: ClubPaymentEventJob = { eventId: id };
    try {
      const boss = await getBoss();
      await boss.send(CLUB_PAYMENT_EVENT_QUEUE, job, { singletonKey: String(id) });
    } catch {
      // The row is recorded; the worker's sweep picks it up within minutes.
      recordEnqueueFailure('send');
    }
  }
  return reply(200);
}
