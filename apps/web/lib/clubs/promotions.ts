import { randomInt } from 'node:crypto';

import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  CLUB_TIERS,
  bestPromotion,
  clubHasFeature,
  normalizePromoCode,
  type AppliedPromotion,
  type CartItem,
  type ClubTier,
  type IsoDate,
  type Promotion,
  type PromotionBuyer,
} from '@sportkarta/lib/clubs';

import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import { clubFeatureSql } from './features';
import type { PromotionInput } from './input';
import { clubActorMay, clubScope, clubWriteScope, type ClubActor } from './scope';

/**
 * Club offers (0049, wave B1): codes, automatic offers, gift vouchers and
 * loyalty tiers. Managed by plans.manage on a tier with `promotions`; applied
 * by the till, a desk sale and an online purchase through `resolveOffer`, in
 * the purchase's own transaction, so what is charged is what the rules say.
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

function day(value: unknown): IsoDate | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

async function tierHasOffers(db: SqlRunner, clubId: string): Promise<boolean> {
  const tier = text(
    (await db.execute(sql`SELECT tier FROM clubs WHERE id = ${clubId}::uuid`)).rows[0]?.tier,
  );
  return (
    tier !== null &&
    (CLUB_TIERS as readonly string[]).includes(tier) &&
    clubHasFeature(tier as ClubTier, 'promotions')
  );
}

/**
 * Uses that still count: a use whose till sale was reversed, or whose
 * membership was cancelled as a mistake, is as if it never happened.
 */
const LIVE_USE = sql`NOT EXISTS (SELECT 1 FROM club_sales us
                                  WHERE us.club_id = rd.club_id AND us.id = rd.sale_id
                                    AND us.reversed_at IS NOT NULL)
                     AND NOT EXISTS (SELECT 1 FROM club_memberships um
                                      WHERE um.club_id = rd.club_id AND um.id = rd.membership_id
                                        AND um.cancel_reason = 'mistake')`;

/**
 * An online purchase opened with an offer RESERVES a use until it is paid or
 * its session is gone: the use itself is recorded only when the money
 * arrives, so without this a single-use voucher could be carried by several
 * open checkouts at once, or spent at the desk while one is open. Such a
 * session is short (RESERVED_SESSION_MINUTES), so an abandoned one frees the
 * use soon.
 */
const RESERVED = sql`ck.purpose = 'membership' AND ck.status = 'open'
                     AND ck.promotion_id IS NOT NULL`;

const COLUMNS = sql`po.id, po.name, po.code, po.kind, po.value, po.target,
  po.target_ids::text[] AS target_ids, to_char(po.starts_on, 'YYYY-MM-DD') AS starts_on,
  to_char(po.ends_on, 'YYYY-MM-DD') AS ends_on, po.max_uses, po.per_member_max,
  po.new_members_only, po.min_visits_90d, po.archived_at IS NOT NULL AS archived,
  (SELECT count(*)::int FROM club_promotion_redemptions rd
    WHERE rd.club_id = po.club_id AND rd.promotion_id = po.id AND ${LIVE_USE})
  + (SELECT count(*)::int FROM club_checkouts ck
      WHERE ck.club_id = po.club_id AND ck.promotion_id = po.id AND ${RESERVED}) AS uses`;

function toPromotion(row: Record<string, unknown>): Promotion {
  return {
    id: String(row.id),
    name: String(row.name),
    code: text(row.code),
    kind: String(row.kind) as Promotion['kind'],
    value: Number(row.value),
    target: String(row.target) as Promotion['target'],
    targetIds: Array.isArray(row.target_ids) ? row.target_ids.map(String) : null,
    startsOn: day(row.starts_on) ?? '1970-01-01',
    endsOn: day(row.ends_on),
    maxUses: row.max_uses === null ? null : Number(row.max_uses),
    perMemberMax: row.per_member_max === null ? null : Number(row.per_member_max),
    newMembersOnly: row.new_members_only === true,
    minVisits90d: row.min_visits_90d === null ? null : Number(row.min_visits_90d),
    uses: Number(row.uses ?? 0),
  };
}

export interface ClubPromotion extends Promotion {
  archived: boolean;
}

