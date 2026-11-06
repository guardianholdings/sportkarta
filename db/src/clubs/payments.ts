import { addDaysIso, membershipEndsOn, sofiaToday, type IsoDate } from '@sportkarta/lib/clubs';
import { sql, type SQL } from 'drizzle-orm';

/**
 * What an online payment DOES once it is known to be paid (0046) — shared by
 * the worker (which learns it from a Stripe webhook and RE-FETCHES the object
 * from Stripe first) and by the local fake provider's page (/dev/plashtane).
 * Nothing here talks to Stripe; every function takes facts already verified.
 *
 * EVERY WRITE IS IDEMPOTENT BY CONSTRAINT OR BY STATE:
 *   - a checkout is applied by `UPDATE … WHERE status = 'open'` — a second
 *     delivery of the same event finds it paid and does nothing;
 *   - a payment row carries the provider's reference, and
 *     club_payments_provider_ref_unique refuses a second copy;
 *   - a subscription period is a successor membership, and
 *     club_memberships_one_successor refuses a second one.
 *
 * THE BOOKS STAY WHOLE: an online payment is an ordinary club_payments row
 * (method card_online) against an ordinary charge, so reports, balances and
 * the 0041 within-charge trigger treat it like a desk payment. If the charge
 * was settled at the desk while the member was on Stripe's page, the online
 * payment no longer fits and the checkout is marked `unapplied` — money taken
 * that the office refunds (it is listed on the payments screen) — and the
 * trigger is never bypassed.
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

async function systemAudit(
  db: SqlRunner,
  clubId: string,
  action:
    | 'online_payment_received'
    | 'online_refund_issued'
    | 'online_payment_failed'
    | 'payment_account_disconnected',
  memberId: string | null,
  detail: SQL,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO club_audit (club_id, actor_kind, actor_id, action, subject_member_id, detail)
    VALUES (${clubId}::uuid, 'system', NULL, ${action}, ${memberId}::uuid, ${detail})
  `);
}

// ─── Checkouts ─────────────────────────────────────────────────────────────

export interface PaidCheckout {
  /** Our row id (client_reference_id), or the provider's session id. */
  checkoutId?: string;
  sessionRef?: string;
  /**
   * The connected account the event came from. Stripe ids are globally
   * unique, so this is defence in depth: a checkout only settles from the
   * account it was opened on.
   */
  accountRef?: string;
  provider: 'stripe' | 'fake';
  /** The payment's reference at the provider (a PaymentIntent, or an invoice). */
  paymentRef: string;
  amountCents: number;
  /**
   * The provider's currency for the amount. Every checkout is opened in EUR,
   * so anything else is money the books cannot compare — `unapplied`, like a
   * wrong amount. Omitted by the fake provider, which has no currency.
   */
  currency?: string | null;
  subscriptionRef: string | null;
}

export type CheckoutOutcome =
  | { applied: true; checkoutId: string; clubId: string; memberId: string | null }
  | {
      applied: false;
      reason:
        | 'unknown_or_done'
        | 'amount_mismatch'
        | 'currency_mismatch'
        | 'charge_settled'
        | 'session_closed';
      /**
       * Money that will not be applied but whose subscription is live at the
       * provider: the caller cancels it, or the card is billed every month
       * for periods nobody records (the 0046 review).
       */
      subscriptionRef?: string | null;
    };

