import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  addDaysIso,
  membershipEndsOn,
  type ClubCancelReason,
  type ClubPlanAudience,
  type ClubPaymentMethod,
  type ClubPlanKind,
  type IsoDate,
  sofiaToday,
} from '@sportkarta/lib/clubs';

import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import { walletMethodAllowed } from './features';
import { liveInvoiceFor } from './invoices';
import type { ChargeInput, PaymentInput, PauseInput, PlanInput, SaleInput } from './input';
import { previewOffer, recordRedemption, resolveOffer } from './promotions';
import { clubActorMay, clubScope, clubWriteScope, type ClubActor } from './scope';

/**
 * What a club sells and the record of what was paid (0041). POPS RECORDS money
 * — cash, a card on the club's own terminal, a bank transfer — and never moves
 * it (decision 2026-10-24). The money rules that matter are database rules:
 * the payment total stays within the charge (trigger), payments are
 * append-only, charges are voided rather than deleted, one trial per client.
 * This module maps their refusals onto error codes a form can show.
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

/** A refusal found mid-sale: thrown so the whole sale rolls back. */
class SaleRefused extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** A database refusal, as the code a form shows; null = a real bug, rethrow. */
export function saleErrorCode(error: unknown): string | null {
  if (error instanceof SaleRefused) return error.code;
  const constraint = violatedConstraint(error);
  if (constraint === 'club_payments_within_charge') return 'amount_exceeds_due';
  if (constraint === 'club_payments_charge_not_void') return 'charge_void';
  if (constraint === 'club_memberships_one_trial') return 'trial_used';
  if (constraint === 'club_membership_pauses_no_overlap') return 'pause_overlap';
  if (constraint === 'club_membership_pauses_within_membership') return 'pause_outside';
  // Prepaid credit (0050).
  if (constraint === 'club_payments_wallet_balance') return 'wallet_insufficient';
  if (constraint === 'club_payments_wallet_member') return 'wallet_needs_client';
  if (constraint === 'club_payments_wallet_not_circular') return 'wallet_not_for_credit';
  if (constraint === 'club_charges_wallet_void') return 'wallet_void';
  if (constraint === 'club_payments_wallet_refund') return 'wallet_refund_exceeds';
  if (constraint === 'club_payments_wallet_invoiced') return 'wallet_invoiced';
  if (constraint === 'club_payments_wallet_cash_back') return 'refund_paid_by_credit';
  return null;
}

// ─── Plans ─────────────────────────────────────────────────────────────────

export interface ClubPlan extends PlanInput {
  id: string;
  archived: boolean;
  liveCount: number;
}

function toPlan(row: Record<string, unknown>): ClubPlan {
  return {
    id: String(row.id),
    nameBg: String(row.name_bg),
    nameEn: text(row.name_en),
    descriptionBg: text(row.description_bg),
    descriptionEn: text(row.description_en),
    kind: String(row.kind) as ClubPlanKind,
    audience: String(row.audience) as ClubPlanAudience,
    priceCents: Number(row.price_cents),
    validityDays: row.validity_days === null ? null : Number(row.validity_days),
    validityMonths: row.validity_months === null ? null : Number(row.validity_months),
    visitsCount: row.visits_count === null ? null : Number(row.visits_count),
    visibility: row.visibility === 'private' ? 'private' : 'public',
    autoRenew: row.auto_renew === true,
    minTermMonths: row.min_term_months === null ? null : Number(row.min_term_months),
    noticeDays: Number(row.notice_days ?? 0),
    selfPauseAllowed: row.self_pause_allowed === true,
    selfCancelAllowed: row.self_cancel_allowed === true,
    archived: row.archived_at !== null && row.archived_at !== undefined,
    liveCount: Number(row.live_count ?? 0),
  };
}

const PLAN_COLUMNS = sql`
  p.id, p.name_bg, p.name_en, p.description_bg, p.description_en, p.kind, p.audience,
  p.price_cents, p.validity_days, p.validity_months, p.visits_count, p.visibility, p.archived_at,
  p.auto_renew, p.min_term_months, p.notice_days, p.self_pause_allowed, p.self_cancel_allowed,
  (SELECT count(*)::int FROM club_membership_balances b
    WHERE b.club_id = p.club_id AND b.plan_id = p.id AND b.state IN ('active', 'paused', 'upcoming'))
    AS live_count`;

