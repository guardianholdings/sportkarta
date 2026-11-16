import type { ClubTier } from './access.js';

/**
 * The published price of each tier of the «Клубове» add-on — the ONE place a
 * number lives: the clubs page and the application form's hints read these,
 * so a change here changes every surface.
 *
 * Operator decision 2026-10-31: no free plan; three paid plans, each starting
 * with CLUB_TRIAL_DAYS (access.ts) of free trial. Euro cents per month,
 * invoiced by bank transfer.
 *
 * Operator decisions 2026-11-06: the price is FLAT per tier (never per active
 * member — the cap below is a ceiling, not a meter) and these amounts are NET
 * of VAT: the association is registered under ЗДДС and the invoice adds VAT at
 * the statutory rate. Every surface that prints a tier price therefore says
 * «без ДДС» (apps/web/tests/clubs-pricing-vat.test.ts). The invoice itself is
 * issued by the administrator from the accounting system, outside this code.
 */
export const CLUB_TIER_PRICE_CENTS: Readonly<Record<ClubTier, number>> = {
  community: 4999,
  standard: 9999,
  pro: 14999,
};

/** The entry plan's ceiling on active members (set per club by the operator). */
export const COMMUNITY_MEMBER_CAP = 50;

/**
 * The VAT rate the invoice adds on top of the net prices above (ЗДДС чл. 66,
 * standard rate). Copy prints it through `{vat}`, never as a typed number, so a
 * rate change is this one line.
 */
export const CLUB_VAT_RATE_PERCENT = 20;
