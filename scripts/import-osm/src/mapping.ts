/**
 * Tag → schema normalization tables, operator-approved (hard stop a).
 * Every change here re-triggers the dry-run review gate before a live import.
 *
 * Amended 2026-09-29 — operator-approved pre-launch audit corrections:
 *  - pools, water parks, ice rinks and riding venues default to `paid`
 *    unless OSM says fee=no or access=yes/public (audit finding 80: 150 of
 *    them had reached the free map on no evidence at all);
 *  - objects OSM marks abandoned/disused are not facilities (finding 81).
 * The approval covers the rules; the dry-run report of the next import is
 * still the gate before it goes live.
 */

export type OsmTags = Record<string, string>;

export type Access = 'free' | 'paid' | 'restricted' | 'school';

/** leisure values extracted unconditionally. */
export const QUALIFYING_LEISURE = new Set([
  'pitch',
  'fitness_station',
  'sports_centre',
  'track',
  // Commercial gyms/studios (item 2, 2026-07-25): imported as access='paid',
  // publicly visible only behind the 0018 master + per-business switches.
  'fitness_centre',
]);

/** OSM sport=* token → canonical sport slug (UI translates via i18n). */
export const SPORT_MAP: Record<string, string> = {
  soccer: 'football',
  football: 'football',
  futsal: 'football',
  basketball: 'basketball',
  tennis: 'tennis',
  volleyball: 'volleyball',
  beachvolleyball: 'beach_volleyball',
  table_tennis: 'table_tennis',
  fitness: 'fitness',
  crossfit: 'fitness',
  yoga: 'fitness',
  calisthenics: 'calisthenics',
  athletics: 'athletics',
  running: 'running',
  multi: 'multi',
  skateboard: 'skateboard',
  bmx: 'bmx',
  cycling: 'cycling',
  handball: 'handball',
  badminton: 'badminton',
  squash: 'squash',
  gymnastics: 'gymnastics',
  martial_arts: 'martial_arts',
  boxing: 'martial_arts',
  judo: 'martial_arts',
  karate: 'martial_arts',
  taekwondo: 'martial_arts',
  wrestling: 'martial_arts',
  swimming: 'swimming',
  hockey: 'hockey',
  field_hockey: 'hockey',
  ice_hockey: 'hockey',
  ice_skating: 'ice_skating',
  petanque: 'petanque',
  boules: 'petanque',
  chess: 'chess',
  climbing: 'climbing',
  bouldering: 'climbing',
  equestrian: 'equestrian',
  shooting: 'shooting',
  archery: 'archery',
};

/** OSM surface=* value → canonical surface slug. */
export const SURFACE_MAP: Record<string, string> = {
  grass: 'grass',
  artificial_turf: 'artificial_turf',
  artificial_grass: 'artificial_turf',
  astroturf: 'artificial_turf',
  synthetic_grass: 'artificial_turf',
  asphalt: 'asphalt',
  concrete: 'concrete',
  'concrete:plates': 'concrete',
  'concrete:lanes': 'concrete',
  clay: 'clay',
  sand: 'sand',
  tartan: 'tartan',
  acrylic: 'acrylic',
  hard: 'acrylic',
  rubber: 'rubber',
  rubbercrumb: 'rubber',
  paved: 'paved',
  paving_stones: 'paved',
  unpaved: 'unpaved',
  compacted: 'unpaved',
  gravel: 'unpaved',
  fine_gravel: 'unpaved',
  dirt: 'unpaved',
  earth: 'unpaved',
  ground: 'unpaved',
  mud: 'unpaved',
  wood: 'wood',
  parquet: 'wood',
  ice: 'ice',
};

const LIT_TRUE = new Set(['yes', 'automatic', '24/7', 'limited', 'interval']);

const VENUE_AMENITIES = new Set([
  'pub',
  'bar',
  'cafe',
  'restaurant',
  'fast_food',
  'nightclub',
  'cinema',
]);

export interface SportMapping {
  sports: string[];
  unmapped: string[];
}

/**
 * sport=* is semicolon-multi-valued; tokens map independently and dedupe.
 * Sorted output keeps array comparison stable across runs (idempotency).
 * leisure=fitness_station and leisure=fitness_centre imply fitness when no
 * sport tag maps.
 */
export function mapSports(sportTag: string | undefined, leisure: string | undefined): SportMapping {
  const sports = new Set<string>();
  const unmapped: string[] = [];
  if (sportTag) {
    for (const raw of sportTag.split(';')) {
      const token = raw.trim().toLowerCase();
      if (!token) continue;
      const mapped = SPORT_MAP[token];
      if (mapped) {
        sports.add(mapped);
      } else {
        unmapped.push(token);
      }
    }
  }
  if (sports.size === 0 && (leisure === 'fitness_station' || leisure === 'fitness_centre')) {
    sports.add('fitness');
  }
  return { sports: [...sports].sort(), unmapped };
}

