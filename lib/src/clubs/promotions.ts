import type { IsoDate } from './dates.js';

/**
 * Club offers (0049, wave B1) — pure, so the till, a desk sale, an online
 * purchase and the struck-through prices on the club page all decide the same
 * way.
 *
 * THE RULES:
 *   - ONE offer per purchase, never stacked: of the offers that apply, the
 *     buyer gets the one worth most to them (a typed code wins a tie);
 *   - an offer without a code is AUTOMATIC — it applies without asking;
 *   - percent and fixed price act on each line; an amount off acts ONCE on
 *     what the offer covers, spread over those lines in proportion to their
 *     totals (largest remainder, so the parts add up to the cent);
 *   - a discount never takes a line below zero;
 *   - conditions that need to know the buyer (a per-client cap, new clients
 *     only, a loyalty threshold) never apply to an unknown buyer — a walk-in
 *     at the till gets only offers open to anyone.
 */

export const PROMOTION_KINDS = ['percent', 'amount', 'fixed_price'] as const;
export type PromotionKind = (typeof PROMOTION_KINDS)[number];
export const PROMOTION_TARGETS = ['all', 'plans', 'products'] as const;
export type PromotionTarget = (typeof PROMOTION_TARGETS)[number];

export interface Promotion {
  id: string;
  name: string;
  /** Upper-case; null = automatic. */
  code: string | null;
  kind: PromotionKind;
  /** percent: basis points (1 = 0.01 %); amount and fixed_price: cents. */
  value: number;
  target: PromotionTarget;
  /** Only these plans or products; null = every one the target covers. */
  targetIds: readonly string[] | null;
  startsOn: IsoDate;
  /** Inclusive; null = open-ended. */
  endsOn: IsoDate | null;
  maxUses: number | null;
  perMemberMax: number | null;
  newMembersOnly: boolean;
  minVisits90d: number | null;
  /** Uses so far (derived: reversed sales and mistaken sales do not count). */
  uses: number;
}

/** What is known about a buyer the club can name; null for a walk-in. */
export interface PromotionBuyer {
  /** Never held an abonnement other than a trial. */
  isNew: boolean;
  visits90d: number;
  /** This buyer's uses so far, by promotion id. */
  usesByPromotion: Readonly<Record<string, number>>;
}

export interface CartItem {
  kind: 'plan' | 'product';
  id: string;
  unitPriceCents: number;
  quantity: number;
}

export interface AppliedPromotion {
  promotion: Promotion;
  /** Per cart item, in cart order; each ≤ that line's total. */
  discounts: number[];
  totalDiscountCents: number;
}

const CODE = /^[A-Z0-9-]{3,24}$/;

/** A typed code, normalised the way codes are stored; null when it cannot be one. */
export function normalizePromoCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return CODE.test(code) ? code : null;
}

/** Whether the offer is open to this buyer today, with this code typed. */
export function promotionEligible(
  promotion: Promotion,
  buyer: PromotionBuyer | null,
  today: IsoDate,
  code: string | null,
): boolean {
  if (today < promotion.startsOn) return false;
  if (promotion.endsOn !== null && today > promotion.endsOn) return false;
  if (promotion.code !== null && promotion.code !== code) return false;
  if (promotion.maxUses !== null && promotion.uses >= promotion.maxUses) return false;
  if (promotion.perMemberMax !== null) {
    if (!buyer) return false;
    if ((buyer.usesByPromotion[promotion.id] ?? 0) >= promotion.perMemberMax) return false;
  }
  if (promotion.newMembersOnly && !buyer?.isNew) return false;
  if (promotion.minVisits90d !== null && (buyer?.visits90d ?? 0) < promotion.minVisits90d) {
    return false;
  }
  return true;
}

/** Whether the offer covers this plan or product at all. */
export function promotionCovers(promotion: Promotion, item: CartItem): boolean {
  if (promotion.target === 'plans' && item.kind !== 'plan') return false;
  if (promotion.target === 'products' && item.kind !== 'product') return false;
  return promotion.targetIds === null || promotion.targetIds.includes(item.id);
}

function lineTotal(item: CartItem): number {
  return item.unitPriceCents * item.quantity;
}

/** The discount the offer gives each item (0 where it does not apply). */
export function promotionDiscounts(promotion: Promotion, items: readonly CartItem[]): number[] {
  const covered = items.map((item) => promotionCovers(promotion, item));
  if (promotion.kind === 'percent') {
    return items.map((item, i) =>
      covered[i]
        ? Math.min(lineTotal(item), Math.round((lineTotal(item) * promotion.value) / 10_000))
        : 0,
    );
  }
  if (promotion.kind === 'fixed_price') {
    return items.map((item, i) =>
      covered[i] ? Math.max(0, item.unitPriceCents - promotion.value) * item.quantity : 0,
    );
  }
  // An amount off, once, over what the offer covers.
  const base = items.reduce((sum, item, i) => sum + (covered[i] ? lineTotal(item) : 0), 0);
  const off = Math.min(promotion.value, base);
  if (off === 0) return items.map(() => 0);
  const exact = items.map((item, i) => (covered[i] ? (lineTotal(item) * off) / base : 0));
  const parts = exact.map((value) => Math.floor(value));
  let left = off - parts.reduce((sum, part) => sum + part, 0);
  const order = exact
    .map((value, i) => ({ i, rest: value - Math.floor(value) }))
    .filter(({ i }) => covered[i])
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    const item = items[i];
    if (item && (parts[i] ?? 0) < lineTotal(item)) {
      parts[i] = (parts[i] ?? 0) + 1;
      left -= 1;
    }
  }
  return parts;
}

/**
 * The offer this purchase gets, if any: every eligible offer is priced and
 * the one worth most wins; on a tie a typed code beats an automatic offer,
 * otherwise the first in the list. `codeRejected` says a typed code gave
 * nothing — unknown, expired, used up, not for this buyer or these items.
 */
export function bestPromotion(
  promotions: readonly Promotion[],
  items: readonly CartItem[],
  buyer: PromotionBuyer | null,
  today: IsoDate,
  code: string | null,
): { applied: AppliedPromotion | null; codeRejected: boolean } {
  let best: AppliedPromotion | null = null;
  let codeUsable = false;
  for (const promotion of promotions) {
    if (!promotionEligible(promotion, buyer, today, code)) continue;
    const discounts = promotionDiscounts(promotion, items);
    const total = discounts.reduce((sum, d) => sum + d, 0);
    if (total <= 0) continue;
    if (promotion.code !== null) codeUsable = true;
    const better =
      best === null ||
      total > best.totalDiscountCents ||
      (total === best.totalDiscountCents &&
        promotion.code !== null &&
        best.promotion.code === null);
    if (better) best = { promotion, discounts, totalDiscountCents: total };
  }
  return { applied: best, codeRejected: code !== null && !codeUsable };
}

/**
 * The price a VISITOR sees on the club page: the best automatic offer open to
 * a new client with no history — so a loyalty offer is never advertised as
 * everyone's price. Null when nothing applies.
 */
export function advertisedPrice(
  promotions: readonly Promotion[],
  item: CartItem,
  today: IsoDate,
): { priceCents: number; promotion: Promotion } | null {
  const visitor: PromotionBuyer = { isNew: true, visits90d: 0, usesByPromotion: {} };
  const { applied } = bestPromotion(
    promotions.filter((p) => p.code === null),
    [item],
    visitor,
    today,
    null,
  );
  if (!applied) return null;
  return { priceCents: lineTotal(item) - applied.totalDiscountCents, promotion: applied.promotion };
}