export async function listPlans(
  actor: ClubActor,
  options: { includeArchived?: boolean } = {},
): Promise<ClubPlan[]> {
  const result = await getDb().execute(sql`
    SELECT ${PLAN_COLUMNS}
      FROM club_plans p
     WHERE ${clubScope(actor, 'office.view', 'p')}
       ${options.includeArchived ? sql`` : sql`AND p.archived_at IS NULL`}
     ORDER BY p.archived_at NULLS FIRST, p.sort_order, p.price_cents, p.name_bg
  `);
  return result.rows.map(toPlan);
}

export async function planById(actor: ClubActor, planId: string): Promise<ClubPlan | null> {
  const result = await getDb().execute(sql`
    SELECT ${PLAN_COLUMNS} FROM club_plans p
     WHERE ${clubScope(actor, 'office.view', 'p')} AND p.id = ${planId}::uuid
  `);
  return result.rows[0] ? toPlan(result.rows[0]) : null;
}

export async function savePlan(
  db: TransactionalDb,
  actor: ClubActor,
  planId: string | null,
  input: PlanInput,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const values = sql`${input.nameBg}, ${input.nameEn}, ${input.descriptionBg}, ${input.descriptionEn},
      ${input.kind}, ${input.audience}, ${input.priceCents}, ${input.validityDays},
      ${input.validityMonths}, ${input.visitsCount}, ${input.visibility}, ${input.autoRenew},
      ${input.minTermMonths}, ${input.noticeDays}, ${input.selfPauseAllowed}, ${input.selfCancelAllowed}`;
    const result = planId
      ? await tx.execute(sql`
          UPDATE club_plans p
             SET (name_bg, name_en, description_bg, description_en, kind, audience, price_cents,
                  validity_days, validity_months, visits_count, visibility, auto_renew,
                  min_term_months, notice_days, self_pause_allowed, self_cancel_allowed) = (${values})
           WHERE p.id = ${planId}::uuid AND ${clubWriteScope(actor, 'plans.manage', 'p')}
           RETURNING p.id`)
      : await tx.execute(sql`
          INSERT INTO club_plans (club_id, name_bg, name_en, description_bg, description_en, kind,
                                  audience, price_cents, validity_days, validity_months,
                                  visits_count, visibility, auto_renew, min_term_months,
                                  notice_days, self_pause_allowed, self_cancel_allowed)
          SELECT ${actor.clubId}::uuid, ${values}
           WHERE ${clubActorMay(actor, 'plans.manage', { write: true })}
          RETURNING id`);
    const id = text(result.rows[0]?.id);
    if (!id) return null;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'plan_saved',
      detail: { planId: id },
    });
    return id;
  });
}

export async function setPlanArchived(
  db: TransactionalDb,
  actor: ClubActor,
  planId: string,
  archived: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_plans p SET archived_at = ${archived ? sql`now()` : sql`NULL`}
       WHERE p.id = ${planId}::uuid AND (p.archived_at IS NULL) = ${archived}
         AND ${clubWriteScope(actor, 'plans.manage', 'p')}
       RETURNING p.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: archived ? 'plan_archived' : 'plan_saved',
      detail: { planId },
    });
    return true;
  });
}

// ─── The sale ──────────────────────────────────────────────────────────────

export type SaleResult =
  { ok: true; membershipId: string; chargeId: string | null } | { ok: false; error: string };

/**
 * Sell a plan to a client: the membership (with a SNAPSHOT of the plan), its
 * charge, and — if the client pays at the desk — the payment, in ONE
 * transaction. A free plan (a free trial) raises no charge.
 *
 * Refusals: the plan is archived or not this club's ('plan_unavailable'), an
 * adults-only plan to a child or the reverse ('audience_mismatch'), the
 * community tier's member cap is full ('member_cap_reached'), the client
 * already had a trial ('trial_used'), more money than owed
 * ('amount_exceeds_due').
 */