/** The office list: every offer, live first. */
export async function clubPromotions(actor: ClubActor): Promise<ClubPromotion[]> {
  const result = await getDb().execute(sql`
    SELECT ${COLUMNS} FROM club_promotions po
     WHERE ${clubScope(actor, 'plans.manage', 'po')}
     ORDER BY po.archived_at IS NOT NULL, po.starts_on DESC, po.name
     LIMIT 500
  `);
  return result.rows.map((row) => ({ ...toPromotion(row), archived: row.archived === true }));
}

/**
 * A club's offers open today, with their uses — what a purchase chooses
 * from: the automatic ones, plus the one whose code was typed. Never every
 * voucher the club ever issued (used-up vouchers are not archived).
 */
export async function livePromotions(
  db: SqlRunner,
  clubId: string,
  today: IsoDate,
  code: string | null,
): Promise<Promotion[]> {
  const result = await db.execute(sql`
    SELECT ${COLUMNS} FROM club_promotions po
     WHERE po.club_id = ${clubId}::uuid AND po.archived_at IS NULL
       AND po.starts_on <= ${today}::date AND (po.ends_on IS NULL OR po.ends_on >= ${today}::date)
       AND (po.code IS NULL OR po.code = ${code})
     ORDER BY po.created_at, po.id
     LIMIT 200
  `);
  return result.rows.map(toPromotion);
}

/** What the offer rules need to know about a client of the club. */
export async function buyerContext(
  db: SqlRunner,
  clubId: string,
  memberId: string,
): Promise<PromotionBuyer> {
  const [facts, uses] = await Promise.all([
    db.execute(sql`
      -- New: no abonnement beyond a trial, and none being bought online with
      -- an offer right now.
      SELECT NOT EXISTS (SELECT 1 FROM club_memberships ms
                          WHERE ms.club_id = ${clubId}::uuid AND ms.member_id = ${memberId}::uuid
                            AND ms.kind <> 'trial'
                            AND ms.cancel_reason IS DISTINCT FROM 'mistake')
             AND NOT EXISTS (SELECT 1 FROM club_checkouts ck
                              WHERE ck.club_id = ${clubId}::uuid
                                AND ck.member_id = ${memberId}::uuid AND ${RESERVED}) AS is_new,
             (SELECT count(*)::int FROM club_checkins ci
               WHERE ci.club_id = ${clubId}::uuid AND ci.member_id = ${memberId}::uuid
                 AND ci.checked_in_at >= now() - interval '90 days') AS visits
    `),
    db.execute(sql`
      SELECT promotion_id, count(*)::int AS n FROM (
        SELECT rd.promotion_id FROM club_promotion_redemptions rd
         WHERE rd.club_id = ${clubId}::uuid AND rd.member_id = ${memberId}::uuid AND ${LIVE_USE}
        UNION ALL
        SELECT ck.promotion_id FROM club_checkouts ck
         WHERE ck.club_id = ${clubId}::uuid AND ck.member_id = ${memberId}::uuid AND ${RESERVED}
      ) used
       GROUP BY promotion_id
    `),
  ]);
  return {
    isNew: facts.rows[0]?.is_new === true,
    visits90d: Number(facts.rows[0]?.visits ?? 0),
    usesByPromotion: Object.fromEntries(
      uses.rows.map((row) => [String(row.promotion_id), Number(row.n)]),
    ),
  };
}

export type OfferResult =
  | { ok: true; applied: AppliedPromotion | null }
  | { ok: false; error: 'code_invalid' | 'offer_used_up' };

/** An offer whose eligibility depends on how it was used so far. */
function capped(promotion: Promotion): boolean {
  return promotion.maxUses !== null || promotion.perMemberMax !== null || promotion.newMembersOnly;
}

/**
 * The offer a purchase gets, decided inside the purchase's transaction. Only
 * on a tier with `promotions`. A capped offer's row is LOCKED and its caps
 * re-read under the lock, so two desks cannot both spend a voucher's last use;
 * if it is gone by then, the purchase falls back to the best offer that needs
 * no lock. A typed code that gives nothing refuses the purchase: the desk
 * should know.
 */
