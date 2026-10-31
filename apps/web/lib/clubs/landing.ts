import {
  type CatalogueRow,
  type ClubService,
  type ClubTier,
  lowestTierWith,
} from '@sportkarta/lib/clubs';

import { clubSwitchOn, serviceFor } from './features';

/**
 * What the clubs page says beside a catalogue row — pure, so a test can hand
 * it any set of switches:
 *   - `tier`: the cheapest tier that includes the row's feature, or null for a
 *     row every tier has (no chip);
 *   - `soon`: the row depends on an outside service the operator has not
 *     switched on, so the page must not sell it as available today.
 */
export interface RowState {
  tier: ClubTier | null;
  soon: boolean;
}

export function rowState(
  row: Pick<CatalogueRow, 'feature' | 'service'>,
  switchOn: (service: ClubService) => boolean = clubSwitchOn,
): RowState {
  const tier = row.feature === undefined ? null : lowestTierWith(row.feature);
  const service = row.feature === undefined ? row.service : serviceFor(row.feature);
  return {
    tier: tier === 'community' ? null : tier,
    soon: service !== undefined && !switchOn(service),
  };
}

/**
 * Whether POPS takes no share of a club's online payments — true while
 * STRIPE_APPLICATION_FEE_BP is unset, zero or not a number (which the payment
 * provider also reads as zero, lib/src/payments/provider.ts). The page shows
 * its «без комисиона» line only then, so raising the fee removes the claim by
 * itself.
 */
export function platformFeeFree(raw: string | undefined = process.env.STRIPE_APPLICATION_FEE_BP) {
  const value = raw ?? '';
  return !/^\d{1,4}$/.test(value) || Number(value) === 0;
}