export async function applyCheckoutPaid(
  db: TransactionalDb,
  paid: PaidCheckout,
  today: IsoDate = sofiaToday(),
): Promise<CheckoutOutcome> {
  return db.transaction(async (tx) => {
    const target = sql`${paid.checkoutId ? sql`id = ${paid.checkoutId}::uuid` : sql`session_ref = ${paid.sessionRef ?? ''}`}
         AND ${paid.accountRef ? sql`account_ref = ${paid.accountRef}` : sql`true`}`;
    const found = await tx.execute(sql`
      SELECT id, club_id, purpose, member_id, charge_id, plan_id, amount_cents, mode,
             to_char(starts_on, 'YYYY-MM-DD') AS starts_on, promotion_id, discount_cents, label
        FROM club_checkouts
       WHERE status = 'open' AND ${target}
         FOR UPDATE
    `);
    const row = found.rows[0];
    if (!row) {
      // Paid on a session this side had already closed (a second click
      // replaced it, or an erasure expired it): the money is real, so it is
      // recorded as `unapplied` for the office — never lost, never applied.
      const closed = await tx.execute(sql`
        UPDATE club_checkouts SET status = 'unapplied', payment_ref = ${paid.paymentRef},
               subscription_ref = ${paid.subscriptionRef}
         WHERE status = 'expired' AND ${target}
        RETURNING id
      `);
      return closed.rows.length > 0
        ? ({
            applied: false,
            reason: 'session_closed',
            subscriptionRef: paid.subscriptionRef,
          } as const)
        : ({ applied: false, reason: 'unknown_or_done' } as const);
    }
    const checkoutId = String(row.id);
    const clubId = String(row.club_id);
    const memberId = text(row.member_id);
    const fail = async (reason: 'amount_mismatch' | 'currency_mismatch' | 'charge_settled') => {
      await tx.execute(sql`
        UPDATE club_checkouts SET status = 'unapplied', completed_at = now(),
               payment_ref = ${paid.paymentRef}, subscription_ref = ${paid.subscriptionRef}
         WHERE id = ${checkoutId}::uuid
      `);
      return { applied: false, reason, subscriptionRef: paid.subscriptionRef } as const;
    };
    // The currency before the amount: 4500 of anything but EUR is not 45,00 €.
    if (paid.currency !== undefined && paid.currency !== 'eur') return fail('currency_mismatch');
    if (Number(row.amount_cents) !== paid.amountCents) return fail('amount_mismatch');

    let chargeId = text(row.charge_id);
    let membershipId: string | null = null;
    if (row.purpose === 'charge') {
      const due = await tx.execute(sql`
        SELECT cb.due_cents FROM club_charges ch
          JOIN club_charge_balances cb ON cb.charge_id = ch.id
         WHERE ch.id = ${chargeId}::uuid AND ch.voided_at IS NULL
           -- A booking released or cancelled before the money came: whatever
           -- the charge says, the slot is gone — the office refunds.
           AND NOT EXISTS (SELECT 1 FROM club_reservations r
                            WHERE r.club_id = ch.club_id AND r.charge_id = ch.id
                              AND r.state IN ('expired', 'cancelled'))
           -- Nor an event place (0053) released, given up in time or cancelled
           -- with its event — even a charge an invoice kept alive.
           AND NOT EXISTS (SELECT 1 FROM club_event_registrations er
                            WHERE er.club_id = ch.club_id AND er.charge_id = ch.id
                              AND er.state IN ('expired', 'cancelled'))
           FOR UPDATE OF ch
      `);
      if (!due.rows[0] || Number(due.rows[0].due_cents) < paid.amountCents) {
        return fail('charge_settled');
      }
    } else if (row.purpose === 'wallet') {
      // Credit bought online (0050): the top-up charge is created now, with
      // the money — an abandoned top-up never left a charge behind.
      if (memberId === null) return fail('amount_mismatch');
      const charge = await tx.execute(sql`
        INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on)
        VALUES (${clubId}::uuid, ${memberId}::uuid, 'wallet', ${String(row.label)},
                ${paid.amountCents}, ${today}::date, ${today}::date)
        RETURNING id
      `);
      chargeId = String(charge.rows[0]?.id);
    } else {
      // A plan bought online: the membership, its charge and the payment, in
      // this transaction — the sellMembership shape, with the system as seller.
      const plan = (
        await tx.execute(sql`
          SELECT name_bg, kind, audience, price_cents, validity_days, validity_months,
                 visits_count, auto_renew, notice_days, min_term_months, self_pause_allowed,
                 self_cancel_allowed
            FROM club_plans WHERE club_id = ${clubId}::uuid AND id = ${String(row.plan_id)}::uuid
        `)
      ).rows[0];
      if (!plan || memberId === null) return fail('amount_mismatch');
      const requested = String(row.starts_on);
      const startsOn = requested < today ? today : requested;
      const endsOn = membershipEndsOn(
        startsOn,
        plan.validity_days !== null
          ? { days: Number(plan.validity_days) }
          : { months: Number(plan.validity_months) },
      );
      // Only a Stripe subscription renews an online purchase. A one-off
      // payment is exactly that — the purchase page says so, and the nightly
      // desk renewal must not bill the buyer for periods they were not told of.
      const renews = row.mode === 'subscription';
      const sold = await tx.execute(sql`
        INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                      price_cents, visits_total, starts_on, ends_on, renews,
                                      term_started_on, provider_subscription_ref, notice_days,
                                      min_term_months, self_pause_allowed, self_cancel_allowed)
        VALUES (${clubId}::uuid, ${memberId}::uuid, ${String(row.plan_id)}::uuid,
                ${String(plan.name_bg)}, ${String(plan.kind)}, ${String(plan.audience)},
                ${paid.amountCents},
                ${plan.visits_count === null ? null : Number(plan.visits_count)},
                ${startsOn}::date, ${endsOn}::date, ${renews && plan.kind !== 'trial'},
                ${renews && plan.kind !== 'trial' ? startsOn : null}::date, ${paid.subscriptionRef},
                ${Number(plan.notice_days)},
                ${plan.min_term_months === null ? null : Number(plan.min_term_months)},
                ${plan.self_pause_allowed === true}, ${plan.self_cancel_allowed === true})
        RETURNING id
      `);
      membershipId = String(sold.rows[0]?.id);
      // The offer it was opened with (0049) is used now, when the money is in.
      // No re-check here: while the checkout was open its use was RESERVED
      // (apps/web/lib/clubs/promotions.ts counts open offer checkouts as
      // uses), so nobody else could take it, and the buyer has paid the
      // discounted price either way.
      if (row.promotion_id !== null && row.promotion_id !== undefined) {
        await tx.execute(sql`
          INSERT INTO club_promotion_redemptions (club_id, promotion_id, subject, member_id,
                                                  membership_id, discount_cents)
          VALUES (${clubId}::uuid, ${String(row.promotion_id)}::uuid, 'membership',
                  ${memberId}::uuid, ${membershipId}::uuid, ${Number(row.discount_cents)})
        `);
      }
      const charge = await tx.execute(sql`
        INSERT INTO club_charges (club_id, member_id, membership_id, kind, label, amount_cents,
                                  issued_on, due_on)
        VALUES (${clubId}::uuid, ${memberId}::uuid, ${membershipId}::uuid, 'membership',
                ${String(plan.name_bg)}, ${paid.amountCents}, ${today}::date, ${today}::date)
        RETURNING id
      `);
      chargeId = String(charge.rows[0]?.id);
    }

    await tx.execute(sql`
      INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                 provider, provider_ref, received_on)
      VALUES (${clubId}::uuid, ${chargeId}::uuid, ${memberId}::uuid, 'payment', ${paid.amountCents},
              'card_online', ${paid.provider}, ${paid.paymentRef}, ${today}::date)
      ON CONFLICT DO NOTHING
    `);
    // A slot held for this charge (0048) is confirmed by the payment row
    // itself — club_payments_confirm_hold, which covers desk payments too.
    await tx.execute(sql`
      UPDATE club_checkouts
         SET status = 'paid', completed_at = now(), payment_ref = ${paid.paymentRef},
             subscription_ref = ${paid.subscriptionRef}, membership_id = ${membershipId}::uuid,
             charge_id = coalesce(charge_id, ${chargeId}::uuid)
       WHERE id = ${checkoutId}::uuid
    `);
    await systemAudit(
      tx,
      clubId,
      'online_payment_received',
      memberId,
      sql`jsonb_build_object('checkoutId', ${checkoutId}::text, 'amountCents', ${paid.amountCents}::int,
                             'purpose', ${String(row.purpose)}::text)`,
    );
    return { applied: true, checkoutId, clubId, memberId } as const;
  });
}

