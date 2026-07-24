import {
  Bike,
  CircleDot,
  Crosshair,
  Crown,
  Dumbbell,
  Footprints,
  Goal,
  HeartPulse,
  type LucideIcon,
  Mountain,
  PersonStanding,
  Route,
  Shapes,
  Snowflake,
  Swords,
  Target,
  Timer,
  Triangle,
  Users,
  Volleyball,
  Waves,
} from 'lucide-react';

import { type CanonicalSport } from '@sportkarta/lib/sports';

import { FAMILY_COLOR, SPORT_FAMILY as FAMILY, type SportFamily } from './families';
import { HockeyGlyph, RacketGlyph, SkateboardGlyph } from './glyphs';

/**
 * Sport → colour family + glyph. Realises GATE 1 of docs/design/RECONCILIATION.md.
 *
 * COLOUR encodes the broad activity family (a `--cat-*` token, from ./families);
 * the GLYPH + the always-present text label encode the specific sport. Ten
 * families: the seven seed blazes plus three derived (racket, precision, multi).
 * Colours are CSS-var strings so this file holds NO hex — the token gate scans it.
 */

export { FAMILY_COLOR, type SportFamily };

/** Icon components accept Lucide's shape; custom glyphs implement the same subset. */
export type SportIconComponent = LucideIcon | typeof RacketGlyph;

export interface SportVisual {
  family: SportFamily;
  /** CSS-var colour string, e.g. `var(--cat-hike)`. */
  color: string;
  Icon: SportIconComponent;
}

const ICON: Record<CanonicalSport, SportIconComponent> = {
  hiking: Mountain,
  equestrian: Route, // no horse glyph in Lucide (RECONCILIATION §3.4)
  running: Footprints,
  athletics: Timer,
  cycling: Bike,
  bmx: Bike,
  skateboard: SkateboardGlyph,
  climbing: Triangle,
  swimming: Waves,
  ice_skating: Snowflake,
  football: Goal,
  basketball: CircleDot, // Lucide has no basketball; `Dribbble` is a brand logo
  volleyball: Volleyball,
  beach_volleyball: Volleyball,
  handball: Users,
  hockey: HockeyGlyph,
  calisthenics: Dumbbell,
  fitness: HeartPulse,
  gymnastics: PersonStanding,
  martial_arts: Swords,
  tennis: RacketGlyph,
  table_tennis: RacketGlyph,
  badminton: RacketGlyph,
  squash: RacketGlyph,
  archery: Target,
  shooting: Crosshair,
  petanque: CircleDot,
  chess: Crown,
  multi: Shapes,
};

export function sportVisual(sport: CanonicalSport): SportVisual {
  const family = FAMILY[sport];
  return { family, color: FAMILY_COLOR[family], Icon: ICON[sport] };
}

/** Every sport's visual, in canonical order — used by the /design-system page. */
export const SPORT_VISUALS: Record<CanonicalSport, SportVisual> = Object.fromEntries(
  (Object.keys(FAMILY) as CanonicalSport[]).map((s) => [s, sportVisual(s)]),
) as Record<CanonicalSport, SportVisual>;
