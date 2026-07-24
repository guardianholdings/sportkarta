import { type CanonicalSport } from '@sportkarta/lib/sports';

/**
 * Pure sport→family→colour model (no React, no lucide) so the MapLibre canvas
 * can colour teardrop markers without dragging the icon registry into the map
 * bundle. The visual registry (sport-visuals.tsx) builds on this and adds icons.
 * See docs/design/RECONCILIATION.md §3 — colour encodes the broad family.
 */

export type SportFamily =
  | 'trail'
  | 'run'
  | 'wheels'
  | 'climb'
  | 'water'
  | 'team'
  | 'body'
  | 'racket'
  | 'precision'
  | 'multi';

/** CSS-var colour string per family — 7 seed blazes + 3 derived. */
export const FAMILY_COLOR: Record<SportFamily, string> = {
  trail: 'var(--cat-hike)',
  run: 'var(--cat-run)',
  wheels: 'var(--cat-bike)',
  climb: 'var(--cat-climb)',
  water: 'var(--cat-swim)',
  team: 'var(--cat-team)',
  body: 'var(--cat-calisthenics)',
  racket: 'var(--cat-racket)',
  precision: 'var(--cat-precision)',
  multi: 'var(--cat-multi)',
};

export const SPORT_FAMILY: Record<CanonicalSport, SportFamily> = {
  hiking: 'trail',
  equestrian: 'trail',
  running: 'run',
  athletics: 'run',
  cycling: 'wheels',
  bmx: 'wheels',
  skateboard: 'wheels',
  climbing: 'climb',
  swimming: 'water',
  ice_skating: 'water',
  football: 'team',
  basketball: 'team',
  volleyball: 'team',
  beach_volleyball: 'team',
  handball: 'team',
  hockey: 'team',
  calisthenics: 'body',
  fitness: 'body',
  gymnastics: 'body',
  martial_arts: 'body',
  tennis: 'racket',
  table_tennis: 'racket',
  badminton: 'racket',
  squash: 'racket',
  archery: 'precision',
  shooting: 'precision',
  petanque: 'precision',
  chess: 'precision',
  multi: 'multi',
};

/**
 * The family that colours a facility's marker. A facility carries several
 * sports; the first canonical one that maps cleanly wins, falling back to the
 * neutral `multi` family for an empty or unrecognised list — so a marker always
 * has a colour and a mixed-use site reads as neutral rather than picking a
 * sport it happens to list first.
 */
export function facilityFamily(sports: readonly string[]): SportFamily {
  if (sports.length > 1) {
    const distinct = new Set(sports.map((s) => SPORT_FAMILY[s as CanonicalSport]).filter(Boolean));
    if (distinct.size > 1) return 'multi';
  }
  for (const s of sports) {
    const fam = SPORT_FAMILY[s as CanonicalSport];
    if (fam) return fam;
  }
  return 'multi';
}
