import type { ClubTier } from './access.js';

/**
 * The published price of each tier of the «Клубове» add-on — the ONE place a
 * number lives: the clubs page and the application form's hints read these,
 * so a change here changes every surface.
 *
 * Operator decision 2026-10-31: no free plan; three paid plans, each starting
 * with CLUB_TRIAL_DAYS (access.ts) of free trial. Euro cents per month,
 * invoiced by bank transfer.
 */
export const CLUB_TIER_PRICE_CENTS: Readonly<Record<ClubTier, number>> = {
  community: 4999,
  standard: 9999,
  pro: 14999,
};

/** The entry plan's ceiling on active members (set per club by the operator). */
export const COMMUNITY_MEMBER_CAP = 50;
