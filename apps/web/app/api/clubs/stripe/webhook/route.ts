import { getDb, recordPaymentEvent } from '@sportkarta/db';
import { CLUB_PAYMENT_EVENT_QUEUE, type ClubPaymentEventJob } from '@sportkarta/lib/clubs';
import { stripeSettings, verifyStripeSignature } from '@sportkarta/lib/payments';

import { getBoss, recordEnqueueFailure } from '@/lib/admin-boss';
import { readCappedText } from '@/lib/clubs/api';

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
  'invoice.payment_failed',
  'customer.subscription.deleted',
  'charge.refunded',
  'account.updated',
  'account.application.deauthorized',
]);

function reply(status: number): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(request: Request): Promise<Response> {
  // Not gated on CLUBS_ENABLED or CLUB_PAYMENTS_ENABLED: money events arrive
  // whenever a club's Stripe account is connected, and Stripe gives up on a
  // 404 after three days. The keys decide. The worker applies EVERY recorded
  // event whatever the payments switch says — by design: a refund, a revoked
  // account or a renewal billed while the switch is off must still reach the
  // books; the switch only stops NEW checkouts and connections from starting.
  const settings = stripeSettings(process.env);
  if (!settings) return reply(404);
  // Read at most 1 MB, cancelling the stream past it — a chunked body never
  // declares its length, so the cap is enforced while reading.
  const raw = await readCappedText(request, 1_000_000);
  if (raw === null) return reply(413);
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
    livemode?: unknown;
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
  // The event's mode must be the key's mode: a test event reaching a live
  // endpoint (or the reverse) is acknowledged, dropped and logged — never
  // recorded. It matters most for the two events the worker acts on from the
  // signed body alone, with no re-fetch to catch the mix-up
  // (account.application.deauthorized, checkout.session.expired).
  const liveKey = /^(sk|rk)_live_/.test(settings.secretKey);
  if (typeof event.livemode !== 'boolean' || event.livemode !== liveKey) {
    console.warn(`[stripe webhook] ${type}: livemode disagrees with the key — dropped`);
    return reply(200);
  }
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
