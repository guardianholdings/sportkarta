import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from './client.js';
import {
  applyCheckoutPaid,
  applySubscriptionInvoice,
  markPaymentAccountGone,
  markPaymentEvent,
  prunePaymentEvents,
  recordPaymentEvent,
  recordProviderRefund,
  stopSubscription,
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
 *     events after 90 days.
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
    club = await makeClub(client, 'payments', { tier: 'community' });
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
    expect(await recordProviderRefund(getDb(), refund, null)).toBe(true);
    expect(await recordProviderRefund(getDb(), refund, null)).toBe(false);
    expect(await onlinePayments(chargeId)).toEqual([
      { kind: 'payment', amount_cents: 4500 },
      { kind: 'refund', amount_cents: -1500 },
    ]);
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
    ).toEqual({ applied: false, reason: 'after_notice' });
    await client.query(`UPDATE club_memberships SET renews = false WHERE member_id = $1`, [
      memberId,
    ]);
    expect(
      await applySubscriptionInvoice(getDb(), {
        provider: 'fake',
        subscriptionRef,
        paymentRef: 'pi_test_stopped',
        amountCents: 4500,
      }),
    ).toEqual({ applied: false, reason: 'not_renewing' });
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
    await client.query(`UPDATE club_charges SET voided_at = now() WHERE id = $1`, [chargeId]);
    // charge.refunded arrives later: already booked, so a no-op — not the
    // within-charge trigger refusing a duplicate on a charge with no room.
    expect(await recordProviderRefund(getDb(), refund, null)).toBe(false);
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