export async function sellMembership(
  db: TransactionalDb,
  actor: ClubActor,
  input: SaleInput,
): Promise<SaleResult> {
  try {
    return await db.transaction(async (tx) => {
      // A capped (community) club serialises its sales on the club row, in a
      // statement of its own, so the count below runs on a snapshot taken
      // AFTER any concurrent sale committed — two desks cannot both sell the
      // last place under the cap.
      await tx.execute(sql`
        SELECT 1 FROM clubs WHERE id = ${actor.clubId}::uuid AND member_cap IS NOT NULL
           FOR NO KEY UPDATE
      `);
      const found = await tx.execute(sql`
        SELECT p.name_bg, p.kind, p.audience, p.price_cents, p.validity_days, p.validity_months,
               p.visits_count, p.auto_renew, p.notice_days, p.min_term_months,
               p.self_pause_allowed, p.self_cancel_allowed, m.is_minor,
               c.member_cap,
               (SELECT count(DISTINCT b.member_id)::int FROM club_membership_balances b
                 WHERE b.club_id = c.id AND b.member_id <> m.id
                   AND b.state IN ('active', 'paused', 'upcoming')) AS live_members,
               (SELECT count(*)::int FROM club_membership_balances b
                 WHERE b.club_id = c.id AND b.member_id = m.id
                   AND b.state IN ('active', 'paused', 'upcoming')) AS member_live
          FROM club_plans p
          JOIN club_members m ON m.club_id = p.club_id AND m.id = ${input.memberId}::uuid
          JOIN clubs c ON c.id = p.club_id
         WHERE ${clubScope(actor, 'sales.manage', 'p')} AND p.id = ${input.planId}::uuid
           AND p.archived_at IS NULL AND m.archived_at IS NULL
         FOR NO KEY UPDATE OF m
      `);
      const plan = found.rows[0];
      if (!plan) return { ok: false, error: 'plan_unavailable' } as const;
      const isMinor = plan.is_minor === true;
      if ((plan.audience === 'adults' && isMinor) || (plan.audience === 'minors' && !isMinor)) {
        return { ok: false, error: 'audience_mismatch' } as const;
      }
      const cap = plan.member_cap === null ? null : Number(plan.member_cap);
      if (cap !== null && Number(plan.member_live) === 0 && Number(plan.live_members) >= cap) {
        return { ok: false, error: 'member_cap_reached' } as const;
      }
      const endsOn = membershipEndsOn(
        input.startsOn,
        plan.validity_days !== null
          ? { days: Number(plan.validity_days) }
          : { months: Number(plan.validity_months) },
      );
      // The offer, if any (0049): decided here, in this transaction, on the
      // plan's list price — the desk never computes a discount by hand.
      const listCents = Number(plan.price_cents);
      const offer = await resolveOffer(
        tx,
        actor.clubId,
        [{ kind: 'plan', id: input.planId, unitPriceCents: listCents, quantity: 1 }],
        input.memberId,
        input.code ?? null,
        sofiaToday(),
      );
      if (!offer.ok) return { ok: false, error: offer.error } as const;
      const discountCents = offer.applied?.totalDiscountCents ?? 0;
      const priceCents = listCents - discountCents;
      // An offer can make a priced plan free: nothing is then owed, and an
      // amount the desk typed (the list price, quoted from memory) must be
      // refused — never dropped, or the drawer is over and the books are not.
      if (priceCents === 0 && input.payment?.amountCents) {
        return { ok: false, error: 'amount_exceeds_due' } as const;
      }
      // A plan with auto-renewal starts a chain whose term counts from today's
      // first day (0045); the club.renewals job appends the next periods.
      const renews = plan.auto_renew === true;
      const sold = await tx.execute(sql`
        INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                      price_cents, visits_total, starts_on, ends_on, sold_by,
                                      renews, term_started_on, notice_days, min_term_months,
                                      self_pause_allowed, self_cancel_allowed)
        SELECT ${actor.clubId}::uuid, ${input.memberId}::uuid, ${input.planId}::uuid,
               ${String(plan.name_bg)}, ${String(plan.kind)}, ${String(plan.audience)}, ${priceCents},
               ${plan.visits_count === null ? null : Number(plan.visits_count)},
               ${input.startsOn}::date, ${endsOn}::date, ${actor.userId},
               ${renews}, ${renews ? input.startsOn : null}::date, ${Number(plan.notice_days)},
               ${plan.min_term_months === null ? null : Number(plan.min_term_months)},
               ${plan.self_pause_allowed === true}, ${plan.self_cancel_allowed === true}
         WHERE ${clubActorMay(actor, 'sales.manage', { write: true })}
        RETURNING id
      `);
      const membershipId = text(sold.rows[0]?.id);
      if (!membershipId) return { ok: false, error: 'not_allowed' } as const;

      let chargeId: string | null = null;
      if (priceCents > 0) {
        const issuedOn =
          input.startsOn < (input.payment?.receivedOn ?? input.startsOn)
            ? input.startsOn
            : (input.payment?.receivedOn ?? input.startsOn);
        const charge = await tx.execute(sql`
          INSERT INTO club_charges (club_id, member_id, membership_id, kind, label, amount_cents,
                                    issued_on, due_on, created_by)
          VALUES (${actor.clubId}::uuid, ${input.memberId}::uuid, ${membershipId}::uuid, 'membership',
                  ${String(plan.name_bg)}, ${priceCents}, ${issuedOn}::date,
                  greatest(${issuedOn}::date, ${input.dueOn}::date), ${actor.userId})
          RETURNING id
        `);
        chargeId = text(charge.rows[0]?.id);
        if (input.payment && chargeId) {
          const paid = await tx.execute(sql`
            INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                       received_on, recorded_by)
            SELECT ${actor.clubId}::uuid, ${chargeId}::uuid, ${input.memberId}::uuid, 'payment',
                   ${input.payment.amountCents ?? priceCents}, ${input.payment.method},
                   ${input.payment.receivedOn}::date, ${actor.userId}
             WHERE ${walletMethodAllowed(actor.clubId, input.payment.method)}
            RETURNING id
          `);
          // Credit on a tier without the wallet: nothing of the sale stays.
          if (paid.rows.length === 0) throw new SaleRefused('feature_unavailable');
        }
      }
      if (offer.applied && discountCents > 0) {
        await recordRedemption(tx, {
          clubId: actor.clubId,
          promotionId: offer.applied.promotion.id,
          memberId: input.memberId,
          subject: { membershipId },
          discountCents,
        });
      }
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'membership_sold',
        subjectMemberId: input.memberId,
        detail: {
          planId: input.planId,
          priceCents,
          // What was written: no charge (a free plan) means no payment.
          paidCents:
            chargeId !== null && input.payment ? (input.payment.amountCents ?? priceCents) : 0,
          promotionId: offer.applied?.promotion.id ?? null,
        },
      });
      return { ok: true, membershipId, chargeId } as const;
    });
  } catch (error: unknown) {
    const code = saleErrorCode(error);
    if (code) return { ok: false, error: code };
    throw error;
  }
}

