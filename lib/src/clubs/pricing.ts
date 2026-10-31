import { parseClock, parseClosing } from './slots.js';

/**
 * What a booking costs (0048, wave C): the service's base price, overridden by
 * peak / off-peak rules on the club's wall clock, and a member price where the
 * club sets one ("dynamic pricing" in 1club's words — here a printed table,
 * never a black box). Pure and in cents.
 *
 *   price per HOUR — every minute of the booking is priced by the rule that
 *     covers that minute (highest priority wins; the base price where none
 *     does), so 17:30–19:00 across a 18:00 peak start is half off-peak, half
 *     peak. Rounded to the cent once, at the end.
 *   price per BOOKING — the rule covering the START decides.
 *
 * A member's price: the matching rule's member price, else the rule's price;
 * with no rule, the service's member price, else its base price.
 */

export interface PriceRule {
  /** ISO weekdays, 1 = Monday. */
  weekdays: readonly number[];
  /** `HH:MM`, half-open [from, to). */
  from: string;
  to: string;
  priceCents: number;
  memberPriceCents: number | null;
  priority: number;
}

export interface PriceQuery {
  unit: 'hour' | 'booking';
  baseCents: number;
  memberBaseCents: number | null;
  rules: readonly PriceRule[];
  /** ISO weekday of the booking's start on the club's wall clock. */
  weekday: number;
  /** `HH:MM` start on the club's wall clock. */
  startLocal: string;
  durationMinutes: number;
  member: boolean;
}

function ruleAt(rules: readonly PriceRule[], weekday: number, minute: number): PriceRule | null {
  let best: PriceRule | null = null;
  for (const rule of rules) {
    const from = parseClock(rule.from);
    const to = parseClosing(rule.to);
    if (from === null || to === null) continue;
    if (!rule.weekdays.includes(weekday) || minute < from || minute >= to) continue;
    if (best === null || rule.priority > best.priority) best = rule;
  }
  return best;
}

function rate(query: PriceQuery, rule: PriceRule | null): number {
  if (rule) return query.member ? (rule.memberPriceCents ?? rule.priceCents) : rule.priceCents;
  return query.member ? (query.memberBaseCents ?? query.baseCents) : query.baseCents;
}

export function priceFor(query: PriceQuery): number | null {
  const start = parseClock(query.startLocal);
  if (start === null || query.durationMinutes <= 0) return null;
  if (query.unit === 'booking') return rate(query, ruleAt(query.rules, query.weekday, start));
  // Sum whole per-hour rates minute by minute and divide ONCE: a float sum of
  // rate/60 would let accumulation error decide a half cent.
  let total = 0;
  for (let m = 0; m < query.durationMinutes; m += 1) {
    // A booking never crosses midnight (closing time is the same day).
    total += rate(query, ruleAt(query.rules, query.weekday, start + m));
  }
  return Math.round(total / 60);
}
