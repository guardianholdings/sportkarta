import {
  applyCheckoutPaid,
  applySubscriptionInvoice,
  expireCheckout,
  expireReservationHolds,
  getDb,
  markPaymentAccountGone,
  markPaymentEvent,
  paymentEventById,
  pendingPaymentEventIds,
  prunePaymentEvents,
  recordProviderRefund,
  setPaymentAccountState,
  stopSubscription,
  type PaymentEvent,
} from '@sportkarta/db';
import { createStripeClient, stripeSettings, type StripeClient } from '@sportkarta/lib/payments';

/**
 * Apply a verified Stripe webhook event (0046). The web route recorded only
 * the event's id, type, connected account and object id; THIS job fetches the
 * object from Stripe — as the club's connected account — and acts on what
 * Stripe says now, never on what a request body said. Each outcome is
 * recorded on the event row (applied / ignored / failed); an event that
 * throws is retried by pg-boss, and the 10-minute sweep picks up any event
 * whose enqueue was lost.
 *
 * NO PII IN LOGS: the caller logs the event type and outcome only.
 */

export type PaymentEventOutcome = 'applied' | 'ignored' | 'failed';

function client(): StripeClient | null {
  const settings = stripeSettings(process.env);
  return settings ? createStripeClient({ secretKey: settings.secretKey }) : null;
}

/**
 * Money arrived that will not be applied (the checkout was closed, the charge
 * was settled at the desk, the notice has ended): end its subscription now,
 * or the card is billed every month for periods nobody records.
 */
async function endSubscription(
  stripe: StripeClient,
  subscriptionRef: string | null | undefined,
  account: string,
): Promise<void> {
  if (!subscriptionRef) return;
  await stripe.cancelSubscriptionNow(subscriptionRef, { account });
}

async function apply(event: PaymentEvent, stripe: StripeClient): Promise<PaymentEventOutcome> {
  const db = getDb();
  const account = event.accountRef ?? undefined;
  const ref = event.objectRef;
  if (!ref) return 'ignored';
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (!account) return 'ignored';
      const session = await stripe.retrieveCheckoutSession(ref, { account });
      if (session.payment_status !== 'paid' || session.status !== 'complete') return 'ignored';
      // A subscription's first payment is its first invoice's PaymentIntent —
      // the reference a later refund (charge.refunded) is matched by.
      let paymentRef = session.payment_intent;
      if (!paymentRef && session.invoice) {
        const invoice = await stripe.retrieveInvoice(session.invoice, { account });
        paymentRef = invoice.payment_intent ?? invoice.id;
      }
      paymentRef ??= session.id;
      const result = await applyCheckoutPaid(db, {
        sessionRef: session.id,
        accountRef: account,
        provider: 'stripe',
        paymentRef,
        amountCents: session.amount_total ?? 0,
        subscriptionRef: session.subscription,
      });
      if (result.applied) return 'applied';
      if (result.reason === 'unknown_or_done') return 'ignored';
      // `unapplied`: listed for the office to refund; a subscription behind
      // it must not keep billing.
      await endSubscription(stripe, result.subscriptionRef, account);
      return 'failed';
    }
    case 'checkout.session.async_payment_failed':
    case 'checkout.session.expired':
      return (await expireCheckout(db, ref)) ? 'applied' : 'ignored';
    case 'invoice.paid': {
      if (!account) return 'ignored';
      const invoice = await stripe.retrieveInvoice(ref, { account });
      // Only a renewal cycle is a new period. The first invoice IS the
      // checkout (checkout.session.completed applies it), and a proration
      // invoice from a dashboard edit is not a period at all.
      if (!invoice.subscription || invoice.billing_reason !== 'subscription_cycle') {
        return 'ignored';
      }
      if (invoice.status !== 'paid' || invoice.amount_paid <= 0) return 'ignored';
      const result = await applySubscriptionInvoice(db, {
        provider: 'stripe',
        subscriptionRef: invoice.subscription,
        paymentRef: invoice.payment_intent ?? invoice.id,
        amountCents: invoice.amount_paid,
      });
      if (result.applied) return 'applied';
      if (result.reason === 'duplicate' || result.reason === 'no_chain') return 'ignored';
      // The office stopped renewing, or the notice has ended, yet Stripe
      // billed: no period is invented, and the subscription ends now.
      await endSubscription(stripe, invoice.subscription, account);
      return 'failed';
    }
    case 'customer.subscription.deleted': {
      if (!account) return 'ignored';
      const subscription = await stripe.retrieveSubscription(ref, { account });
      if (subscription.status !== 'canceled') return 'ignored';
      return (await stopSubscription(db, subscription.id)) > 0 ? 'applied' : 'ignored';
    }
    case 'charge.refunded': {
      if (!account) return 'ignored';
      const charge = await stripe.retrieveCharge(ref, { account });
      if (!charge.payment_intent) return 'ignored';
      let any = false;
      for (const refund of charge.refunds?.data ?? []) {
        if (refund.status !== 'succeeded') continue;
        any =
          (await recordProviderRefund(
            db,
            {
              provider: 'stripe',
              paymentRef: charge.payment_intent,
              refundRef: refund.id,
              amountCents: refund.amount,
            },
            null,
          )) || any;
      }
      return any ? 'applied' : 'ignored';
    }
    case 'account.updated': {
      const state = await stripe.retrieveAccount(ref);
      await setPaymentAccountState(db, state.id, state.charges_enabled === true);
      return 'applied';
    }
    case 'account.application.deauthorized': {
      if (!account) return 'ignored';
      await markPaymentAccountGone(db, account, event.receivedAt);
      return 'applied';
    }
    default:
      return 'ignored';
  }
}

export async function runClubPaymentEvent(
  id: number,
): Promise<{ type: string; outcome: PaymentEventOutcome } | null> {
  const db = getDb();
  const event = await paymentEventById(db, id);
  if (!event) return null;
  const stripe = client();
  // Not configured: the event stays PENDING (a throw, retried, then swept),
  // so nothing is lost while the operator sets the keys.
  if (!stripe) throw new Error('club.payment_event: Stripe is not configured on the worker');
  // A throw propagates: pg-boss retries the job, the row stays unprocessed.
  const outcome = await apply(event, stripe);
  await markPaymentEvent(db, id, outcome);
  return { type: event.type, outcome };
}

/**
 * The backlog: events recorded but never processed (a lost enqueue), and the
 * 90-day retention of processed ones (0046's header).
 */
export async function sweepClubPaymentEvents(): Promise<number> {
  const ids = await pendingPaymentEventIds(getDb());
  let done = 0;
  for (const id of ids) {
    try {
      if (await runClubPaymentEvent(id)) done += 1;
    } catch (error: unknown) {
      // Left unprocessed for the next sweep. The row id and the error's name
      // only — never an account, an amount or a person.
      console.warn(
        `[worker] club.payment_event sweep: event ${String(id)} still pending (${
          error instanceof Error ? error.name : 'error'
        })`,
      );
    }
  }
  // Slots held for a payment that never came (0048) — after the backlog, so a
  // payment whose event was only waiting confirms its hold first; and on its
  // own, so a failing prune never leaves slots held. The booking path also
  // releases a lapsed hold on its own slot at once.
  try {
    await expireReservationHolds(getDb());
  } catch (error: unknown) {
    console.warn(
      `[worker] club holds sweep failed (${error instanceof Error ? error.name : 'error'})`,
    );
  }
  await prunePaymentEvents(getDb());
  return done;
}
