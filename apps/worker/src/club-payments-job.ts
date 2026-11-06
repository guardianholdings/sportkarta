import {
  applyCheckoutPaid,
  applySubscriptionInvoice,
  expireCheckout,
  expireEventHolds,
  expireReservationHolds,
  getDb,
  markPaymentAccountGone,
  markPaymentEvent,
  paymentEventById,
  pendingPaymentEventIds,
  providerPaymentKnown,
  prunePaymentEvents,
  recordProviderRefund,
  recordRenewalPaymentFailed,
  recordUnappliedRenewal,
  setPaymentAccountState,
  stopSubscription,
  subscriptionCancelOwed,
  type OnlineProvider,
  type PaymentEvent,
} from '@sportkarta/db';
import type { ClubNotifyJob } from '@sportkarta/lib/clubs';
import {
  createStripeClient,
  resolvePaymentProvider,
  StripeError,
  stripeSettings,
  type StripeClient,
} from '@sportkarta/lib/payments';

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
 *
 * CURRENCY: every checkout and every subscription POPS opens is in EUR, so an
 * amount is compared only once its currency is `eur` — 4500 of anything else
 * is not 45,00 €. Anything else goes the `unapplied` way with its own reason.
 *
 * NOTICES: an event that someone must be told about (a revoked account, a
 * failed renewal) becomes `club.notify` jobs — ids and counts only — sent
 * through the caller's `enqueue` BEFORE the event is marked processed. The
 * order matters: marked first, a crash or a refused send between the two
 * would lose the notice for good (the retry finds processed_at set). Sent
 * first, a crash between the two leaves the event pending; the retry then
 * re-derives the same notice from what the first run wrote (the audit row of
 * a revoke carries the event id, a failed renewal is keyed by its invoice)
 * and the notifications ledger dedupes the double. The places a sweep
 * promotes (0053) are handed back as before — nothing was marked for them.
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
  try {
    await stripe.cancelSubscriptionNow(subscriptionRef, { account });
  } catch (error: unknown) {
    // Already ended (an earlier visit's cancel did land, or the club ended
    // it in its dashboard): nothing left to end. Anything else propagates,
    // so the event is retried and the cancel asked for again.
    if (
      error instanceof StripeError &&
      (error.status === 404 || error.code === 'resource_missing')
    ) {
      return;
    }
    throw error;
  }
}

/**
 * How long a refund waits for the payment it refunds to reach the books (its
 * own event may still be retried after a Stripe 5xx on the re-fetch). After
 * that it is a payment POPS never took — the club's own sale at Stripe.
 */
const PAYMENT_WAIT_MS = 60 * 60_000;

async function apply(
  event: PaymentEvent,
  stripe: StripeClient,
  notify: ClubNotifyJob[],
): Promise<PaymentEventOutcome> {
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
        currency: session.currency,
        subscriptionRef: session.subscription,
      });
      if (result.applied) return 'applied';
      if (result.reason === 'unknown_or_done') {
        // Settled on an earlier visit. If that visit left a subscription to
        // end — its cancel call failed after the `unapplied` commit — this
        // retry ends it; otherwise there is nothing to do.
        if (session.subscription && (await subscriptionCancelOwed(db, session.subscription))) {
          await endSubscription(stripe, session.subscription, account);
          return 'failed';
        }
        return 'ignored';
      }
      // `unapplied`: listed for the office to refund; a subscription behind
      // it must not keep billing. A cancel that fails here is asked for
      // again on the retry (subscriptionCancelOwed, above).
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
        currency: invoice.currency,
      });
      if (result.applied) return 'applied';
      if (result.reason === 'duplicate') return 'ignored';
      if (result.reason === 'no_chain') {
        // No chain carries this subscription: the club's own business at
        // Stripe — unless a checkout of ours opened it and its first payment
        // went `unapplied` (and the cancel then failed). That one is listed
        // and ended like every renewal the books refuse.
        if (!(await subscriptionCancelOwed(db, invoice.subscription))) return 'ignored';
      }
      // The office stopped renewing, the notice has ended, the chain was
      // never opened, or the money is not in EUR — yet Stripe billed: no
      // period is invented, the money is listed for the office to refund, and
      // the subscription ends now.
      await recordUnappliedRenewal(db, {
        provider: 'stripe',
        accountRef: account,
        subscriptionRef: invoice.subscription,
        paymentRef: invoice.payment_intent ?? invoice.id,
        amountCents: invoice.amount_paid,
        chain: result.chain ?? null,
      });
      await endSubscription(stripe, invoice.subscription, account);
      return 'failed';
    }
    case 'invoice.payment_failed': {
      if (!account) return 'ignored';
      const invoice = await stripe.retrieveInvoice(ref, { account });
      // Only a renewal cycle: a first invoice that fails is a checkout that
      // never completed (its own events say so), a proration is no period.
      if (!invoice.subscription || invoice.billing_reason !== 'subscription_cycle') {
        return 'ignored';
      }
      // Paid meanwhile (a retry succeeded before this ran): invoice.paid tells it.
      if (invoice.status === 'paid') return 'ignored';
      const failed = await recordRenewalPaymentFailed(db, {
        provider: 'stripe',
        subscriptionRef: invoice.subscription,
        invoiceRef: invoice.id,
        amountCents: invoice.amount_due,
        currency: invoice.currency,
      });
      if (!failed) {
        // No chain of ours: the club's own business at Stripe — unless a
        // checkout of ours opened it and its first payment went `unapplied`
        // (and the cancel then failed): ended here, as on invoice.paid.
        if (await subscriptionCancelOwed(db, invoice.subscription)) {
          await endSubscription(stripe, invoice.subscription, account);
          return 'applied';
        }
        return 'ignored';
      }
      // Told once per invoice — whether THIS run recorded the failure or an
      // earlier one did and died before its notice went (the ledger dedupes
      // the double). Stripe's own retries of the invoice raise the event
      // again and are recorded, and told, once.
      notify.push({
        kind: 'renewal_payment_failed',
        membershipId: failed.membershipId,
        invoiceRef: invoice.id,
      });
      return failed.recorded ? 'applied' : 'ignored';
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
      // A refund is in its charge's currency, and every charge of ours is in
      // EUR; anything else is not a refund of money these books hold.
      const refunds = (charge.refunds?.data ?? []).filter(
        (r) => r.status === 'succeeded' && r.currency === 'eur',
      );
      if (refunds.length === 0) return 'ignored';
      if (!(await providerPaymentKnown(db, 'stripe', charge.payment_intent))) {
        // A refund of a payment not yet in the books: the payment's own
        // event may still be retried, so this one waits (a throw keeps it
        // pending; the sweep brings it back). After an hour it is a payment
        // POPS never took and is dropped.
        if (Date.now() - event.receivedAt.getTime() < PAYMENT_WAIT_MS) {
          throw new Error('club.payment_event: refund before its payment, waiting');
        }
        return 'ignored';
      }
      let any = false;
      for (const refund of refunds) {
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
      // Ends the connection AND the money paths on it (open checkouts, the
      // renewal of chains opened there) in one transaction; null when the
      // club had reconnected before this arrived, or another event ended it.
      // Not fresh: THIS event ended it on a run that died before the notice
      // went — the notice goes now, the ledger dedupes it.
      const gone = await markPaymentAccountGone(db, account, event.receivedAt, event.id);
      if (!gone) return 'ignored';
      notify.push({
        kind: 'club_payments_revoked',
        clubId: gone.clubId,
        subscriptions: gone.subscriptions,
        eventId: event.id,
      });
      return gone.fresh ? 'applied' : 'ignored';
    }
    default:
      return 'ignored';
  }
}

