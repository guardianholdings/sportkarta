import {
  type CatalogueRow,
  type ClubService,
  type ClubTier,
  clubHasFeature,
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

/** What one cell of the pricing grid prints for a row and a tier. */
export type GridMark = 'included' | 'soon' | 'excluded';

/**
 * The pricing grid's cell (UX audit 2026-10-31, DR-02): a tier without the
 * row's feature prints the dash; a row that is «скоро» prints «скоро» in
 * EVERY tier's cell and never the included tick, so the grid cannot say that
 * something the operator has not switched on is included today. Derived from
 * rowState, so the chip beside the row's name and its cells cannot disagree.
 */
export function gridMark(
  row: Pick<CatalogueRow, 'feature' | 'service'>,
  tier: ClubTier,
  switchOn: (service: ClubService) => boolean = clubSwitchOn,
): GridMark {
  if (row.feature !== undefined && !clubHasFeature(tier, row.feature)) return 'excluded';
  return rowState(row, switchOn).soon ? 'soon' : 'included';
}

/**
 * The rows every tier has in the pricing grid (/za-klubove) — copy rows above
 * the tier matrix, in this order. A row that depends on an outside service
 * names it, so the grid marks it «скоро» while the switch is off exactly as
 * the catalogue does (rowState).
 */
export const PRICING_INCLUDED: readonly { key: string; service?: ClubService }[] = [
  { key: 'members' },
  { key: 'timetable' },
  { key: 'attendance' },
  { key: 'portal' },
  { key: 'email' },
  { key: 'push', service: 'push' },
  { key: 'reports' },
  { key: 'documents' },
  { key: 'ranks' },
  { key: 'events' },
  { key: 'courts' },
  { key: 'payments', service: 'payments' },
  { key: 'inbox' },
  { key: 'page' },
];

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