export async function resolveOffer(
  tx: SqlRunner,
  clubId: string,
  items: readonly CartItem[],
  memberId: string | null,
  typed: string | null,
  today: IsoDate,
): Promise<OfferResult> {
  // Normalised here too, whatever the caller did: a code is matched as stored.
  const code = typed === null ? null : normalizePromoCode(typed);
  if (typed !== null && code === null) return { ok: false, error: 'code_invalid' };
  const nothing: OfferResult =
    code === null ? { ok: true, applied: null } : { ok: false, error: 'code_invalid' };
  if (!(await tierHasOffers(tx, clubId))) return nothing;
  const promotions = await livePromotions(tx, clubId, today, code);
  if (promotions.length === 0) return nothing;
  const buyer = memberId === null ? null : await buyerContext(tx, clubId, memberId);
  const first = bestPromotion(promotions, items, buyer, today, code);
  if (first.codeRejected) return { ok: false, error: 'code_invalid' };
  if (!first.applied) return { ok: true, applied: null };
  const chosen = first.applied.promotion;
  if (!capped(chosen)) return { ok: true, applied: first.applied };
  // Capped: lock it, then decide again on what is true now — among the
  // locked offer and those that need no lock.
  await tx.execute(sql`
    SELECT 1 FROM club_promotions WHERE club_id = ${clubId}::uuid AND id = ${chosen.id}::uuid
       FOR NO KEY UPDATE
  `);
  const fresh = (await livePromotions(tx, clubId, today, code)).filter(
    (p) => p.id === chosen.id || !capped(p),
  );
  const freshBuyer = memberId === null ? null : await buyerContext(tx, clubId, memberId);
  const again = bestPromotion(fresh, items, freshBuyer, today, code);
  if (code !== null && again.applied?.promotion.code !== code) {
    return { ok: false, error: 'offer_used_up' };
  }
  return { ok: true, applied: again.applied };
}

/**
 * The offer a purchase WOULD get — resolveOffer's decision, taken in a
 * transaction that is always rolled back (its lock goes with it), so a till
 * or a desk can show the amount to collect before anything is recorded.
 */
export async function previewOffer(
  db: TransactionalDb,
  clubId: string,
  items: readonly CartItem[],
  memberId: string | null,
  typed: string | null,
  today: IsoDate,
): Promise<OfferResult> {
  class Decided extends Error {
    constructor(readonly result: OfferResult) {
      super('preview');
    }
  }
  try {
    await db.transaction(async (tx) => {
      throw new Decided(await resolveOffer(tx, clubId, items, memberId, typed, today));
    });
  } catch (error: unknown) {
    if (error instanceof Decided) return error.result;
    throw error;
  }
  return { ok: true, applied: null };
}

/** Record a use, in the purchase's transaction. */
export async function recordRedemption(
  tx: SqlRunner,
  input: {
    clubId: string;
    promotionId: string;
    memberId: string | null;
    subject: { membershipId: string } | { saleId: string };
    discountCents: number;
  },
): Promise<void> {
  const membershipId = 'membershipId' in input.subject ? input.subject.membershipId : null;
  const saleId = 'saleId' in input.subject ? input.subject.saleId : null;
  await tx.execute(sql`
    INSERT INTO club_promotion_redemptions (club_id, promotion_id, subject, member_id,
                                            membership_id, sale_id, discount_cents)
    VALUES (${input.clubId}::uuid, ${input.promotionId}::uuid,
            ${saleId === null ? 'membership' : 'sale'}, ${input.memberId}::uuid,
            ${membershipId}::uuid, ${saleId}::uuid, ${input.discountCents})
  `);
}

export type SavePromotionResult =
  { ok: true; promotionId: string } | { ok: false; error: 'not_allowed' | 'code_taken' };