export interface PaymentEventResult {
  type: string;
  outcome: PaymentEventOutcome;
}

/** Sends one notice on club.notify; a rejection propagates and keeps the event pending. */
export type EnqueueNotice = (job: ClubNotifyJob) => Promise<void>;

export async function runClubPaymentEvent(
  id: number,
  enqueue: EnqueueNotice,
): Promise<PaymentEventResult | null> {
  const db = getDb();
  const event = await paymentEventById(db, id);
  if (!event) return null;
  const stripe = client();
  // Not configured: the event stays PENDING (a throw, retried, then swept),
  // so nothing is lost while the operator sets the keys.
  if (!stripe) throw new Error('club.payment_event: Stripe is not configured on the worker');
  // A throw propagates: pg-boss retries the job, the row stays unprocessed.
  let outcome: PaymentEventOutcome;
  const notify: ClubNotifyJob[] = [];
  try {
    outcome = await apply(event, stripe, notify);
  } catch (error: unknown) {
    // The account no longer lets the platform in (revoked at Stripe): the
    // event can never be processed — recorded as failed, not retried every
    // sweep for ever. An object Stripe no longer has is nothing to act on.
    // Everything else (a 5xx, a timeout) propagates: retried, then swept.
    if (error instanceof StripeError && error.status === 403) outcome = 'failed';
    else if (error instanceof StripeError && error.status === 404) outcome = 'ignored';
    else throw error;
  }
  // Notices BEFORE the mark (the header's order): a refused send throws, the
  // event stays pending, and the retry re-derives and re-sends — deduped.
  for (const notice of notify) await enqueue(notice);
  await markPaymentEvent(db, id, outcome);
  return { type: event.type, outcome };
}

/**
 * The provider a freed event seat may be offered through for online payment
 * (0053): the operator's switch and a working provider, as the web app reads
 * them (apps/web/lib/clubs/payments.ts onlineProvider). Off: the seat is
 * given outright and owed at the desk.
 */
function onlineProvider(): OnlineProvider {
  if (process.env.CLUB_PAYMENTS_ENABLED !== 'true') return null;
  const provider = resolvePaymentProvider(process.env);
  return provider === 'stripe' || provider === 'fake' ? provider : null;
}

/**
 * The backlog: events recorded but never processed (a lost enqueue), and the
 * 90-day retention of processed ones (0046's header). Each event's notices go
 * through `enqueue` before it is marked. Returns how many were applied, and
 * the event places that moved up from a waitlist into a seat a lapsed hold
 * freed (0053) — for the caller to tell.
 */
export async function sweepClubPaymentEvents(
  enqueue: EnqueueNotice,
): Promise<{ done: number; promoted: string[] }> {
  const ids = await pendingPaymentEventIds(getDb());
  let done = 0;
  for (const id of ids) {
    try {
      if (await runClubPaymentEvent(id, enqueue)) done += 1;
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
  // Event places held for a payment that never came (0053): released, and
  // the line moves into the freed seat — event by event, each on its own.
  let promoted: string[] = [];
  try {
    promoted = (await expireEventHolds(getDb(), onlineProvider())).map((p) => p.registrationId);
  } catch (error: unknown) {
    console.warn(
      `[worker] club event holds sweep failed (${error instanceof Error ? error.name : 'error'})`,
    );
  }
  await prunePaymentEvents(getDb());
  return { done, promoted };
}