export type SalePreview =
  | {
      ok: true;
      listCents: number;
      discountCents: number;
      priceCents: number;
      offerName: string | null;
    }
  | { ok: false; error: string };

/**
 * What a desk sale of this plan to this client WILL cost, offer included —
 * sellMembership's decision (previewOffer), shown before the desk takes the
 * money. Writes nothing.
 */
export async function previewMembershipSale(
  db: TransactionalDb,
  actor: ClubActor,
  input: { memberId: string; planId: string; code: string | null },
): Promise<SalePreview> {
  const found = (
    await db.execute(sql`
      SELECT p.price_cents FROM club_plans p
        JOIN club_members m ON m.club_id = p.club_id AND m.id = ${input.memberId}::uuid
       WHERE ${clubScope(actor, 'sales.manage', 'p')} AND p.id = ${input.planId}::uuid
         AND p.archived_at IS NULL AND m.archived_at IS NULL
    `)
  ).rows[0];
  if (!found) return { ok: false, error: 'plan_unavailable' };
  const listCents = Number(found.price_cents);
  const offer = await previewOffer(
    db,
    actor.clubId,
    [{ kind: 'plan', id: input.planId, unitPriceCents: listCents, quantity: 1 }],
    input.memberId,
    input.code,
    sofiaToday(),
  );
  if (!offer.ok) return { ok: false, error: offer.error };
  const discountCents = offer.applied?.totalDiscountCents ?? 0;
  return {
    ok: true,
    listCents,
    discountCents,
    priceCents: listCents - discountCents,
    offerName: discountCents > 0 ? (offer.applied?.promotion.name ?? null) : null,
  };
}

// ─── Pauses, cancellation ──────────────────────────────────────────────────

export async function pauseMembership(
  db: TransactionalDb,
  actor: ClubActor,
  input: PauseInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    return await db.transaction(async (tx) => {
      // A card subscription keeps billing through a pause, so it is not paused
      // here; the member stops it and buys again, or the club pauses it in Stripe.
      const online = await tx.execute(sql`
        SELECT 1 FROM club_memberships ms
         WHERE ms.id = ${input.membershipId}::uuid AND ms.provider_subscription_ref IS NOT NULL
           AND ${clubWriteScope(actor, 'sales.manage', 'ms')}
      `);
      if (online.rows.length > 0) return { ok: false, error: 'subscription_pause' } as const;
      const created = await tx.execute(sql`
        INSERT INTO club_membership_pauses (club_id, membership_id, starts_on, ends_on, created_by)
        SELECT ms.club_id, ms.id, ${input.startsOn}::date, ${input.endsOn}::date, ${actor.userId}
          FROM club_memberships ms
         WHERE ms.id = ${input.membershipId}::uuid AND ${clubWriteScope(actor, 'sales.manage', 'ms')}
        RETURNING membership_id, (SELECT member_id FROM club_memberships WHERE id = membership_id) AS member_id
      `);
      const row = created.rows[0];
      if (!row) return { ok: false, error: 'not_allowed' } as const;
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'membership_paused',
        subjectMemberId: text(row.member_id),
        detail: { membershipId: input.membershipId, from: input.startsOn, to: input.endsOn },
      });
      return { ok: true } as const;
    });
  } catch (error: unknown) {
    const code = saleErrorCode(error);
    if (code) return { ok: false, error: code };
    throw error;
  }
}