/** Create (id null) or edit an offer. plans.manage, on a tier with promotions. */
export async function savePromotion(
  db: TransactionalDb,
  actor: ClubActor,
  promotionId: string | null,
  input: PromotionInput,
): Promise<SavePromotionResult> {
  try {
    return await db.transaction(async (tx) => {
      const values = sql`${input.name}, ${input.code}, ${input.kind}, ${input.value}, ${input.target},
        ${input.targetIds === null ? null : sql`${sql.param(input.targetIds)}::uuid[]`},
        ${input.startsOn}::date, ${input.endsOn}::date, ${input.maxUses}, ${input.perMemberMax},
        ${input.newMembersOnly}, ${input.minVisits90d}`;
      const saved = await tx.execute(
        promotionId === null
          ? sql`
              INSERT INTO club_promotions (club_id, name, code, kind, value, target, target_ids,
                                           starts_on, ends_on, max_uses, per_member_max,
                                           new_members_only, min_visits_90d)
              SELECT ${actor.clubId}::uuid, ${values}
               WHERE ${clubActorMay(actor, 'plans.manage', { write: true })}
                 AND ${clubFeatureSql(actor.clubId, 'promotions')}
              RETURNING id`
          : sql`
              UPDATE club_promotions po
                 SET (name, code, kind, value, target, target_ids, starts_on, ends_on, max_uses,
                      per_member_max, new_members_only, min_visits_90d) = (${values})
               WHERE po.id = ${promotionId}::uuid AND po.archived_at IS NULL
                 AND ${clubWriteScope(actor, 'plans.manage', 'po')}
                 AND ${clubFeatureSql(actor.clubId, 'promotions')}
              RETURNING po.id`,
      );
      const id = text(saved.rows[0]?.id);
      if (!id) return { ok: false, error: 'not_allowed' } as const;
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'promotion_saved',
        detail: { promotionId: id, kind: input.kind, coded: input.code !== null },
      });
      return { ok: true, promotionId: id } as const;
    });
  } catch (error: unknown) {
    if (violatedConstraint(error) === 'club_promotions_code_unique') {
      return { ok: false, error: 'code_taken' };
    }
    throw error;
  }
}

export async function setPromotionArchived(
  db: TransactionalDb,
  actor: ClubActor,
  promotionId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_promotions po SET archived_at = now()
       WHERE po.id = ${promotionId}::uuid AND po.archived_at IS NULL
         AND ${clubWriteScope(actor, 'plans.manage', 'po')}
      RETURNING po.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'promotion_archived',
      detail: { promotionId },
    });
    return true;
  });
}

/** Letters and digits nobody misreads on a printed voucher (no 0/O, 1/I/L). */
const VOUCHER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A random gift-voucher code, `XXXX-XXXX` (about 40 bits). */
export function generateVoucherCode(): string {
  const pick = () => VOUCHER_ALPHABET[randomInt(VOUCHER_ALPHABET.length)] ?? 'X';
  const part = () => Array.from({ length: 4 }, pick).join('');
  return `${part()}-${part()}`;
}

export interface OfferPrice {
  priceCents: number;
  promotion: Promotion;
}

/**
 * The automatic-offer price a signed-in buyer is shown for each record they
 * may buy for (the account's own and its children's — ids from its portal
 * view) and for a client not yet on the club's books. The purchase's own
 * rules, so a returning client is never shown a new-clients-only price.
 */
export async function buyerOfferPrices(
  clubId: string,
  item: CartItem,
  memberIds: readonly string[],
  today: IsoDate,
): Promise<{ newClient: OfferPrice | null; byMember: Record<string, OfferPrice | null> }> {
  const offers = await publicOffers(clubId, today);
  const price = (buyer: PromotionBuyer): OfferPrice | null => {
    const { applied } = bestPromotion(offers, [item], buyer, today, null);
    return applied
      ? {
          priceCents: item.unitPriceCents * item.quantity - applied.totalDiscountCents,
          promotion: applied.promotion,
        }
      : null;
  };
  if (offers.length === 0) return { newClient: null, byMember: {} };
  const byMember = Object.fromEntries(
    await Promise.all(
      memberIds.map(async (id) => [id, price(await buyerContext(getDb(), clubId, id))] as const),
    ),
  );
  return { newClient: price({ isNew: true, visits90d: 0, usesByPromotion: {} }), byMember };
}

/** Whether the club's tier has offers at all — whether to show a code field. */
export async function clubTakesOffers(clubId: string): Promise<boolean> {
  return tierHasOffers(getDb(), clubId);
}

/**
 * The automatic offers a VISITOR could get, for the club page's struck-through
 * prices — public, so nothing about any client is read.
 */
export async function publicOffers(clubId: string, today: IsoDate): Promise<Promotion[]> {
  if (!(await tierHasOffers(getDb(), clubId))) return [];
  return livePromotions(getDb(), clubId, today, null);
}
