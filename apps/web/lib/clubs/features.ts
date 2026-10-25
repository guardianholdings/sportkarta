import { sql, type SQL } from '@sportkarta/db';
import { CLUB_TIERS, clubHasFeature, type ClubFeature, type ClubTier } from '@sportkarta/lib/clubs';

/**
 * Whether a club may use a feature: its TIER includes it (the pure matrix in
 * lib/src/clubs/features.ts) AND, for a feature that depends on an outside
 * service, the operator has switched that service on. Both are read at
 * request time, like CLUBS_ENABLED, so flipping a switch is a compose change
 * with no rebuild.
 *
 * Pages use `featureOn` to decide what to render; a write that a feature
 * gates also embeds `clubFeatureSql`, so a forged form post to a club whose
 * tier lacks the feature changes nothing (the scope.ts rule: authorisation
 * lives in the statement).
 */

const SWITCHES = {
  payments: 'CLUB_PAYMENTS_ENABLED',
  sms: 'CLUB_SMS_ENABLED',
  push: 'CLUB_PUSH_ENABLED',
  pixels: 'CLUB_PIXELS_ENABLED',
  shop: 'CLUB_SHOP_ENABLED',
  api: 'CLUB_API_ENABLED',
} as const;
export type ClubSwitch = keyof typeof SWITCHES;

/** The outside service each tier feature needs, if any. */
const NEEDS: Partial<Record<ClubFeature, ClubSwitch>> = {
  shop: 'shop',
  invoices: 'shop',
  sms: 'sms',
  pixels: 'pixels',
  api: 'api',
  webhooks: 'api',
  mcp: 'api',
  door_access: 'api',
};

export function clubSwitchOn(name: ClubSwitch): boolean {
  return process.env[SWITCHES[name]] === 'true';
}

export function featureOn(club: { tier: ClubTier }, feature: ClubFeature): boolean {
  const needs = NEEDS[feature];
  return clubHasFeature(club.tier, feature) && (needs === undefined || clubSwitchOn(needs));
}

/** SQL: the club's tier includes `feature` (the switch is checked in code). */
export function clubFeatureSql(clubId: string, feature: ClubFeature): SQL {
  const tiers = CLUB_TIERS.filter((tier) => clubHasFeature(tier, feature));
  if (tiers.length === 0) return sql`false`;
  return sql`EXISTS (SELECT 1 FROM clubs ft WHERE ft.id = ${clubId}::uuid
                       AND ft.tier = ANY(${sql.param([...tiers])}::text[]))`;
}