/** End the current pause today: a pause that has not started yet is removed. */
export async function resumeMembership(
  db: TransactionalDb,
  actor: ClubActor,
  membershipId: string,
  today: IsoDate,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const scope = sql`EXISTS (SELECT 1 FROM club_memberships ms
                               WHERE ms.id = ps.membership_id AND ${clubWriteScope(actor, 'sales.manage', 'ms')})`;
    const removed = await tx.execute(sql`
      DELETE FROM club_membership_pauses ps
       WHERE ps.membership_id = ${membershipId}::uuid AND ps.starts_on >= ${today}::date
         AND ${scope}
      RETURNING ps.id`);
    const shortened = await tx.execute(sql`
      UPDATE club_membership_pauses ps SET ends_on = ${addDaysIso(today, -1)}::date
       WHERE ps.membership_id = ${membershipId}::uuid
         AND ps.starts_on < ${today}::date AND ps.ends_on >= ${today}::date
         AND ${scope}
      RETURNING ps.id`);
    if (removed.rows.length + shortened.rows.length === 0) return false;
    const member = await tx.execute(
      sql`SELECT member_id FROM club_memberships WHERE id = ${membershipId}::uuid`,
    );
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'membership_resumed',
      subjectMemberId: text(member.rows[0]?.member_id),
      detail: { membershipId },
    });
    return true;
  });
}

/**
 * Cancel a sale. A sale cancelled as a MISTAKE is as if it never happened: its
 * unpaid charge is voided too (a paid one stays — the desk refunds it, which
 * is a new row, never an edit).
 */
export async function cancelMembership(
  db: TransactionalDb,
  actor: ClubActor,
  membershipId: string,
  reason: ClubCancelReason,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_memberships ms SET cancelled_at = now(), cancel_reason = ${reason}
       WHERE ms.id = ${membershipId}::uuid AND ms.cancelled_at IS NULL
         AND ${clubWriteScope(actor, 'sales.manage', 'ms')}
      RETURNING ms.member_id
    `);
    const memberId = text(updated.rows[0]?.member_id);
    if (!memberId) return false;
    if (reason === 'mistake') {
      // Voiding is management's act (charges.void, as voidCharge): a desk
      // cancel-as-mistake leaves the unpaid charge for management to void. An
      // invoiced charge waits for its credit note (0050), whoever cancels.
      const voided = await tx.execute(sql`
        UPDATE club_charges ch SET voided_at = now()
         WHERE ch.club_id = ${actor.clubId}::uuid AND ch.membership_id = ${membershipId}::uuid
           AND ch.voided_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM club_payments p WHERE p.charge_id = ch.id)
           AND NOT ${liveInvoiceFor(sql`ch.club_id`, sql`ch.id`)}
           AND ${clubWriteScope(actor, 'charges.void', 'ch')}
        RETURNING ch.id
      `);
      for (const row of voided.rows) {
        await recordClubAudit(tx, {
          clubId: actor.clubId,
          by: { kind: 'staff', actor },
          action: 'charge_voided',
          subjectMemberId: memberId,
          detail: { chargeId: String(row.id), reason: 'membership_mistake' },
        });
      }
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'membership_cancelled',
      subjectMemberId: memberId,
      detail: { membershipId, reason },
    });
    return true;
  });
}

/**
 * Switch a renewing chain on or off from the office (0045). Off is immediate —
 * it is the club's own decision — and stops the club.renewals job from adding
 * the next period; the period already sold runs to its end. On is refused
 * when the member gave notice (the club cannot undo a member's notice), and
 * only for a membership still running or ahead — never an old one, which
 * would back-charge every period since.
 */
export async function setMembershipRenewal(
  db: TransactionalDb,
  actor: ClubActor,
  membershipId: string,
  renews: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_memberships ms
         SET renews = ${renews},
             term_started_on = coalesce(ms.term_started_on, ms.starts_on)
       WHERE ms.id = ${membershipId}::uuid AND ms.cancelled_at IS NULL AND ms.kind <> 'trial'
         AND ms.renews IS DISTINCT FROM ${renews}
         -- A card subscription, once stopped, is not restarted from the desk:
         -- the nightly job never bills it, so "on" would renew nothing.
         AND (NOT ${renews} OR ms.provider_subscription_ref IS NULL)
         AND (NOT ${renews} OR (ms.renewal_ends_on IS NULL
              AND EXISTS (SELECT 1 FROM club_membership_balances lb
                           WHERE lb.membership_id = ms.id
                             AND lb.state IN ('active', 'paused', 'upcoming'))))
         AND NOT EXISTS (SELECT 1 FROM club_memberships nx WHERE nx.renewal_of = ms.id)
         AND ${clubWriteScope(actor, 'sales.manage', 'ms')}
      RETURNING ms.member_id
    `);
    const memberId = text(updated.rows[0]?.member_id);
    if (!memberId) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: renews ? 'membership_renewed' : 'renewal_stopped',
      subjectMemberId: memberId,
      detail: { membershipId, renews },
    });
    return true;
  });
}

