import type { ClubTier } from './access.js';

/**
 * The published price of each tier of the «Клубове» add-on — the ONE place a
 * number lives: the clubs page, the application form's hints and the admin's
 * member-cap hint all read these, so a change here changes every surface.
 *
 * Anchors of 2026-10-25 (docs/MONETISATION.md S7), to be confirmed by the
 * operator before launch. Euro per month, invoiced by bank transfer; the
 * paid tiers start with CLUB_TRIAL_DAYS (access.ts) of trial.
 */
export const CLUB_TIER_PRICE_EUR: Readonly<Record<ClubTier, number>> = {
  community: 0,
  standard: 49,
  pro: 119,
};

/** The free tier's ceiling on active members (set per club by the operator). */
export const COMMUNITY_MEMBER_CAP = 50;
