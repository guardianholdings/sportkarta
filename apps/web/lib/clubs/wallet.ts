import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  CLUB_TIERS,
  clubHasFeature,
  INVOICE_DOCUMENT,
  sofiaToday,
  type ClubPaymentMethod,
  type ClubTier,
  type IsoDate,
} from '@sportkarta/lib/clubs';

import { recordClubAudit } from './audit';
import { clubFeatureSql } from './features';
import { creditInvoice, InvoiceRefused, invoiceErrorCode, liveInvoiceIdFor } from './invoices';
import { saleErrorCode } from './sales';
import { clubActorMay, clubScope, clubWriteScope, memberSelfScope, type ClubActor } from './scope';

/**
 * A client's prepaid credit (0050, wave B2) — 1club's wallet, on the 0041
 * books: a top-up is a charge of kind 'wallet' created already paid, spending
 * is a payment with method 'wallet', and the balance is the
 * club_wallet_balances view, which club_payments_wallet keeps at zero or
 * above. Nothing here can make credit out of nothing or spend it twice: the
 * trigger decides, under a lock on the client.
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

function day(value: unknown): IsoDate {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

/** What moved a client's credit, newest first. */
export interface WalletEntry {
  receivedOn: IsoDate;
  /** top_up (+), paid_out (−, money back), spent (−), returned (+, a refund to credit). */
  kind: 'top_up' | 'paid_out' | 'spent' | 'returned';
  /** Signed, as it moved the balance. */
  amountCents: number;
  label: string;
  method: string;
}

export interface MemberWallet {
  balanceCents: number;
  entries: WalletEntry[];
}

/** The office's view of one client's credit. payments.view. */
export async function memberWallet(actor: ClubActor, memberId: string): Promise<MemberWallet> {
  const [balance, entries] = await Promise.all([
    getDb().execute(sql`
      SELECT coalesce(sum(w.balance_cents), 0)::bigint AS balance
        FROM club_wallet_balances w
        JOIN club_members m ON m.club_id = w.club_id AND m.id = w.member_id
       WHERE w.member_id = ${memberId}::uuid AND ${clubScope(actor, 'payments.view', 'm')}
    `),
    getDb().execute(sql`
      SELECT p.received_on, p.kind, p.amount_cents, p.method, ch.kind AS charge_kind, ch.label
        FROM club_payments p
        JOIN club_charges ch ON ch.club_id = p.club_id AND ch.id = p.charge_id
       WHERE ch.member_id = ${memberId}::uuid AND (ch.kind = 'wallet' OR p.method = 'wallet')
         AND ${clubScope(actor, 'payments.view', 'ch')}
       ORDER BY p.recorded_at DESC, p.id DESC
       LIMIT 50
    `),
  ]);
  return {
    balanceCents: Number(balance.rows[0]?.balance ?? 0),
    entries: entries.rows.map((row) => {
      const amount = Number(row.amount_cents);
      const topUpCharge = row.charge_kind === 'wallet';
      return {
        receivedOn: day(row.received_on),
        kind: topUpCharge
          ? row.kind === 'refund'
            ? 'paid_out'
            : 'top_up'
          : row.kind === 'refund'
            ? 'returned'
            : 'spent',
        amountCents: topUpCharge ? amount : -amount,
        label: String(row.label),
        method: String(row.method),
      };
    }),
  };
}

/**
 * The credit on each record a signed-in account may act for at one club (its
 * own and its children's) — the portal's view. Records without credit are
 * left out.
 */
export async function portalWalletBalances(
  userId: string,
  clubId: string,
): Promise<Record<string, number>> {
  // The account's records first, so the view is read for those clients only.
  const records = await getDb().execute(sql`
    SELECT m.id FROM club_members m WHERE ${memberSelfScope(userId, clubId, 'm')}
  `);
  const ids = records.rows.map((row) => String(row.id));
  if (ids.length === 0) return {};
  const result = await getDb().execute(sql`
    SELECT w.member_id, sum(w.balance_cents)::bigint AS balance
      FROM club_wallet_balances w
     WHERE w.club_id = ${clubId}::uuid AND w.member_id = ANY(${sql.param(ids)}::uuid[])
     GROUP BY w.member_id
  `);
  return Object.fromEntries(
    result.rows
      .filter((row) => Number(row.balance) !== 0)
      .map((row) => [String(row.member_id), Number(row.balance)]),
  );
}

export type WalletResult = { ok: true } | { ok: false; error: string };

/** The desk's top-up methods: real money only — never credit itself. */
export type TopUpMethod = Exclude<ClubPaymentMethod, 'wallet'>;

/**
 * SQL: this form was already handled — a desk form carries a token minted
 * when it was shown (`nonce`), written into the audit row of what it did, so
 * a double click or a resubmitted page is recognised under the client's lock
 * and does nothing the second time.
 */
function alreadyDone(clubId: string, memberId: string, nonce: string): SQL {
  return sql`EXISTS (SELECT 1 FROM club_audit au
                      WHERE au.club_id = ${clubId}::uuid AND au.subject_member_id = ${memberId}::uuid
                        AND au.acted_at > now() - interval '1 day'
                        AND au.detail->>'nonce' = ${nonce})`;
}