/** A Checkout Session that ended without payment (expired, or abandoned). */
export async function expireCheckout(db: SqlRunner, sessionRef: string): Promise<boolean> {
  const updated = await db.execute(sql`
    UPDATE club_checkouts SET status = 'expired', completed_at = now()
     WHERE session_ref = ${sessionRef} AND status = 'open'
    RETURNING id
  `);
  return updated.rows.length > 0;
}

// ─── Subscriptions ─────────────────────────────────────────────────────────

/**
 * invoice.paid for a renewing period of a subscription: append the next
 * membership to the chain the subscription started, with its charge and the
 * payment. The first invoice (billing_reason subscription_create) is the
 * checkout itself and is skipped by the caller.
 */
export async function applySubscriptionInvoice(
  db: TransactionalDb,
  invoice: {
    provider: 'stripe' | 'fake';
    subscriptionRef: string;
    paymentRef: string;
    amountCents: number;
    /** As on a checkout: the chain was opened in EUR, anything else is refused. */
    currency?: string | null;
  },
  today: IsoDate = sofiaToday(),
): Promise<
  | { applied: true; clubId: string; memberId: string }
  | {
      applied: false;
      reason: 'duplicate' | 'no_chain' | 'not_renewing' | 'after_notice' | 'currency_mismatch';
      /**
       * The chain the money was billed for when no period is appended
       * (not_renewing, after_notice, currency_mismatch): what
       * recordUnappliedRenewal needs to list the money for the office —
       * Stripe took it, the books refuse it.
       */
      chain?: { clubId: string; memberId: string; planId: string; startsOn: IsoDate };
    }