export interface SurfaceMapping {
  surface: string | null;
  unmapped?: string;
}

export function mapSurface(raw: string | undefined): SurfaceMapping {
  if (!raw) return { surface: null };
  const token = raw.trim().toLowerCase();
  const mapped = SURFACE_MAP[token];
  return mapped ? { surface: mapped } : { surface: null, unmapped: token };
}

export interface LightingMapping {
  lighting: boolean | null;
  unusual?: string;
}

/** lit=* → tri-state lighting; NULL = unknown (schema comment). */
export function mapLighting(raw: string | undefined): LightingMapping {
  if (!raw) return { lighting: null };
  const token = raw.trim().toLowerCase();
  if (LIT_TRUE.has(token)) return { lighting: true };
  if (token === 'no') return { lighting: false };
  return { lighting: null, unusual: token };
}

export function mapCovered(tags: OsmTags): boolean {
  const covered = tags['covered']?.toLowerCase();
  if (covered === 'yes' || covered === 'roof') return true;
  if (tags['indoor']?.toLowerCase() === 'yes') return true;
  const building = tags['building']?.toLowerCase();
  return building !== undefined && building !== 'no';
}

/**
 * Venues that almost always charge at the door. They reach the extract through
 * their sport=* tag (swimming, ice_skating, equestrian), and with no fee or
 * access tag — 133 of 137 pools had neither — the old catch-all made them
 * `free`: water parks, mineral baths and hotel pools on a map of free places.
 * Absence of a fee tag is not evidence of free entry for these, so they
 * default the other way (2026-09-29, operator-approved).
 */
export const PAID_BY_DEFAULT_LEISURE = new Set([
  'swimming_pool',
  'water_park',
  'ice_rink',
  'horse_riding',
]);

/**
 * First matching rule wins. OSM has no reliable school tag — `school`
 * classification comes from crowd verification and municipal data (Stage 6).
 * A private pool lands in `restricted` through the first rule, like any other
 * access=private object.
 */
export function mapAccess(tags: OsmTags): Access {
  const access = tags['access']?.toLowerCase();
  if (access === 'private' || access === 'no' || access === 'military') return 'restricted';
  if (tags['fee']?.toLowerCase() === 'yes') return 'paid';
  if (access === 'customers') return 'paid';
  if (tags['fee']?.toLowerCase() === 'no') return 'free';
  if (tags['leisure'] === 'sports_centre') return 'paid';
  // A gym is a business: paid unless it explicitly says otherwise above.
  if (tags['leisure'] === 'fitness_centre') return 'paid';
  const leisure = tags['leisure'];
  if (leisure !== undefined && PAID_BY_DEFAULT_LEISURE.has(leisure)) {
    // An explicit public-access claim is the one signal besides fee=no that
    // the operator accepted as "free to walk in".
    return access === 'yes' || access === 'public' ? 'free' : 'paid';
  }
  return 'free';
}

/** OSM lifecycle keys (https://wiki.openstreetmap.org/wiki/Lifecycle_prefix). */
const LIFECYCLE_STATES = ['abandoned', 'disused'] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

/**
 * Is this object marked as no longer in use? `abandoned=yes` / `disused=yes`,
 * or any `abandoned:*` / `disused:*` key (the prefixed form mappers use when
 * they move `leisure=pitch` to `disused:leisure=pitch`). Such an object is not
 * a facility anybody should be sent to — 24 of them were on the public map
 * with a «Упъти ме» button (audit finding 81).
 */
export function lifecycleState(tags: OsmTags): LifecycleState | undefined {
  for (const state of LIFECYCLE_STATES) {
    if (tags[state]?.toLowerCase() === 'yes') return state;
  }
  for (const key of Object.keys(tags)) {
    for (const state of LIFECYCLE_STATES) {
      if (key.startsWith(`${state}:`)) return state;
    }
  }
  return undefined;
}

/** Objects that carry sport=* but are venues/shops/clubs, not facilities. */
export function venueSkipReason(tags: OsmTags): string | undefined {
  if (tags['shop'] !== undefined) return 'shop_not_facility';
  const amenity = tags['amenity'];
  if (amenity !== undefined && VENUE_AMENITIES.has(amenity)) return 'venue_not_facility';
  if (tags['tourism'] !== undefined) return 'tourism_not_facility';
  if (tags['club'] !== undefined) return 'club_not_facility';
  if (tags['type'] === 'route') return 'route_relation';
  return undefined;
}