// ─── Charges and payments ──────────────────────────────────────────────────

export async function createCharge(
  db: TransactionalDb,
  actor: ClubActor,
  input: ChargeInput,
  today: IsoDate,
  kind: 'drop_in' | 'product' | 'fee' | 'other' = 'other',
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const created = await tx.execute(sql`
      INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on, created_by)
      SELECT m.club_id, m.id, ${kind}, ${input.label}, ${input.amountCents}, ${today}::date,
             ${input.dueOn}::date, ${actor.userId}
        FROM club_members m
       WHERE m.id = ${input.memberId}::uuid AND ${clubWriteScope(actor, 'payments.record', 'm')}
      RETURNING id
    `);
    const chargeId = text(created.rows[0]?.id);
    if (!chargeId) return null;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'charge_created',
      subjectMemberId: input.memberId,
      detail: { chargeId, kind, amountCents: input.amountCents },
    });
    return chargeId;
  });
}

export type VoidResult = 'ok' | 'not_found' | 'till_sale_charge' | 'invoice_live' | 'wallet_void';

/**
 * Void a charge. Never a till sale's (0049): that is undone by reversing the
 * sale, which also returns the goods and stops the offer's use counting —
 * voiding only its charge would leave the stock and best sellers wrong.
 * Never while it has a live invoice (0050): the credit note comes first. And
 * a top-up with money on it is paid back, never voided (the trigger refuses).
 */
export async function voidCharge(
  db: TransactionalDb,
  actor: ClubActor,
  chargeId: string,
  options: { onlyIfNothingPaid?: boolean } = {},
): Promise<VoidResult> {
  try {
    return await db.transaction(async (tx) => {
      const found = (
        await tx.execute(sql`
          SELECT EXISTS (SELECT 1 FROM club_sales sa
                          WHERE sa.club_id = ch.club_id AND sa.charge_id = ch.id) AS sale,
                 ${liveInvoiceFor(sql`ch.club_id`, sql`ch.id`)} AS invoiced
            FROM club_charges ch
           WHERE ch.id = ${chargeId}::uuid AND ch.voided_at IS NULL
             AND ${clubWriteScope(actor, 'charges.void', 'ch')}
             FOR NO KEY UPDATE
        `)
      ).rows[0];
      if (!found) return 'not_found' as const;
      if (found.sale === true) return 'till_sale_charge' as const;
      if (found.invoiced === true) return 'invoice_live' as const;
      // onlyIfNothingPaid: after a full refund, so no money is left on the
      // charge — a void row with money on it means the club still owes a refund.
      const updated = await tx.execute(sql`
        UPDATE club_charges ch SET voided_at = now()
         WHERE ch.id = ${chargeId}::uuid AND ch.voided_at IS NULL
           AND ${clubWriteScope(actor, 'charges.void', 'ch')}
           AND ${
             options.onlyIfNothingPaid
               ? sql`coalesce((SELECT sum(pp.amount_cents) FROM club_payments pp
                                WHERE pp.charge_id = ch.id), 0) = 0`
               : sql`true`
           }
        RETURNING ch.member_id
      `);
      if (updated.rows.length === 0) return 'not_found' as const;
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'charge_voided',
        subjectMemberId: text(updated.rows[0]?.member_id),
        detail: { chargeId },
      });
      return 'ok' as const;
    });
  } catch (error: unknown) {
    if (saleErrorCode(error) === 'wallet_void') return 'wallet_void';
    throw error;
  }
}