> {
  return db.transaction(async (tx) => {
    // Idempotent per invoice: a retried job (the commit landed, marking the
    // event did not) must not append a second period with an unpaid charge.
    const seen = await tx.execute(sql`
      SELECT 1 FROM club_payments
       WHERE provider = ${invoice.provider} AND provider_ref = ${invoice.paymentRef}
    `);
    if (seen.rows.length > 0) return { applied: false, reason: 'duplicate' } as const;
    const tail = (
      await tx.execute(sql`
        SELECT ms.id, ms.club_id, ms.member_id, ms.plan_id, ms.plan_name, ms.kind, ms.audience,
               ms.visits_total, ms.term_started_on, ms.notice_days, ms.min_term_months,
               ms.self_pause_allowed, ms.self_cancel_allowed, ms.renews,
               to_char(ms.renewal_ends_on, 'YYYY-MM-DD') AS renewal_ends_on,
               to_char(mb.effective_ends_on, 'YYYY-MM-DD') AS effective_ends_on,
               p.validity_days, p.validity_months
          FROM club_memberships ms
          JOIN club_membership_balances mb ON mb.membership_id = ms.id
          JOIN club_plans p ON p.club_id = ms.club_id AND p.id = ms.plan_id
         WHERE ms.provider_subscription_ref = ${invoice.subscriptionRef} AND ms.cancelled_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM club_memberships nx WHERE nx.renewal_of = ms.id)
         ORDER BY ms.starts_on DESC
         LIMIT 1
           FOR UPDATE OF ms
      `)
    ).rows[0];
    if (!tail) return { applied: false, reason: 'no_chain' } as const;
    const clubId = String(tail.club_id);
    const memberId = String(tail.member_id);
    const after = addDaysIso(String(tail.effective_ends_on), 1);
    const startsOn = after < today ? today : after;
    const chain = { clubId, memberId, planId: String(tail.plan_id), startsOn };
    // Not the currency the chain was opened in: no period is priced in it.
    if (invoice.currency !== undefined && invoice.currency !== 'eur') {
      return { applied: false, reason: 'currency_mismatch', chain } as const;
    }
    // The office stopped renewing, or the member's notice ends before this
    // period: no period is appended; the caller lists the money for the
    // office (recordUnappliedRenewal) and ends the subscription.
    if (tail.renews !== true) return { applied: false, reason: 'not_renewing', chain } as const;
    const noticeEnds = text(tail.renewal_ends_on);
    if (noticeEnds !== null && startsOn > noticeEnds) {
      return { applied: false, reason: 'after_notice', chain } as const;
    }
    const endsOn = membershipEndsOn(
      startsOn,
      tail.validity_days !== null
        ? { days: Number(tail.validity_days) }
        : { months: Number(tail.validity_months) },
    );
    const sold = await tx.execute(sql`
      INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                    price_cents, visits_total, starts_on, ends_on, renews,
                                    renewal_of, term_started_on, provider_subscription_ref,
                                    renewal_ends_on, notice_days, min_term_months,
                                    self_pause_allowed, self_cancel_allowed)
      VALUES (${clubId}::uuid, ${memberId}::uuid, ${String(tail.plan_id)}::uuid,
              ${String(tail.plan_name)}, ${String(tail.kind)}, ${String(tail.audience)},
              ${invoice.amountCents}, ${tail.visits_total === null ? null : Number(tail.visits_total)},
              ${startsOn}::date, ${endsOn}::date, true, ${String(tail.id)}::uuid,
              ${text(tail.term_started_on)}::date, ${invoice.subscriptionRef}, ${noticeEnds}::date,
              ${Number(tail.notice_days)},
              ${tail.min_term_months === null ? null : Number(tail.min_term_months)},
              ${tail.self_pause_allowed === true}, ${tail.self_cancel_allowed === true})
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    const membershipId = text(sold.rows[0]?.id);
    if (!membershipId) return { applied: false, reason: 'duplicate' } as const;
    const charge = await tx.execute(sql`
      INSERT INTO club_charges (club_id, member_id, membership_id, kind, label, amount_cents,
                                issued_on, due_on)
      VALUES (${clubId}::uuid, ${memberId}::uuid, ${membershipId}::uuid, 'membership',
              ${String(tail.plan_name)}, ${invoice.amountCents}, ${today}::date, ${today}::date)
      RETURNING id
    `);
    await tx.execute(sql`
      INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                 provider, provider_ref, received_on)
      VALUES (${clubId}::uuid, ${String(charge.rows[0]?.id)}::uuid, ${memberId}::uuid, 'payment',
              ${invoice.amountCents}, 'card_online', ${invoice.provider}, ${invoice.paymentRef},
              ${today}::date)
      ON CONFLICT DO NOTHING
    `);
    await systemAudit(
      tx,
      clubId,
      'online_payment_received',
      memberId,
      sql`jsonb_build_object('membershipId', ${membershipId}::text,
                             'amountCents', ${invoice.amountCents}::int, 'purpose', 'renewal')`,
    );
    return { applied: true, clubId, memberId } as const;
  });
}

/** The subscription ended at Stripe: its chain stops renewing. */
export async function stopSubscription(db: SqlRunner, subscriptionRef: string): Promise<number> {
  const updated = await db.execute(sql`
    UPDATE club_memberships SET renews = false
     WHERE provider_subscription_ref = ${subscriptionRef} AND renews
    RETURNING id
  `);
  return updated.rows.length;
}

/**
 * A subscription POPS opened whose money never reached the books: a checkout
 * of ours carries its reference as `unapplied`, and no membership chain does.
 * Its card is billed until the subscription is ended at the provider, so the
 * worker ends it on EVERY visit until that call succeeds — the first attempt
 * follows the `unapplied` commit and may fail (a timeout, a 5xx); the retried
 * event then finds the checkout already settled and asks here. A subscription
 * no checkout of ours knows is the club's own business at Stripe and is never
 * touched.
 */
export async function subscriptionCancelOwed(
  db: SqlRunner,
  subscriptionRef: string,
): Promise<boolean> {
  const found = await db.execute(sql`
    SELECT 1 FROM club_checkouts k
     WHERE k.subscription_ref = ${subscriptionRef} AND k.status = 'unapplied'
       AND NOT EXISTS (SELECT 1 FROM club_memberships ms
                        WHERE ms.provider_subscription_ref = ${subscriptionRef})
     LIMIT 1
  `);
  return found.rows.length > 0;
}

/**
 * Money the provider collected for a renewal the books refuse — the office
 * stopped renewing, the notice has ended, or the chain was never opened
 * (its first payment went `unapplied`): listed for the office as an
 * `unapplied` checkout on the payments screen, exactly like money paid on a
 * closed session — never lost, never applied. Once per invoice (its payment
 * reference). False when nothing of ours is behind the subscription, or the
 * amount is outside what a checkout may hold (the CHECK: 0.50 – 100 000 €).
 */
export async function recordUnappliedRenewal(
  db: SqlRunner,
  renewal: {
    provider: 'stripe' | 'fake';
    accountRef: string;
    subscriptionRef: string;
    paymentRef: string;
    amountCents: number;
    chain: { clubId: string; memberId: string | null; planId: string; startsOn: IsoDate } | null;
  },
  today: IsoDate = sofiaToday(),
): Promise<boolean> {
  if (renewal.amountCents < 50 || renewal.amountCents > 10_000_000) return false;
  let chain = renewal.chain;
  if (!chain) {
    const opened = (
      await db.execute(sql`
        SELECT club_id, member_id, plan_id FROM club_checkouts
         WHERE subscription_ref = ${renewal.subscriptionRef} AND purpose = 'membership'
         ORDER BY created_at
         LIMIT 1
      `)
    ).rows[0];
    if (!opened) return false;
    chain = {
      clubId: String(opened.club_id),
      memberId: text(opened.member_id),
      planId: String(opened.plan_id),
      startsOn: today,
    };
  }
  const inserted = await db.execute(sql`
    INSERT INTO club_checkouts (club_id, purpose, member_id, plan_id, starts_on, amount_cents,
                                mode, provider, account_ref, status, payment_ref,
                                subscription_ref, completed_at)
    SELECT ${chain.clubId}::uuid, 'membership', ${chain.memberId}::uuid, ${chain.planId}::uuid,
           ${chain.startsOn}::date, ${renewal.amountCents}, 'subscription', ${renewal.provider},
           ${renewal.accountRef}, 'unapplied', ${renewal.paymentRef}, ${renewal.subscriptionRef},
           now()
     WHERE NOT EXISTS (SELECT 1 FROM club_checkouts k
                        WHERE k.club_id = ${chain.clubId}::uuid
                          AND k.payment_ref = ${renewal.paymentRef})
    RETURNING id
  `);
  return inserted.rows.length > 0;
}

/**
 * Whether a payment with this provider reference is in the books. A refund
 * reported before its payment was applied (the payment's own event is still
 * being retried) is waited for, not dropped.
 */
export async function providerPaymentKnown(
  db: SqlRunner,
  provider: 'stripe' | 'fake',
  paymentRef: string,
): Promise<boolean> {
  const found = await db.execute(sql`
    SELECT 1 FROM club_payments
     WHERE provider = ${provider} AND provider_ref = ${paymentRef} AND kind = 'payment'
     LIMIT 1
  `);
  return found.rows.length > 0;
}

// ─── Refunds ───────────────────────────────────────────────────────────────

/**
 * A refund made at the provider, recorded as the negative club_payments row
 * against the same charge. Called right after the office's refund call
 * succeeds AND again from charge.refunded — the refund's own reference makes
 * the second a no-op.
 */
export async function recordProviderRefund(
  // A transaction of the caller's (the office refunding credit under the
  // client's lock) or the connection, in which case this opens its own.
  db: TransactionalDb | SqlRunner,
  refund: {
    provider: 'stripe' | 'fake';
    paymentRef: string;
    refundRef: string;
    amountCents: number;
  },
  recordedBy: string | null,
  today: IsoDate = sofiaToday(),
): Promise<boolean> {
  const run = <T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T> =>
    'transaction' in db ? db.transaction(callback) : callback(db);
  return run(async (tx) => {
    const original = (
      await tx.execute(sql`
        SELECT club_id, charge_id, member_id FROM club_payments
         WHERE provider = ${refund.provider} AND provider_ref = ${refund.paymentRef}
           AND kind = 'payment'
         LIMIT 1
      `)
    ).rows[0];
    if (!original) return false;
    // Already booked (the office's own refund, now echoed by charge.refunded):
    // checked BEFORE the insert, because club_payments_within_charge is a
    // BEFORE trigger and would refuse the duplicate before ON CONFLICT could
    // skip it — a fully refunded charge has no room for the echo.
    const booked = await tx.execute(sql`
      SELECT 1 FROM club_payments
       WHERE club_id = ${String(original.club_id)}::uuid AND provider = ${refund.provider}
         AND provider_ref = ${refund.refundRef}
    `);
    if (booked.rows.length > 0) return false;
    const inserted = await tx.execute(sql`
      INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                 provider, provider_ref, received_on, recorded_by)
      VALUES (${String(original.club_id)}::uuid, ${String(original.charge_id)}::uuid,
              ${text(original.member_id)}::uuid, 'refund', ${-Math.abs(refund.amountCents)},
              'card_online', ${refund.provider}, ${refund.refundRef}, ${today}::date, ${recordedBy})
      ON CONFLICT DO NOTHING
      RETURNING id
    `);
    if (inserted.rows.length === 0) return false;
    await systemAudit(
      tx,
      String(original.club_id),
      'online_refund_issued',
      text(original.member_id),
      sql`jsonb_build_object('amountCents', ${Math.abs(refund.amountCents)}::int)`,
    );
    // The books follow 0041: a refund on a live charge makes the money owed
    // again. A refund that leaves NOTHING paid on the charge voids it here —
    // whoever made it (the office, or the club in its Stripe dashboard) — so
    // the member is never shown «Платете» for money just given back. A till
    // sale is undone by its reversal, an invoiced charge by its credit note,
    // and a top-up is paid back rather than voided (0049, 0050): those keep
    // their charge. A partial refund leaves the remainder owed.
    await tx.execute(sql`
      WITH v AS (
        UPDATE club_charges ch SET voided_at = now()
         WHERE ch.id = ${String(original.charge_id)}::uuid AND ch.voided_at IS NULL
           AND ch.kind <> 'wallet'
           AND coalesce((SELECT sum(pp.amount_cents) FROM club_payments pp
                          WHERE pp.charge_id = ch.id), 0) = 0
           AND NOT EXISTS (SELECT 1 FROM club_sales sa
                            WHERE sa.club_id = ch.club_id AND sa.charge_id = ch.id)
           AND NOT EXISTS (SELECT 1 FROM club_invoices li
                            WHERE li.club_id = ch.club_id AND li.charge_id = ch.id
                              AND li.kind = 'invoice'
                              AND li.total_cents > coalesce((SELECT sum(lc.total_cents)
                                                                FROM club_invoices lc
                                                               WHERE lc.club_id = li.club_id
                                                                 AND lc.corrects_id = li.id), 0))
         RETURNING ch.club_id, ch.id, ch.member_id
      )
      INSERT INTO club_audit (club_id, actor_kind, actor_id, action, subject_member_id, detail)
      SELECT v.club_id, ${recordedBy === null ? 'system' : 'staff'}, ${recordedBy},
             'charge_voided', v.member_id,
             jsonb_build_object('chargeId', v.id::text, 'reason', 'refunded')
        FROM v
    `);
    return true;
  });
}

// ─── Connected accounts ────────────────────────────────────────────────────

export async function setPaymentAccountState(
  db: SqlRunner,
  accountRef: string,
  chargesEnabled: boolean,
): Promise<void> {
  await db.execute(sql`
    UPDATE club_payment_accounts SET charges_enabled = ${chargesEnabled}
     WHERE account_ref = ${accountRef} AND disconnected_at IS NULL
  `);
}

export interface PaymentAccountGone {
  clubId: string;
  /** Open checkouts on that account, closed here: their pages can no longer reach the books. */
  checkoutsExpired: number;
  /**
   * Renewing chains opened on that account, now `renews = false`: Stripe will
   * keep billing them, but POPS can neither hear about it nor end them — the
   * club must, in its own dashboard. What the owners are told.
   */
  subscriptions: number;
  /**
   * False when THIS event had already done the work — a retry after the run
   * died between the commit and the owners' notice. The counts are then read
   * back from the audit row the first run wrote (it carries the event id), so
   * the notice can still go; the notifications ledger dedupes a double.
   */
  fresh: boolean;
}

/**
 * The club revoked access at Stripe (account.application.deauthorized). Only a
 * connection made BEFORE the event arrived is ended — a club that reconnected
 * meanwhile stays connected, and nothing else here happens either.
 *
 * Ending the connection is not enough (review 2026-10-31): after it the
 * platform hears NOTHING from that account, so in the same transaction
 *   - that account's open checkouts are expired locally — a member still on a
 *     live Checkout page may pay, but the event would never arrive; the return
 *     page then says the payment was not completed, and should the event come
 *     after all, applyCheckoutPaid lists the money as `unapplied`;
 *   - every chain whose subscription was opened on that account stops
 *     renewing in the books — Stripe may bill it, no period would be recorded;
 *   - the club's audit log gets the disconnect, by 'system', with both counts
 *     and the event's id.
 * The caller tells the owners (club.notify) with the subscription count. Asked
 * again by the SAME event (a retry), the audit row answers with the counts and
 * `fresh: false`; by any other event once the connection is gone, null.
 */
export async function markPaymentAccountGone(
  db: TransactionalDb,
  accountRef: string,
  eventReceivedAt: Date,
  eventId: number,
): Promise<PaymentAccountGone | null> {
  return db.transaction(async (tx) => {
    const gone = await tx.execute(sql`
      UPDATE club_payment_accounts SET disconnected_at = now(), charges_enabled = false
       WHERE account_ref = ${accountRef} AND disconnected_at IS NULL
         AND connected_at < ${eventReceivedAt.toISOString()}::timestamptz
      RETURNING club_id
    `);
    const clubId = text(gone.rows[0]?.club_id);
    if (!clubId) {
      // Nothing to end now. If THIS event ended it on an earlier run that died
      // before the notice went, its audit row says so — and what to tell.
      const earlier = (
        await tx.execute(sql`
          SELECT a.club_id, a.detail FROM club_audit a
           WHERE a.action = 'payment_account_disconnected' AND a.actor_kind = 'system'
             AND a.detail->>'eventId' = ${String(eventId)}
           ORDER BY a.acted_at DESC
           LIMIT 1
        `)
      ).rows[0];
      if (!earlier) return null;
      const detail = (
        typeof earlier.detail === 'string' ? JSON.parse(earlier.detail) : (earlier.detail ?? {})
      ) as Record<string, unknown>;
      return {
        clubId: String(earlier.club_id),
        checkoutsExpired: Number(detail.checkoutsExpired ?? 0),
        subscriptions: Number(detail.subscriptionsAtStripe ?? 0),
        fresh: false,
      };
    }
    // Checkouts first, then the chains: applyCheckoutPaid's order (checkout →
    // charge → membership), so a payment landing at this moment never
    // deadlocks with the revoke.
    const expired = await tx.execute(sql`
      UPDATE club_checkouts SET status = 'expired', completed_at = now()
       WHERE club_id = ${clubId}::uuid AND account_ref = ${accountRef} AND status = 'open'
      RETURNING id
    `);
    const stopped = await tx.execute(sql`
      UPDATE club_memberships ms SET renews = false
       WHERE ms.club_id = ${clubId}::uuid AND ms.renews AND ms.provider_subscription_ref IS NOT NULL
         AND EXISTS (SELECT 1 FROM club_checkouts k
                      WHERE k.club_id = ms.club_id AND k.account_ref = ${accountRef}
                        AND k.subscription_ref = ms.provider_subscription_ref)
      RETURNING ms.provider_subscription_ref
    `);
    const subscriptions = new Set(stopped.rows.map((row) => String(row.provider_subscription_ref)))
      .size;
    await systemAudit(
      tx,
      clubId,
      'payment_account_disconnected',
      null,
      sql`jsonb_build_object('provider', 'stripe', 'by', 'provider',
                             'checkoutsExpired', ${expired.rows.length}::int,
                             'subscriptionsAtStripe', ${subscriptions}::int,
                             'eventId', ${eventId}::bigint)`,
    );
    return { clubId, checkoutsExpired: expired.rows.length, subscriptions, fresh: true };
  });
}

// ─── Failed renewals ───────────────────────────────────────────────────────

export interface RenewalPaymentFailure {
  clubId: string;
  memberId: string;
  membershipId: string;
  /** False when this invoice's failure was already on record (Stripe's retry). */
  recorded: boolean;
}

/**
 * invoice.payment_failed for a renewal cycle (0062): Stripe could not collect
 * the next period, and will retry on its own dunning schedule. Nothing in the
 * books changes — no money, no period — but the FACT is recorded on the chain
 * as an audit row naming the membership and the invoice, once per invoice,
 * so the office sees why a period never came and the worker can tell both
 * sides. Null when no chain of ours carries the subscription (the club's own
 * business at Stripe).
 */
export async function recordRenewalPaymentFailed(
  db: TransactionalDb,
  failure: {
    provider: 'stripe' | 'fake';
    subscriptionRef: string;
    invoiceRef: string;
    amountCents: number;
    /** The invoice's currency, stored beside the figure so no reader prints a foreign number as euros. */
    currency: string;
  },
): Promise<RenewalPaymentFailure | null> {
  return db.transaction(async (tx) => {
    const tail = (
      await tx.execute(sql`
        SELECT ms.id, ms.club_id, ms.member_id
          FROM club_memberships ms
         WHERE ms.provider_subscription_ref = ${failure.subscriptionRef} AND ms.cancelled_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM club_memberships nx WHERE nx.renewal_of = ms.id)
         ORDER BY ms.starts_on DESC
         LIMIT 1
           FOR UPDATE OF ms
      `)
    ).rows[0];
    if (!tail) return null;
    const clubId = String(tail.club_id);
    const memberId = String(tail.member_id);
    const membershipId = String(tail.id);
    const written = await tx.execute(sql`
      INSERT INTO club_audit (club_id, actor_kind, actor_id, action, subject_member_id, detail)
      SELECT ${clubId}::uuid, 'system', NULL, 'online_payment_failed', ${memberId}::uuid,
             jsonb_build_object('membershipId', ${membershipId}::text,
                                'invoiceRef', ${failure.invoiceRef}::text,
                                'provider', ${failure.provider}::text,
                                'amountCents', ${failure.amountCents}::int,
                                'currency', ${failure.currency}::text)
       WHERE NOT EXISTS (SELECT 1 FROM club_audit a
                          WHERE a.club_id = ${clubId}::uuid AND a.action = 'online_payment_failed'
                            AND a.detail->>'invoiceRef' = ${failure.invoiceRef})
      RETURNING id
    `);
    return { clubId, memberId, membershipId, recorded: written.rows.length > 0 };
  });
}

// ─── The webhook ledger ────────────────────────────────────────────────────

export interface PaymentEvent {
  id: number;
  eventId: string;
  type: string;
  accountRef: string | null;
  objectRef: string | null;
  receivedAt: Date;
}

/** Record a verified event; null when Stripe re-delivered one we have. */
export async function recordPaymentEvent(
  db: SqlRunner,
  event: { eventId: string; type: string; accountRef: string | null; objectRef: string | null },
): Promise<number | null> {
  const inserted = await db.execute(sql`
    INSERT INTO club_payment_events (provider, event_id, type, account_ref, object_ref)
    VALUES ('stripe', ${event.eventId}, ${event.type}, ${event.accountRef}, ${event.objectRef})
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id
  `);
  const id = inserted.rows[0]?.id;
  return id === undefined ? null : Number(id);
}

export async function paymentEventById(db: SqlRunner, id: number): Promise<PaymentEvent | null> {
  const row = (
    await db.execute(sql`
      SELECT id, event_id, type, account_ref, object_ref, received_at FROM club_payment_events
       WHERE id = ${id} AND processed_at IS NULL
    `)
  ).rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    eventId: String(row.event_id),
    type: String(row.type),
    accountRef: text(row.account_ref),
    objectRef: text(row.object_ref),
    receivedAt: new Date(String(row.received_at)),
  };
}

/** Events received but never processed — the sweep's backlog. */
export async function pendingPaymentEventIds(db: SqlRunner, limit = 200): Promise<number[]> {
  const result = await db.execute(sql`
    SELECT id FROM club_payment_events
     WHERE processed_at IS NULL AND received_at < now() - interval '2 minutes'
     ORDER BY received_at LIMIT ${limit}
  `);
  return result.rows.map((row) => Number(row.id));
}

export async function markPaymentEvent(
  db: SqlRunner,
  id: number,
  outcome: 'applied' | 'ignored' | 'failed',
): Promise<void> {
  await db.execute(sql`
    UPDATE club_payment_events SET processed_at = now(), outcome = ${outcome}
     WHERE id = ${id} AND processed_at IS NULL
  `);
}

/**
 * Retention (0046's header): a processed event is only a dedupe record, and
 * Stripe stops retrying after about three days — keep 90, then let go. Rows
 * never processed are kept until they are.
 */
export async function prunePaymentEvents(db: SqlRunner): Promise<number> {
  const removed = await db.execute(sql`
    DELETE FROM club_payment_events
     WHERE processed_at IS NOT NULL AND processed_at < now() - interval '90 days'
    RETURNING id
  `);
  return removed.rows.length;
}

/** Subscriptions behind a member's (or one membership's) live chain. */
export async function subscriptionRefsFor(
  db: SqlRunner,
  clubId: string,
  target: { memberId: string } | { membershipId: string } | { club: true },
): Promise<
  { subscriptionRef: string; accountRef: string | null; provider: string; reachable: boolean }[]
> {
  // The account is the one the subscription was OPENED on (its checkout), not
  // whatever the club has connected now; it is reachable only while that
  // account is still the club's live connection. A club that revoked access
  // at Stripe controls those subscriptions itself.
  const result = await db.execute(sql`
    SELECT DISTINCT ms.provider_subscription_ref, k.account_ref, k.provider,
           EXISTS (SELECT 1 FROM club_payment_accounts a
                    WHERE a.club_id = ms.club_id AND a.account_ref = k.account_ref
                      AND a.disconnected_at IS NULL) AS reachable
      FROM club_memberships ms
      LEFT JOIN LATERAL (SELECT kk.account_ref, kk.provider FROM club_checkouts kk
                          WHERE kk.club_id = ms.club_id
                            AND kk.subscription_ref = ms.provider_subscription_ref
                          LIMIT 1) k ON true
     WHERE ms.club_id = ${clubId}::uuid AND ms.provider_subscription_ref IS NOT NULL AND ms.renews
       AND ${
         'memberId' in target
           ? sql`ms.member_id = ${target.memberId}::uuid`
           : 'membershipId' in target
             ? sql`ms.id = ${target.membershipId}::uuid`
             : sql`true`
       }
  `);
  return result.rows.map((row) => ({
    subscriptionRef: String(row.provider_subscription_ref),
    accountRef: text(row.account_ref),
    provider: String(row.provider ?? 'stripe'),
    reachable: row.reachable === true,
  }));
}

// ─── Receipt mail ──────────────────────────────────────────────────────────

export interface ReceiptCandidate {
  clubId: string;
  memberId: string;
  checkoutId: string;
  amountCents: number;
  label: string;
}

/** Paid checkouts of the last three days whose receipt mail is still owed. */
export async function receiptCandidates(db: SqlRunner): Promise<ReceiptCandidate[]> {
  const result = await db.execute(sql`
    SELECT k.club_id, k.member_id, k.id, k.amount_cents,
           coalesce(ms.plan_name, ch.label) AS label
      FROM club_checkouts k
      JOIN clubs c ON c.id = k.club_id AND c.status = 'active'
      LEFT JOIN club_memberships ms ON ms.id = k.membership_id
      LEFT JOIN club_charges ch ON ch.id = k.charge_id
     WHERE k.status = 'paid' AND k.member_id IS NOT NULL
       AND k.completed_at > now() - interval '3 days'
       AND NOT EXISTS (SELECT 1 FROM club_notifications n
                        WHERE n.club_id = k.club_id
                          AND n.dedupe_key = 'payment_received:' || k.id::text)
     LIMIT 500
  `);
  return result.rows.map((row) => ({
    clubId: String(row.club_id),
    memberId: String(row.member_id),
    checkoutId: String(row.id),
    amountCents: Number(row.amount_cents),
    label: String(row.label ?? ''),
  }));
}

// ─── Reservation holds (0048) ──────────────────────────────────────────────

/**
 * How long past its expiry a hold still blocks its slot: a payment made in
 * the hold's last moments reaches us (and confirms the hold) before anyone
 * else can take the slot. Availability reads the same grace.
 */
export const HOLD_GRACE_MINUTES = 5;

/**
 * Release slots held for an online payment that never came: the hold ends,
 * its charge is voided and its open checkout closed — in the CALLER'S
 * transaction, locking in applyCheckoutPaid's order (checkout → charge →
 * reservation, each set by id, so two releases never deadlock either). A
 * payment arriving at the same moment therefore either lands first — its
 * payment row confirms the hold (0048's trigger on club_payments), and the
 * hold is no longer released — or waits, then finds a void charge and a
 * closed checkout and is recorded as `unapplied` for the office to refund.
 * A hold with any money on its charge is never released.
 *
 * `slot` narrows the release to one club's resource or trainer: the booking
 * path frees a lapsed hold on the slot it is about to take.
 */
export async function releaseLapsedHolds(
  tx: SqlRunner,
  slot?: { clubId: string; resourceId: string | null; staffUserId: string | null },
): Promise<number> {
  const lapsed = sql`h.state = 'held'
    AND h.hold_expires_at < now() - make_interval(mins => ${HOLD_GRACE_MINUTES}::int)
    ${
      slot
        ? sql`AND h.club_id = ${slot.clubId}::uuid
              AND (h.resource_id = ${slot.resourceId}::uuid OR h.staff_user_id = ${slot.staffUserId})`
        : sql``
    }`;
  const candidates = (
    await tx.execute(sql`SELECT h.id, h.charge_id FROM club_reservations h WHERE ${lapsed}`)
  ).rows;
  if (candidates.length === 0) return 0;
  const ids = candidates.map((row) => String(row.id));
  await lockHoldCharges(tx, chargeIdsOf(candidates));
  await tx.execute(sql`
    SELECT id FROM club_reservations WHERE id = ANY(${sql.param(ids)}::uuid[])
     ORDER BY id FOR UPDATE
  `);
  // Re-checked under the locks: a payment that won the race confirmed its hold.
  const released = await tx.execute(sql`
    UPDATE club_reservations h SET state = 'expired', hold_expires_at = NULL
     WHERE h.id = ANY(${sql.param(ids)}::uuid[]) AND ${lapsed}
       AND NOT EXISTS (SELECT 1 FROM club_payments pp WHERE pp.charge_id = h.charge_id)
    RETURNING h.charge_id
  `);
  await voidHeldCharges(tx, chargeIdsOf(released.rows));
  return released.rows.length;
}

/** The charge ids of hold rows, those with one. */
export function chargeIdsOf(rows: readonly Record<string, unknown>[]): string[] {
  return rows
    .filter((row) => row.charge_id !== null && row.charge_id !== undefined)
    .map((row) => String(row.charge_id));
}

/**
 * The first two steps of every hold release's lock order (applyCheckoutPaid's
 * order: checkout → charge → the hold row, each set by id): the open
 * checkouts of these charges, then the charges.
 */
export async function lockHoldCharges(tx: SqlRunner, charges: readonly string[]): Promise<void> {
  if (charges.length === 0) return;
  await tx.execute(sql`
    SELECT id FROM club_checkouts
     WHERE charge_id = ANY(${sql.param([...charges])}::uuid[]) AND status = 'open'
     ORDER BY id FOR UPDATE
  `);
  await tx.execute(sql`
    SELECT id FROM club_charges WHERE id = ANY(${sql.param([...charges])}::uuid[])
     ORDER BY id FOR NO KEY UPDATE
  `);
}

/**
 * The charges of released holds: voided (when nothing was paid on them),
 * logged like any void by the system so the office sees why a debt went, and
 * their open checkouts closed — under the locks lockHoldCharges took.
 */
export async function voidHeldCharges(tx: SqlRunner, charges: readonly string[]): Promise<void> {
  if (charges.length === 0) return;
  await tx.execute(sql`
    WITH v AS (
      UPDATE club_charges ch SET voided_at = now()
       WHERE ch.id = ANY(${sql.param([...charges])}::uuid[]) AND ch.voided_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM club_payments pp WHERE pp.charge_id = ch.id)
      RETURNING ch.club_id, ch.id, ch.member_id
    )
    INSERT INTO club_audit (club_id, actor_kind, actor_id, action, subject_member_id, detail)
    SELECT v.club_id, 'system', NULL, 'charge_voided', v.member_id,
           jsonb_build_object('chargeId', v.id::text, 'reason', 'hold_expired')
      FROM v
  `);
  await tx.execute(sql`
    UPDATE club_checkouts SET status = 'expired', completed_at = now()
     WHERE charge_id = ANY(${sql.param([...charges])}::uuid[]) AND status = 'open'
  `);
}

/** The worker's sweep: every lapsed hold, in one transaction. */
export async function expireReservationHolds(db: TransactionalDb): Promise<number> {
  return db.transaction((tx) => releaseLapsedHolds(tx));
}
