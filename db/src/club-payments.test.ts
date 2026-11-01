import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './client.js';
import {
  applyCheckoutPaid,
  applySubscriptionInvoice,
  markPaymentAccountGone,
  markPaymentEvent,
  providerPaymentKnown,
  prunePaymentEvents,
  recordPaymentEvent,
  recordProviderRefund,
  recordRenewalPaymentFailed,
  recordUnappliedRenewal,
  stopSubscription,
  subscriptionCancelOwed,
} from './clubs/payments.js';
import {
  cleanupClubFixtures,
  failure,
  makeClub,
  makeMember,
  makePlan,
  type ClubFixture,
} from './clubs/test-fixtures.js';

/**
 * Online payments (0046) at the database: the money path the worker runs
 * after re-fetching a Stripe object, and the constraints that keep it honest.
 *
 * What must hold:
 *   - a paid checkout is applied ONCE however often its event arrives, as an
 *     ordinary card_online payment against an ordinary charge;
 *   - money that no longer fits (the charge settled at the desk meanwhile, or
 *     a different amount) is never forced into the books: the checkout is
 *     `unapplied`, for the office to refund;
 *   - a plan bought online becomes a membership with the plan's terms
 *     snapshotted, and each paid subscription invoice exactly one successor;
 *   - a refund is recorded once, as the negative row;
 *   - a settled checkout is final, one open checkout per charge, one live
 *     account per club; erasing the client keeps the attempt, anonymised;
 *   - the webhook ledger dedupes a re-delivered event and forgets processed
 *     events after 90 days;
 *   - money in any currency but EUR is never compared, only listed;
 *   - a revoke from the club's own Stripe dashboard closes that account's
 *     open checkouts and stops its chains renewing, in one transaction;
 *   - a failed renewal is recorded on the chain once per invoice.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const ACCOUNT = 'acct_test_payments01';

describe.skipIf(!hasDb)('club online payments (requires running database)', () => {
  let client: pg.Client;
  let club: ClubFixture;
  let memberId: string;
  let planId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await cleanupClubFixtures(client);
    await client.query(`DELETE FROM club_payment_events WHERE event_id LIKE 'evt_test_%'`);
    await client.end();
  });

  beforeEach(async () => {
    await cleanupClubFixtures(client);
    club = await makeClub(client, 'payments', { tier: 'community', paid: true });
    memberId = await makeMember(client, club.clubId, 'Мария');
    planId = await makePlan(client, club.clubId, { priceCents: 4500 });
  });

  async function openCharge(amountCents = 4500): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on)
       VALUES ($1, $2, 'other', 'Такса', $3, current_date, current_date) RETURNING id`,
      [club.clubId, memberId, amountCents],
    );
    return result.rows[0]?.id ?? '';
  }

  async function chargeCheckout(chargeId: string, amountCents = 4500): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO club_checkouts (club_id, purpose, member_id, charge_id, amount_cents, provider, account_ref)
       VALUES ($1, 'charge', $2, $3, $4, 'fake', $5) RETURNING id`,
      [club.clubId, memberId, chargeId, amountCents, ACCOUNT],
    );
    return result.rows[0]?.id ?? '';
  }

  async function checkout(id: string) {
    const result = await client.query<{ status: string; payment_ref: string | null }>(
      `SELECT status, payment_ref FROM club_checkouts WHERE id = $1`,
      [id],
    );
    return result.rows[0];
  }

  async function onlinePayments(chargeId: string) {
    const result = await client.query<{ kind: string; amount_cents: number }>(
      `SELECT kind, amount_cents FROM club_payments
        WHERE charge_id = $1 AND method = 'card_online' ORDER BY id`,
      [chargeId],
    );
    return result.rows;
  }

  it('applies a paid charge once, however often the event arrives', async () => {
    const chargeId = await openCharge();
    const id = await chargeCheckout(chargeId);
    const paid = {
      checkoutId: id,
      provider: 'fake' as const,
      paymentRef: 'pi_test_once',
      amountCents: 4500,
      subscriptionRef: null,
    };
    expect(await applyCheckoutPaid(getDb(), paid)).toMatchObject({ applied: true });
    expect(await applyCheckoutPaid(getDb(), paid)).toEqual({
      applied: false,
      reason: 'unknown_or_done',
    });
    expect(await onlinePayments(chargeId)).toEqual([{ kind: 'payment', amount_cents: 4500 }]);
    expect(await checkout(id)).toEqual({ status: 'paid', payment_ref: 'pi_test_once' });
  });

  it('marks money that no longer fits as unapplied instead of forcing it into the books', async () => {
    const chargeId = await openCharge();
    const id = await chargeCheckout(chargeId);
    // Settled at the desk while the member was on Stripe's page.
    await client.query(
      `INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method, received_on)
       VALUES ($1, $2, $3, 'payment', 4500, 'cash', current_date)`,
      [club.clubId, chargeId, memberId],
    );
    expect(
      await applyCheckoutPaid(getDb(), {
        checkoutId: id,
        provider: 'fake',
        paymentRef: 'pi_test_late',
        amountCents: 4500,
        subscriptionRef: null,
      }),
    ).toMatchObject({ applied: false, reason: 'charge_settled' });
    expect(await checkout(id)).toEqual({ status: 'unapplied', payment_ref: 'pi_test_late' });
    expect(await onlinePayments(chargeId)).toEqual([]);

    const other = await chargeCheckout(await openCharge());
    expect(
      await applyCheckoutPaid(getDb(), {
        checkoutId: other,
        provider: 'fake',
        paymentRef: 'pi_test_amount',
        amountCents: 4400,
        subscriptionRef: null,
      }),
    ).toMatchObject({ applied: false, reason: 'amount_mismatch' });
    expect((await checkout(other))?.status).toBe('unapplied');
  });

  it('sells a plan online with its terms, and renews it once per paid invoice', async () => {
    await client.query(
      `UPDATE club_plans SET auto_renew = true, notice_days = 14, self_cancel_allowed = true
        WHERE id = $1`,
      [planId],
    );
    const created = await client.query<{ id: string }>(
      `INSERT INTO club_checkouts (club_id, purpose, member_id, plan_id, starts_on, amount_cents,
                                   mode, provider, account_ref)
       VALUES ($1, 'membership', $2, $3, current_date, 4500, 'subscription', 'fake', $4)
       RETURNING id`,
      [club.clubId, memberId, planId, ACCOUNT],
    );
    const subscriptionRef = `sub_test_${randomUUID().slice(0, 8)}`;
    expect(
      await applyCheckoutPaid(getDb(), {
        checkoutId: created.rows[0]?.id ?? '',
        provider: 'fake',
        paymentRef: 'pi_test_first',
        amountCents: 4500,
        subscriptionRef,
      }),
    ).toMatchObject({ applied: true });
    const first = await client.query(
      `SELECT renews, notice_days, self_cancel_allowed, provider_subscription_ref, sold_by
         FROM club_memberships WHERE member_id = $1`,
      [memberId],
    );
    expect(first.rows).toEqual([
      {
        renews: true,
        notice_days: 14,
        self_cancel_allowed: true,
        provider_subscription_ref: subscriptionRef,
        sold_by: null,
      },
    ]);

    // The plan's terms changing later does not reach the running contract.
    await client.query(`UPDATE club_plans SET notice_days = 60 WHERE id = $1`, [planId]);
    const invoice = {
      provider: 'fake' as const,
      subscriptionRef,
      paymentRef: 'pi_test_second',
      amountCents: 4500,
    };
    expect(await applySubscriptionInvoice(getDb(), invoice)).toMatchObject({ applied: true });
    const chain = await client.query<{ renewal_of: string | null; notice_days: number }>(
      `SELECT renewal_of, notice_days FROM club_memberships WHERE member_id = $1 ORDER BY starts_on`,
      [memberId],
    );
    expect(chain.rows).toHaveLength(2);
    expect(chain.rows[1]?.renewal_of).not.toBeNull();
    expect(chain.rows[1]?.notice_days).toBe(14);

    expect(await stopSubscription(getDb(), subscriptionRef)).toBe(2);
    const stopped = await client.query(
      `SELECT count(*)::int AS n FROM club_memberships WHERE member_id = $1 AND renews`,
      [memberId],
    );
    expect(stopped.rows[0]?.n).toBe(0);
  });

  it('records a refund once, as the negative row', async () => {
    const chargeId = await openCharge();
    await applyCheckoutPaid(getDb(), {
      checkoutId: await chargeCheckout(chargeId),
      provider: 'fake',
      paymentRef: 'pi_test_refund',
      amountCents: 4500,
      subscriptionRef: null,
    });
    const refund = {
      provider: 'fake' as const,
      paymentRef: 'pi_test_refund',
      refundRef: 're_test_once',
      amountCents: 1500,
    };
    expect(await providerPaymentKnown(getDb(), 'fake', 'pi_test_refund')).toBe(true);
    expect(await providerPaymentKnown(getDb(), 'fake', 'pi_test_nobody')).toBe(false);
    expect(await recordProviderRefund(getDb(), refund, null)).toBe(true);
    expect(await recordProviderRefund(getDb(), refund, null)).toBe(false);
    expect(await onlinePayments(chargeId)).toEqual([
      { kind: 'payment', amount_cents: 4500 },
      { kind: 'refund', amount_cents: -1500 },
    ]);
    // A partial refund leaves the remainder owed: the charge stays live.
    const live = await client.query<{ voided_at: string | null }>(
      `SELECT voided_at FROM club_charges WHERE id = $1`,
      [chargeId],
    );
    expect(live.rows[0]?.voided_at).toBeNull();
  });

  it('keeps a settled checkout final and one open checkout per charge', async () => {
    const chargeId = await openCharge();
    const id = await chargeCheckout(chargeId);
    const second = await failure(chargeCheckout(chargeId));
    expect(second.code).toBe('23505');
    expect(second.constraint).toBe('club_checkouts_one_open_per_charge');

    await applyCheckoutPaid(getDb(), {
      checkoutId: id,
      provider: 'fake',
      paymentRef: 'pi_test_final',
      amountCents: 4500,
      subscriptionRef: null,
    });
    const reopened = await failure(
      client.query(`UPDATE club_checkouts SET status = 'open', completed_at = NULL WHERE id = $1`, [
        id,
      ]),
    );
    expect(reopened.message).toMatch(/a settled checkout is final/);
    const repriced = await failure(
      client.query(`UPDATE club_checkouts SET amount_cents = 100 WHERE id = $1`, [id]),
    );
    expect(repriced.message).toMatch(/never changes/);
  });

  it('keeps one live account per club, and a disconnect is final', async () => {
    const connect = (ref: string) =>
      client.query(
        `INSERT INTO club_payment_accounts (club_id, provider, account_ref, charges_enabled)
         VALUES ($1, 'fake', $2, true)`,
        [club.clubId, ref],
      );
    await connect('acct_test_live_one');
    const twice = await failure(connect('acct_test_live_two'));
    expect(twice.constraint).toBe('club_payment_accounts_one_live');
    await client.query(
      `UPDATE club_payment_accounts SET disconnected_at = now(), charges_enabled = false
        WHERE club_id = $1`,
      [club.clubId],
    );
    const revived = await failure(
      client.query(`UPDATE club_payment_accounts SET disconnected_at = NULL WHERE club_id = $1`, [
        club.clubId,
      ]),
    );
    expect(revived.message).toMatch(/a disconnect is final/);
  });

  it('keeps the attempt, anonymised, when the client is erased', async () => {
    const chargeId = await openCharge();
    const id = await chargeCheckout(chargeId);
    await client.query(`UPDATE club_charges SET voided_at = now() WHERE id = $1`, [chargeId]);
    await client.query(`DELETE FROM club_members WHERE id = $1`, [memberId]);
    const kept = await client.query(
      `SELECT member_id, charge_id, amount_cents FROM club_checkouts WHERE id = $1`,
      [id],
    );
    expect(kept.rows).toEqual([{ member_id: null, charge_id: chargeId, amount_cents: 4500 }]);
  });

  it('dedupes a re-delivered event and forgets processed ones after 90 days', async () => {
    const eventId = `evt_test_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const event = {
      eventId,
      type: 'checkout.session.completed',
      accountRef: ACCOUNT,
      objectRef: 'cs_test_1',
    };
    const id = await recordPaymentEvent(getDb(), event);
    expect(id).not.toBeNull();
    expect(await recordPaymentEvent(getDb(), event)).toBeNull();
    await markPaymentEvent(getDb(), id ?? 0, 'applied');
    expect(await prunePaymentEvents(getDb())).toBe(0);
    await client.query(
      `UPDATE club_payment_events SET processed_at = now() - interval '91 days' WHERE id = $1`,
      [id],
    );
    expect(await prunePaymentEvents(getDb())).toBeGreaterThanOrEqual(1);
    const gone = await client.query(`SELECT 1 FROM club_payment_events WHERE id = $1`, [id]);
    expect(gone.rows).toHaveLength(0);
  });
  /** A subscription bought online (period 1 applied), for the invoice tests. */
  async function subscribed(subscriptionRef: string): Promise<void> {
    await client.query(`UPDATE club_plans SET auto_renew = true WHERE id = $1`, [planId]);
    const created = await client.query<{ id: string }>(
      `INSERT INTO club_checkouts (club_id, purpose, member_id, plan_id, starts_on, amount_cents,
                                   mode, provider, account_ref)
       VALUES ($1, 'membership', $2, $3, current_date, 4500, 'subscription', 'fake', $4)
       RETURNING id`,
      [club.clubId, memberId, planId, ACCOUNT],
    );
    await applyCheckoutPaid(getDb(), {
      checkoutId: created.rows[0]?.id ?? '',
      provider: 'fake',
      paymentRef: `pi_first_${subscriptionRef}`,
      amountCents: 4500,
      subscriptionRef,
    });
  }

  it('applies a retried invoice once — no second period, no unpaid charge', async () => {
    const subscriptionRef = `sub_test_${randomUUID().slice(0, 8)}`;
    await subscribed(subscriptionRef);
    const invoice = {
      provider: 'fake' as const,
      subscriptionRef,
      paymentRef: 'pi_test_retried',
      amountCents: 4500,
    };
    expect(await applySubscriptionInvoice(getDb(), invoice)).toMatchObject({ applied: true });
    expect(await applySubscriptionInvoice(getDb(), invoice)).toEqual({
      applied: false,
      reason: 'duplicate',
    });
    const periods = await client.query(
      `SELECT count(*)::int AS n FROM club_memberships WHERE member_id = $1`,
      [memberId],
    );
    expect(periods.rows[0]?.n).toBe(2);
    const owed = await client.query(
      `SELECT count(*)::int AS n FROM club_charge_balances WHERE member_id = $1 AND due_cents > 0`,
      [memberId],
    );
    expect(owed.rows[0]?.n).toBe(0);
  });

  it('appends no period once the office stopped renewing or the notice has ended', async () => {
    const subscriptionRef = `sub_test_${randomUUID().slice(0, 8)}`;
    await subscribed(subscriptionRef);
    await client.query(
      `UPDATE club_memberships SET renewal_ends_on = starts_on + 3 WHERE member_id = $1`,
      [memberId],
    );
    expect(
      await applySubscriptionInvoice(getDb(), {
        provider: 'fake',
        subscriptionRef,
        paymentRef: 'pi_test_after_notice',
        amountCents: 4500,
      }),
    ).toMatchObject({ applied: false, reason: 'after_notice', chain: { planId } });
    await client.query(`UPDATE club_memberships SET renews = false WHERE member_id = $1`, [
      memberId,
    ]);
    const stopped = await applySubscriptionInvoice(getDb(), {
      provider: 'fake',
      subscriptionRef,
      paymentRef: 'pi_test_stopped',
      amountCents: 4500,
    });
    expect(stopped).toMatchObject({ applied: false, reason: 'not_renewing' });
    // The money Stripe took for the refused period is listed for the office
    // as `unapplied` — once per invoice — never applied, never lost.
    const renewal = {
      provider: 'fake' as const,
      accountRef: ACCOUNT,
      subscriptionRef,
      paymentRef: 'pi_test_stopped',
      amountCents: 4500,
      chain: stopped.applied ? null : (stopped.chain ?? null),
    };
    expect(await recordUnappliedRenewal(getDb(), renewal)).toBe(true);
    expect(await recordUnappliedRenewal(getDb(), renewal)).toBe(false);
    const listed = await client.query(
      `SELECT status, mode, member_id, payment_ref FROM club_checkouts
        WHERE club_id = $1 AND payment_ref = 'pi_test_stopped'`,
      [club.clubId],
    );
    expect(listed.rows).toEqual([
      {
        status: 'unapplied',
        mode: 'subscription',
        member_id: memberId,
        payment_ref: 'pi_test_stopped',
      },
    ]);
    // A chain carries the subscription: ending it is the caller's call on
    // this very event, not a cancel owed from an earlier failure.
    expect(await subscriptionCancelOwed(getDb(), subscriptionRef)).toBe(false);
  });

  it('owes the cancel of a subscription whose first payment went unapplied, until it lands', async () => {
    await client.query(`UPDATE club_plans SET auto_renew = true WHERE id = $1`, [planId]);
    const created = await client.query<{ id: string }>(
      `INSERT INTO club_checkouts (club_id, purpose, member_id, plan_id, starts_on, amount_cents,
                                   mode, provider, account_ref)
       VALUES ($1, 'membership', $2, $3, current_date, 4500, 'subscription', 'fake', $4)
       RETURNING id`,
      [club.clubId, memberId, planId, ACCOUNT],
    );
    const subscriptionRef = `sub_test_${randomUUID().slice(0, 8)}`;
    // Stripe collected a different amount: unapplied, and the subscription
    // behind it must end. The worker's cancel call may fail right here.
    expect(
      await applyCheckoutPaid(getDb(), {
        checkoutId: created.rows[0]?.id ?? '',
        provider: 'fake',
        paymentRef: 'pi_test_owed',
        amountCents: 4400,
        subscriptionRef,
      }),
    ).toMatchObject({ applied: false, reason: 'amount_mismatch', subscriptionRef });
    // The retried event finds the checkout settled — and the cancel still owed.
    expect(
      await applyCheckoutPaid(getDb(), {
        checkoutId: created.rows[0]?.id ?? '',
        provider: 'fake',
        paymentRef: 'pi_test_owed',
        amountCents: 4400,
        subscriptionRef,
      }),
    ).toEqual({ applied: false, reason: 'unknown_or_done' });
    expect(await subscriptionCancelOwed(getDb(), subscriptionRef)).toBe(true);
    // A month later Stripe bills again: no chain, but the subscription is
    // ours — the money is listed against the opening checkout's client and plan.
    expect(
      await applySubscriptionInvoice(getDb(), {
        provider: 'fake',
        subscriptionRef,
        paymentRef: 'pi_test_owed_2',
        amountCents: 4400,
      }),
    ).toEqual({ applied: false, reason: 'no_chain' });
    expect(
      await recordUnappliedRenewal(getDb(), {
        provider: 'fake',
        accountRef: ACCOUNT,
        subscriptionRef,
        paymentRef: 'pi_test_owed_2',
        amountCents: 4400,
        chain: null,
      }),
    ).toBe(true);
    const listed = await client.query(
      `SELECT member_id, plan_id, amount_cents FROM club_checkouts
        WHERE club_id = $1 AND payment_ref = 'pi_test_owed_2' AND status = 'unapplied'`,
      [club.clubId],
    );
    expect(listed.rows).toEqual([{ member_id: memberId, plan_id: planId, amount_cents: 4400 }]);
    // A subscription no checkout of ours opened is the club's own: never ours to end or list.
    expect(await subscriptionCancelOwed(getDb(), 'sub_test_foreign')).toBe(false);
    expect(
      await recordUnappliedRenewal(getDb(), {
        provider: 'fake',
        accountRef: ACCOUNT,
        subscriptionRef: 'sub_test_foreign',
        paymentRef: 'pi_test_foreign',
        amountCents: 4400,
        chain: null,
      }),
    ).toBe(false);
  });

  it('never renews a plan bought as a one-off payment', async () => {
    await client.query(`UPDATE club_plans SET auto_renew = true WHERE id = $1`, [planId]);
    const created = await client.query<{ id: string }>(
      `INSERT INTO club_checkouts (club_id, purpose, member_id, plan_id, starts_on, amount_cents,
                                   provider, account_ref)
       VALUES ($1, 'membership', $2, $3, current_date, 4500, 'fake', $4) RETURNING id`,
      [club.clubId, memberId, planId, ACCOUNT],
    );
    await applyCheckoutPaid(getDb(), {
      checkoutId: created.rows[0]?.id ?? '',
      provider: 'fake',
      paymentRef: 'pi_test_oneoff',
      amountCents: 4500,
      subscriptionRef: null,
    });
    const sold = await client.query(`SELECT renews FROM club_memberships WHERE member_id = $1`, [
      memberId,
    ]);
    expect(sold.rows).toEqual([{ renews: false }]);
  });

  it('records money paid on a session already closed as unapplied, never lost', async () => {
    const chargeId = await openCharge();
    const id = await chargeCheckout(chargeId);
    await client.query(
      `UPDATE club_checkouts SET session_ref = 'cs_test_closed', status = 'expired',
              completed_at = now() WHERE id = $1`,
      [id],
    );
    expect(
      await applyCheckoutPaid(getDb(), {
        sessionRef: 'cs_test_closed',
        accountRef: ACCOUNT,
        provider: 'fake',
        paymentRef: 'pi_test_closed',
        amountCents: 4500,
        subscriptionRef: null,
      }),
    ).toMatchObject({ applied: false, reason: 'session_closed' });
    expect(await checkout(id)).toEqual({ status: 'unapplied', payment_ref: 'pi_test_closed' });
    // …and from another account, nothing at all.
    const other = await chargeCheckout(await openCharge());
    await client.query(`UPDATE club_checkouts SET session_ref = 'cs_test_other' WHERE id = $1`, [
      other,
    ]);
    expect(
      await applyCheckoutPaid(getDb(), {
        sessionRef: 'cs_test_other',
        accountRef: 'acct_test_someone_else',
        provider: 'fake',
        paymentRef: 'pi_test_other',
        amountCents: 4500,
        subscriptionRef: null,
      }),
    ).toEqual({ applied: false, reason: 'unknown_or_done' });
  });

  it('takes the echo of a full refund without failing the event', async () => {
    const chargeId = await openCharge();
    await applyCheckoutPaid(getDb(), {
      checkoutId: await chargeCheckout(chargeId),
      provider: 'fake',
      paymentRef: 'pi_test_full',
      amountCents: 4500,
      subscriptionRef: null,
    });
    const refund = {
      provider: 'fake' as const,
      paymentRef: 'pi_test_full',
      refundRef: 're_test_full',
      amountCents: 4500,
    };
    expect(await recordProviderRefund(getDb(), refund, null)).toBe(true);
    // Nothing paid is left on the charge, so the refund voided it — the
    // member is never shown the refunded money as owed again (whoever made
    // the refund: the office, or the club in its Stripe dashboard).
    const voided = await client.query<{ voided: boolean; reason: string | null }>(
      `SELECT ch.voided_at IS NOT NULL AS voided,
              (SELECT a.detail->>'reason' FROM club_audit a
                WHERE a.club_id = ch.club_id AND a.action = 'charge_voided'
                  AND a.detail->>'chargeId' = ch.id::text) AS reason
         FROM club_charges ch WHERE ch.id = $1`,
      [chargeId],
    );
    expect(voided.rows[0]).toEqual({ voided: true, reason: 'refunded' });
    // charge.refunded arrives later: already booked, so a no-op — not the
    // within-charge trigger refusing a duplicate on a charge with no room.
    expect(await recordProviderRefund(getDb(), refund, null)).toBe(false);
  });

  it('refuses money in any currency but EUR before comparing amounts', async () => {
    const id = await chargeCheckout(await openCharge());
    expect(
      await applyCheckoutPaid(getDb(), {
        checkoutId: id,
        provider: 'fake',
        paymentRef: 'pi_test_bgn',
        amountCents: 4500,
        currency: 'bgn',
        subscriptionRef: null,
      }),
    ).toMatchObject({ applied: false, reason: 'currency_mismatch' });
    expect(await checkout(id)).toEqual({ status: 'unapplied', payment_ref: 'pi_test_bgn' });
    const subscriptionRef = `sub_test_${randomUUID().slice(0, 8)}`;
    await subscribed(subscriptionRef);
    expect(
      await applySubscriptionInvoice(getDb(), {
        provider: 'fake',
        subscriptionRef,
        paymentRef: 'pi_test_bgn_2',
        amountCents: 4500,
        currency: 'bgn',
      }),
    ).toMatchObject({ applied: false, reason: 'currency_mismatch', chain: { planId } });
    const periods = await client.query(
      `SELECT count(*)::int AS n FROM club_memberships WHERE member_id = $1`,
      [memberId],
    );
    expect(periods.rows[0]?.n).toBe(1);
  });

  it('a revoke from the club dashboard closes the money paths on that account', async () => {
    await client.query(
      `INSERT INTO club_payment_accounts (club_id, provider, account_ref, charges_enabled)
       VALUES ($1, 'fake', $2, true)`,
      [club.clubId, ACCOUNT],
    );
    const subscriptionRef = `sub_test_${randomUUID().slice(0, 8)}`;
    await subscribed(subscriptionRef);
    const open = await chargeCheckout(await openCharge());
    // A checkout opened on another account of the club is not this revoke's.
    const elsewhere = await client.query<{ id: string }>(
      `INSERT INTO club_checkouts (club_id, purpose, member_id, charge_id, amount_cents, provider, account_ref)
       VALUES ($1, 'charge', $2, $3, 4500, 'fake', 'acct_test_elsewhere') RETURNING id`,
      [club.clubId, memberId, await openCharge()],
    );
    const gone = await markPaymentAccountGone(getDb(), ACCOUNT, new Date(Date.now() + 60_000));
    expect(gone).toEqual({ clubId: club.clubId, checkoutsExpired: 1, subscriptions: 1 });
    expect((await checkout(open))?.status).toBe('expired');
    expect((await checkout(elsewhere.rows[0]?.id ?? ''))?.status).toBe('open');
    const renewing = await client.query(
      `SELECT count(*)::int AS n FROM club_memberships WHERE member_id = $1 AND renews`,
      [memberId],
    );
    expect(renewing.rows[0]?.n).toBe(0);
    const audit = await client.query<{ actor_kind: string; detail: Record<string, unknown> }>(
      `SELECT actor_kind, detail FROM club_audit
        WHERE club_id = $1 AND action = 'payment_account_disconnected'`,
      [club.clubId],
    );
    expect(audit.rows).toEqual([
      {
        actor_kind: 'system',
        detail: {
          provider: 'stripe',
          by: 'provider',
          checkoutsExpired: 1,
          subscriptionsAtStripe: 1,
        },
      },
    ]);
    // A disconnect is final: the same event again changes nothing, tells nobody.
    expect(
      await markPaymentAccountGone(getDb(), ACCOUNT, new Date(Date.now() + 60_000)),
    ).toBeNull();
  });

  it('records a failed renewal on the chain once per invoice', async () => {
    const subscriptionRef = `sub_test_${randomUUID().slice(0, 8)}`;
    await subscribed(subscriptionRef);
    const failure = {
      provider: 'fake' as const,
      subscriptionRef,
      invoiceRef: 'in_test_failed',
      amountCents: 4500,
    };
    const first = await recordRenewalPaymentFailed(getDb(), failure);
    expect(first).toMatchObject({ clubId: club.clubId, memberId, recorded: true });
    // Stripe's retry of the same invoice raises the event again: on record already.
    expect(await recordRenewalPaymentFailed(getDb(), failure)).toEqual({
      ...first,
      recorded: false,
    });
    const audit = await client.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM club_audit WHERE club_id = $1 AND action = 'online_payment_failed'`,
      [club.clubId],
    );
    expect(audit.rows).toEqual([
      {
        detail: {
          membershipId: first?.membershipId,
          invoiceRef: 'in_test_failed',
          provider: 'fake',
          amountCents: 4500,
        },
      },
    ]);
    // Nothing in the books moved: one period, nothing owed, still renewing —
    // the next invoice.paid appends the period, invoice.payment_failed never does.
    const chain = await client.query<{ n: number; renewing: number }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE renews)::int AS renewing
         FROM club_memberships WHERE member_id = $1`,
      [memberId],
    );
    expect(chain.rows[0]).toEqual({ n: 1, renewing: 1 });
    // A subscription no chain of ours carries is the club's own business.
    expect(
      await recordRenewalPaymentFailed(getDb(), {
        ...failure,
        subscriptionRef: 'sub_test_foreign',
      }),
    ).toBeNull();
  });

  it('keeps a reconnected account when an older deauthorisation arrives', async () => {
    const before = new Date(Date.now() - 60_000);
    await client.query(
      `INSERT INTO club_payment_accounts (club_id, provider, account_ref, charges_enabled)
       VALUES ($1, 'fake', 'acct_test_reconnect', true)`,
      [club.clubId],
    );
    await markPaymentAccountGone(getDb(), 'acct_test_reconnect', before);
    const still = await client.query(
      `SELECT disconnected_at FROM club_payment_accounts WHERE account_ref = 'acct_test_reconnect'`,
    );
    expect(still.rows[0]?.disconnected_at).toBeNull();
    await markPaymentAccountGone(getDb(), 'acct_test_reconnect', new Date(Date.now() + 60_000));
    const gone = await client.query(
      `SELECT disconnected_at FROM club_payment_accounts WHERE account_ref = 'acct_test_reconnect'`,
    );
    expect(gone.rows[0]?.disconnected_at).not.toBeNull();
  });
});