export async function recordPayment(
  db: TransactionalDb,
  actor: ClubActor,
  input: PaymentInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx.execute(sql`
        INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                   received_on, recorded_by)
        SELECT ch.club_id, ch.id, ch.member_id, ${input.kind}, ${input.amountCents}, ${input.method},
               ${input.receivedOn}::date, ${actor.userId}
          FROM club_charges ch
         WHERE ch.id = ${input.chargeId}::uuid AND ${clubWriteScope(actor, 'payments.record', 'ch')}
           -- A top-up is loaded and paid back only by its own paths (wallet.ts),
           -- which keep its invoice true (0050).
           AND ch.kind <> 'wallet'
           AND ${walletMethodAllowed(actor.clubId, input.method)}
           -- Money back on an invoiced charge waits for the credit note (0050).
           AND (${input.kind} = 'payment' OR NOT ${liveInvoiceFor(sql`ch.club_id`, sql`ch.id`)})
        RETURNING member_id
      `);
      if (inserted.rows.length === 0) {
        // Say why, when it is not simply someone else's charge.
        const why = (
          await tx.execute(sql`
            SELECT ${walletMethodAllowed(actor.clubId, input.method)} AS wallet_ok,
                   ${liveInvoiceFor(sql`ch.club_id`, sql`ch.id`)} AS invoiced
              FROM club_charges ch
             WHERE ch.id = ${input.chargeId}::uuid AND ${clubScope(actor, 'payments.record', 'ch')}
          `)
        ).rows[0];
        const error =
          why?.wallet_ok === false
            ? 'feature_unavailable'
            : why?.invoiced === true && input.kind === 'refund'
              ? 'invoice_live'
              : 'not_allowed';
        return { ok: false, error } as const;
      }
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: input.kind === 'refund' ? 'refund_recorded' : 'payment_recorded',
        subjectMemberId: text(inserted.rows[0]?.member_id),
        detail: { chargeId: input.chargeId, amountCents: input.amountCents, method: input.method },
      });
      return { ok: true } as const;
    });
  } catch (error: unknown) {
    const code = saleErrorCode(error);
    if (code) return { ok: false, error: code };
    throw error;
  }
}

/**
 * Give back everything paid on a charge (a booking cancelled in time): the
 * credit spent on it back to the client's credit, the money by `method` —
 * credit spent never leaves as money (0050, club_payments_wallet_cash_back;
 * it leaves only through a pay-out, which keeps an invoiced top-up true).
 * One transaction, the charge locked first; an invoiced charge waits for its
 * credit note (invoice_live), and card money still on it goes back online
 * (paid_online).
 */
export async function refundPaid(
  db: TransactionalDb,
  actor: ClubActor,
  input: {
    chargeId: string;
    method: Exclude<ClubPaymentMethod, 'wallet'>;
    receivedOn: IsoDate;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    return await db.transaction(async (tx) => {
      const charge = (
        await tx.execute(sql`
          SELECT ch.member_id FROM club_charges ch
           WHERE ch.id = ${input.chargeId}::uuid AND ch.kind <> 'wallet'
             AND ${clubWriteScope(actor, 'payments.record', 'ch')}
             FOR NO KEY UPDATE
        `)
      ).rows[0];
      if (!charge) return { ok: false, error: 'not_allowed' } as const;
      // After the lock: a fresh statement sees every payment committed before.
      const net = (
        await tx.execute(sql`
          SELECT coalesce(sum(p.amount_cents) FILTER (WHERE p.method = 'wallet'), 0)::int AS credit,
                 coalesce(sum(p.amount_cents) FILTER (WHERE p.method <> 'wallet'), 0)::int AS money,
                 coalesce(sum(p.amount_cents) FILTER (WHERE p.method = 'card_online'), 0)::int
                   AS online,
                 ${liveInvoiceFor(sql`${actor.clubId}::uuid`, sql`${input.chargeId}::uuid`)}
                   AS invoiced
            FROM club_payments p
           WHERE p.club_id = ${actor.clubId}::uuid AND p.charge_id = ${input.chargeId}::uuid
        `)
      ).rows[0];
      if (net?.invoiced === true) return { ok: false, error: 'invoice_live' } as const;
      // Card money goes back through the provider, from its row in the ledger:
      // a desk refund of it would leave Stripe's own refund nowhere to land.
      if (Number(net?.online ?? 0) !== 0) return { ok: false, error: 'paid_online' } as const;
      const back = [
        { method: 'wallet', cents: Number(net?.credit ?? 0) },
        { method: input.method, cents: Number(net?.money ?? 0) },
      ].filter((part) => part.cents > 0);
      if (back.length === 0) return { ok: false, error: 'not_allowed' } as const;
      for (const part of back) {
        await tx.execute(sql`
          INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                     received_on, recorded_by)
          SELECT ch.club_id, ch.id, ch.member_id, 'refund', ${-part.cents}, ${part.method},
                 ${input.receivedOn}::date, ${actor.userId}
            FROM club_charges ch
           WHERE ch.id = ${input.chargeId}::uuid
             AND ${clubWriteScope(actor, 'payments.record', 'ch')}
        `);
      }
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'refund_recorded',
        subjectMemberId: text(charge.member_id),
        detail: {
          chargeId: input.chargeId,
          amountCents: -back.reduce((sum, part) => sum + part.cents, 0),
          // How the MONEY went back — none when it was all credit.
          method: Number(net?.money ?? 0) > 0 ? input.method : null,
          creditCents: Number(net?.credit ?? 0),
        },
      });
      return { ok: true } as const;
    });
  } catch (error: unknown) {
    const code = saleErrorCode(error);
    if (code) return { ok: false, error: code };
    throw error;
  }
}

