import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  addDaysIso,
  membershipEndsOn,
  type ClubCancelReason,
  type ClubPlanAudience,
  type ClubPlanKind,
  type IsoDate,
} from '@sportkarta/lib/clubs';

import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import type { ChargeInput, PaymentInput, PauseInput, PlanInput, SaleInput } from './input';
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

/** A database refusal, as the code a form shows; null = a real bug, rethrow. */
export function saleErrorCode(error: unknown): string | null {
  const constraint = violatedConstraint(error);
  if (constraint === 'club_payments_within_charge') return 'amount_exceeds_due';
  if (constraint === 'club_payments_charge_not_void') return 'charge_void';
  if (constraint === 'club_memberships_one_trial') return 'trial_used';
  if (constraint === 'club_membership_pauses_no_overlap') return 'pause_overlap';
  if (constraint === 'club_membership_pauses_within_membership') return 'pause_outside';
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
    archived: row.archived_at !== null && row.archived_at !== undefined,
    liveCount: Number(row.live_count ?? 0),
  };
}

const PLAN_COLUMNS = sql`
  p.id, p.name_bg, p.name_en, p.description_bg, p.description_en, p.kind, p.audience,
  p.price_cents, p.validity_days, p.validity_months, p.visits_count, p.visibility, p.archived_at,
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
      ${input.validityMonths}, ${input.visitsCount}, ${input.visibility}`;
    const result = planId
      ? await tx.execute(sql`
          UPDATE club_plans p
             SET (name_bg, name_en, description_bg, description_en, kind, audience, price_cents,
                  validity_days, validity_months, visits_count, visibility) = (${values})
           WHERE p.id = ${planId}::uuid AND ${clubWriteScope(actor, 'plans.manage', 'p')}
           RETURNING p.id`)
      : await tx.execute(sql`
          INSERT INTO club_plans (club_id, name_bg, name_en, description_bg, description_en, kind,
                                  audience, price_cents, validity_days, validity_months,
                                  visits_count, visibility)
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
               p.visits_count, m.is_minor,
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
      const priceCents = Number(plan.price_cents);
      const sold = await tx.execute(sql`
        INSERT INTO club_memberships (club_id, member_id, plan_id, plan_name, kind, audience,
                                      price_cents, visits_total, starts_on, ends_on, sold_by)
        SELECT ${actor.clubId}::uuid, ${input.memberId}::uuid, ${input.planId}::uuid,
               ${String(plan.name_bg)}, ${String(plan.kind)}, ${String(plan.audience)}, ${priceCents},
               ${plan.visits_count === null ? null : Number(plan.visits_count)},
               ${input.startsOn}::date, ${endsOn}::date, ${actor.userId}
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
          await tx.execute(sql`
            INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                       received_on, recorded_by)
            VALUES (${actor.clubId}::uuid, ${chargeId}::uuid, ${input.memberId}::uuid, 'payment',
                    ${input.payment.amountCents}, ${input.payment.method},
                    ${input.payment.receivedOn}::date, ${actor.userId})
          `);
        }
      }
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'membership_sold',
        subjectMemberId: input.memberId,
        detail: { planId: input.planId, priceCents, paidCents: input.payment?.amountCents ?? 0 },
      });
      return { ok: true, membershipId, chargeId } as const;
    });
  } catch (error: unknown) {
    const code = saleErrorCode(error);
    if (code) return { ok: false, error: code };
    throw error;
  }
}

// ─── Pauses, cancellation ──────────────────────────────────────────────────

export async function pauseMembership(
  db: TransactionalDb,
  actor: ClubActor,
  input: PauseInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    return await db.transaction(async (tx) => {
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
      await tx.execute(sql`
        UPDATE club_charges ch SET voided_at = now()
         WHERE ch.club_id = ${actor.clubId}::uuid AND ch.membership_id = ${membershipId}::uuid
           AND ch.voided_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM club_payments p WHERE p.charge_id = ch.id)
      `);
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

export async function voidCharge(
  db: TransactionalDb,
  actor: ClubActor,
  chargeId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_charges ch SET voided_at = now()
       WHERE ch.id = ${chargeId}::uuid AND ch.voided_at IS NULL
         AND ${clubWriteScope(actor, 'charges.void', 'ch')}
      RETURNING ch.member_id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'charge_voided',
      subjectMemberId: text(updated.rows[0]?.member_id),
      detail: { chargeId },
    });
    return true;
  });
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
        RETURNING member_id
      `);
      if (inserted.rows.length === 0) return { ok: false, error: 'not_allowed' } as const;
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
           coalesce(st.display_name, u.display_name) AS recorded_by
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
    totalCents += row.amountCents;
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