/**
 * Load credit at the desk: a 'wallet' charge for the amount and its payment,
 * in one transaction, so the charge is never owed. payments.record, on a tier
 * with the wallet. `label` is the charge's name in the club's words. The
 * client's row is locked first (the new charge is nobody else's yet), so a
 * repeated form (`nonce`) is seen and refused as already done.
 */
export async function topUpWallet(
  db: TransactionalDb,
  actor: ClubActor,
  input: {
    memberId: string;
    amountCents: number;
    method: TopUpMethod;
    receivedOn: IsoDate;
    nonce?: string;
  },
  label: string,
): Promise<WalletResult> {
  try {
    return await db.transaction(async (tx) => {
      const member = (
        await tx.execute(sql`
          SELECT ${input.nonce ? alreadyDone(actor.clubId, input.memberId, input.nonce) : sql`false`}
                   AS done
            FROM club_members m
           WHERE m.id = ${input.memberId}::uuid AND m.archived_at IS NULL
             AND ${clubWriteScope(actor, 'payments.record', 'm')}
             FOR NO KEY UPDATE
        `)
      ).rows[0];
      if (!member) return { ok: false, error: 'not_allowed' } as const;
      if (member.done === true) return { ok: true } as const;
      const charge = await tx.execute(sql`
        INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on,
                                  created_by)
        SELECT m.club_id, m.id, 'wallet', ${label.slice(0, 120)}, ${input.amountCents},
               ${input.receivedOn}::date, ${input.receivedOn}::date, ${actor.userId}
          FROM club_members m
         WHERE m.id = ${input.memberId}::uuid AND m.archived_at IS NULL
           AND ${clubWriteScope(actor, 'payments.record', 'm')}
           AND ${clubFeatureSql(actor.clubId, 'wallet')}
        RETURNING id
      `);
      const chargeId = text(charge.rows[0]?.id);
      if (!chargeId) return { ok: false, error: 'feature_unavailable' } as const;
      await tx.execute(sql`
        INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                   received_on, recorded_by)
        SELECT ${actor.clubId}::uuid, ${chargeId}::uuid, ${input.memberId}::uuid, 'payment',
               ${input.amountCents}, ${input.method}, ${input.receivedOn}::date, ${actor.userId}
         WHERE ${clubActorMay(actor, 'payments.record', { write: true })}
      `);
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'wallet_topped_up',
        subjectMemberId: input.memberId,
        detail: {
          chargeId,
          amountCents: input.amountCents,
          method: input.method,
          ...(input.nonce ? { nonce: input.nonce } : {}),
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

/**
 * Nothing is written: more was asked back than the client's credit
 * (wallet_insufficient), or than is loaded WITHOUT an invoice while this
 * person may not correct invoices (wallet_payout_invoiced).
 */
class WalletShort extends Error {
  constructor(readonly code: 'wallet_insufficient' | 'wallet_payout_invoiced') {
    super(code);
  }
}

/**
 * Pay credit back to the client: refunds on their top-ups, never more than
 * their balance (the trigger refuses a balance below zero anyway). Credit
 * loaded without an invoice goes back first; money loaded at the desk before
 * money loaded online, which is better refunded online, to the card it came
 * from; newest top-up first. Credit loaded WITH an invoice (credit is
 * invoiced when loaded, 2026-10-25) goes back last, and only for someone who
 * may correct invoices (invoices.issue): the same transaction writes a
 * credit note for exactly what leaves each invoiced top-up, so the invoice
 * keeps declaring only the credit that was used. The client's top-ups are
 * locked first, in id order (0050's order: charge, then client, then the
 * invoice and its counter), so two pay-outs or a pay-out and a spend are
 * serialised.
 *
 * The client's money: allowed on any tier and while the club is read-only
 * (payments.record, read scope) — as an erasure is, which waits for it.
 */
export async function payOutWallet(
  db: TransactionalDb,
  actor: ClubActor,
  input: {
    memberId: string;
    amountCents: number;
    method: TopUpMethod;
    receivedOn: IsoDate;
    nonce?: string;
  },
): Promise<WalletResult> {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`
        SELECT ch.id FROM club_charges ch
         WHERE ch.member_id = ${input.memberId}::uuid AND ch.kind = 'wallet'
           AND ${clubScope(actor, 'payments.record', 'ch')}
         ORDER BY ch.id
           FOR NO KEY UPDATE
      `);
      const member = (
        await tx.execute(sql`
          SELECT ${input.nonce ? alreadyDone(actor.clubId, input.memberId, input.nonce) : sql`false`}
                   AS done
            FROM club_members m
           WHERE m.id = ${input.memberId}::uuid AND ${clubScope(actor, 'payments.record', 'm')}
             FOR NO KEY UPDATE
        `)
      ).rows[0];
      if (!member) return { ok: false, error: 'not_allowed' } as const;
      if (member.done === true) return { ok: true } as const;
      // After the locks: fresh statements see every payment committed before.
      const state = (
        await tx.execute(sql`
          SELECT (SELECT coalesce(sum(w.balance_cents), 0) FROM club_wallet_balances w
                   WHERE w.club_id = ${actor.clubId}::uuid
                     AND w.member_id = ${input.memberId}::uuid) AS balance,
                 ${clubActorMay(actor, 'invoices.issue', { write: false })} AS may_credit
        `)
      ).rows[0];
      if (Number(state?.balance ?? 0) < input.amountCents) {
        throw new WalletShort('wallet_insufficient');
      }
      const mayCredit = state?.may_credit === true;
      const topUps = await tx.execute(sql`
        SELECT ch.id, sum(p.amount_cents)::int AS net,
               coalesce(sum(p.amount_cents) FILTER (WHERE p.method = 'card_online'), 0)::int
                 AS online,
               ${liveInvoiceIdFor(sql`ch.club_id`, sql`ch.id`)} AS invoice_id
          FROM club_charges ch
          JOIN club_payments p ON p.charge_id = ch.id
         WHERE ch.member_id = ${input.memberId}::uuid AND ch.kind = 'wallet'
           AND ${clubScope(actor, 'payments.record', 'ch')}
         GROUP BY ch.id, ch.created_at
        HAVING sum(p.amount_cents) > 0
         ORDER BY ch.created_at DESC
      `);
      const parts = topUps.rows.map((row) => {
        const net = Number(row.net);
        const online = Math.min(net, Math.max(0, Number(row.online)));
        return { id: String(row.id), desk: net - online, online, invoiceId: text(row.invoice_id) };
      });
      const passes = [
        { invoiced: false, pass: 'desk' },
        { invoiced: false, pass: 'online' },
        ...(mayCredit
          ? ([
              { invoiced: true, pass: 'desk' },
              { invoiced: true, pass: 'online' },
            ] as const)
          : []),
      ] as const;
      const take = new Map<string, number>();
      let left = input.amountCents;
      for (const { invoiced, pass } of passes) {
        for (const part of parts) {
          if (left === 0 || (part.invoiceId !== null) !== invoiced) continue;
          const back = Math.min(left, part[pass]);
          if (back > 0) {
            take.set(part.id, (take.get(part.id) ?? 0) + back);
            left -= back;
          }
        }
      }
      if (left > 0) {
        throw new WalletShort(mayCredit ? 'wallet_insufficient' : 'wallet_payout_invoiced');
      }
      for (const [chargeId, back] of take) {
        // Each refund passes club_payments_wallet, which refuses a balance
        // below zero.
        await tx.execute(sql`
          INSERT INTO club_payments (club_id, charge_id, member_id, kind, amount_cents, method,
                                     received_on, recorded_by)
          SELECT ch.club_id, ch.id, ch.member_id, 'refund', ${-back}, ${input.method},
                 ${input.receivedOn}::date, ${actor.userId}
            FROM club_charges ch
           WHERE ch.id = ${chargeId}::uuid AND ${clubScope(actor, 'payments.record', 'ch')}
        `);
        // What leaves an invoiced top-up comes off its invoice — read again
        // now that the refund holds the top-up's lock: one loaded while the
        // pay-out waited for the client was never locked above, and could
        // have been invoiced since.
        const invoiceId = text(
          (
            await tx.execute(sql`
              SELECT ${liveInvoiceIdFor(sql`${actor.clubId}::uuid`, sql`${chargeId}::uuid`)} AS id
            `)
          ).rows[0]?.id,
        );
        if (invoiceId !== null && !mayCredit) throw new WalletShort('wallet_payout_invoiced');
        if (invoiceId !== null) {
          await creditInvoice(
            tx,
            actor,
            invoiceId,
            back,
            INVOICE_DOCUMENT.creditPaidOut,
            sofiaToday(),
          );
        }
      }
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'refund_recorded',
        subjectMemberId: input.memberId,
        detail: {
          wallet: true,
          amountCents: input.amountCents,
          method: input.method,
          ...(input.nonce ? { nonce: input.nonce } : {}),
        },
      });
      return { ok: true } as const;
    });
  } catch (error: unknown) {
    if (error instanceof WalletShort || error instanceof InvoiceRefused) {
      return { ok: false, error: error.code };
    }
    const code = saleErrorCode(error) ?? invoiceErrorCode(error);
    if (code) return { ok: false, error: code };
    throw error;
  }
}

/** Whether the club's tier has prepaid credit — whether the portal offers a top-up. */
export async function clubTakesWallet(clubId: string): Promise<boolean> {
  const tier = text(
    (await getDb().execute(sql`SELECT tier FROM clubs WHERE id = ${clubId}::uuid`)).rows[0]?.tier,
  );
  return (
    tier !== null &&
    (CLUB_TIERS as readonly string[]).includes(tier) &&
    clubHasFeature(tier as ClubTier, 'wallet')
  );
}

/** The club's own language — what a top-up's charge is named in, its books' words. */
export async function clubLanguage(clubId: string): Promise<'bg' | 'en'> {
  const row = (await getDb().execute(sql`SELECT locale FROM clubs WHERE id = ${clubId}::uuid`))
    .rows[0];
  return row?.locale === 'en' ? 'en' : 'bg';
}