export interface LedgerRow {
  id: number;
  receivedOn: IsoDate;
  memberId: string | null;
  memberName: string | null;
  chargeLabel: string;
  kind: 'payment' | 'refund';
  method: string;
  amountCents: number;
  recordedBy: string | null;
}

/** The payments ledger for one month (YYYY-MM), optionally one method. */
export async function paymentLedger(
  actor: ClubActor,
  month: string,
  method: string | null,
): Promise<{ rows: LedgerRow[]; totalCents: number; byMethod: Record<string, number> }> {
  const from = `${month}-01`;
  const rows = await getDb().execute(sql`
    SELECT pay.id, to_char(pay.received_on, 'YYYY-MM-DD') AS received_on, pay.member_id,
           m.display_name AS member_name, ch.label, pay.kind, pay.method, pay.amount_cents,
           coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(u.display_name), ''), split_part(u.email, '@', 1)) AS recorded_by
      FROM club_payments pay
      JOIN club_charges ch ON ch.id = pay.charge_id
      LEFT JOIN club_members m ON m.club_id = pay.club_id AND m.id = pay.member_id
      LEFT JOIN users u ON u.id = pay.recorded_by
      LEFT JOIN club_staff st ON st.club_id = pay.club_id AND st.user_id = pay.recorded_by
     WHERE ${clubScope(actor, 'payments.view', 'pay')}
       AND pay.received_on >= ${from}::date AND pay.received_on < (${from}::date + interval '1 month')
       ${method ? sql`AND pay.method = ${method}` : sql``}
     ORDER BY pay.received_on DESC, pay.id DESC
     LIMIT 2000
  `);
  const ledger = rows.rows.map((row) => ({
    id: Number(row.id),
    receivedOn: String(row.received_on),
    memberId: text(row.member_id),
    memberName: text(row.member_name),
    chargeLabel: String(row.label),
    kind: row.kind === 'refund' ? ('refund' as const) : ('payment' as const),
    method: String(row.method),
    amountCents: Number(row.amount_cents),
    recordedBy: text(row.recorded_by),
  }));
  const byMethod: Record<string, number> = {};
  let totalCents = 0;
  for (const row of ledger) {
    // Money received: paying with credit (0050) is not new money — it came
    // in once, as the top-up. It keeps its own line in byMethod.
    if (row.method !== 'wallet') totalCents += row.amountCents;
    byMethod[row.method] = (byMethod[row.method] ?? 0) + row.amountCents;
  }
  return { rows: ledger, totalCents, byMethod };
}

export interface OpenCharge {
  id: string;
  memberId: string | null;
  memberName: string | null;
  label: string;
  amountCents: number;
  dueCents: number;
  dueOn: IsoDate;
  status: string;
}

/** Charges still owed — the «Дължат» panel and the payment form's choices. */
export async function openCharges(
  actor: ClubActor,
  options: { memberId?: string; limit?: number } = {},
): Promise<OpenCharge[]> {
  const result = await getDb().execute(sql`
    SELECT cb.charge_id, cb.member_id, m.display_name, cb.label, cb.amount_cents, cb.due_cents,
           to_char(cb.due_on, 'YYYY-MM-DD') AS due_on, cb.status
      FROM club_charge_balances cb
      LEFT JOIN club_members m ON m.club_id = cb.club_id AND m.id = cb.member_id
     WHERE cb.club_id = ${actor.clubId}::uuid
       AND ${clubActorMay(actor, 'payments.view', { write: false })}
       AND cb.status IN ('open', 'overdue', 'partial')
       ${options.memberId ? sql`AND cb.member_id = ${options.memberId}::uuid` : sql``}
     ORDER BY (cb.status = 'overdue') DESC, cb.due_on, cb.charge_id
     LIMIT ${options.limit ?? 200}
  `);
  return result.rows.map((row) => ({
    id: String(row.charge_id),
    memberId: text(row.member_id),
    memberName: text(row.display_name),
    label: String(row.label),
    amountCents: Number(row.amount_cents),
    dueCents: Number(row.due_cents),
    dueOn: String(row.due_on),
    status: String(row.status),
  }));
}
