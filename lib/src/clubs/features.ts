import type { ClubTier } from './access.js';

/**
 * What each tier of the add-on includes — one total, pure matrix
 * (plan 2026-10-25, "Default tier matrix"; the operator may move a feature
 * between tiers by editing THIS table, nothing else).
 *
 * Only features that differ between tiers are listed. What every club gets —
 * members, timetable, bookings, attendance, the portal, e-mail, import and
 * export, the basic reports, documents, ranks, events, courts and rooms, and
 * online payments — is not gated by tier at all.
 *
 * A feature that depends on an outside service (payments, SMS, push, pixels,
 * the shop, the API) is ALSO behind an env master switch read in
 * apps/web/lib/clubs/features.ts, so a tier can include it before the operator
 * has switched the service on. The two checks are independent: tier decides
 * what a club bought, the switch decides whether POPS runs it at all.
 */

export const CLUB_FEATURES = [
  'reports_advanced',
  'staff_pay',
  'embeds',
  'shop',
  'promotions',
  'wallet',
  'invoices',
  'broadcasts',
  'automations',
  'sms',
  'feedback',
  'pixels',
  'api',
  'webhooks',
  'mcp',
  'door_access',
] as const;
export type ClubFeature = (typeof CLUB_FEATURES)[number];

const STANDARD: readonly ClubFeature[] = [
  'reports_advanced',
  'staff_pay',
  'embeds',
  'shop',
  'promotions',
  'wallet',
  'invoices',
  'broadcasts',
  'automations',
  'sms',
  'feedback',
  'pixels',
];

const MATRIX: Readonly<Record<ClubTier, readonly ClubFeature[]>> = {
  community: [],
  standard: STANDARD,
  pro: CLUB_FEATURES,
};

export function isClubFeature(value: unknown): value is ClubFeature {
  return typeof value === 'string' && (CLUB_FEATURES as readonly string[]).includes(value);
}

/** Whether `tier` includes `feature`. */
export function clubHasFeature(tier: ClubTier, feature: ClubFeature): boolean {
  return MATRIX[tier].includes(feature);
}

/** Every feature `tier` includes, in catalogue order. */
export function tierFeatures(tier: ClubTier): readonly ClubFeature[] {
  return CLUB_FEATURES.filter((feature) => MATRIX[tier].includes(feature));
}

/** The cheapest tier that includes `feature` — what an upsell names. */
export function lowestTierWith(feature: ClubFeature): ClubTier {
  if (MATRIX.community.includes(feature)) return 'community';
  if (MATRIX.standard.includes(feature)) return 'standard';
  return 'pro';
}
