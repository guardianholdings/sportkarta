/**
 * Tag → schema normalization tables, operator-approved (hard stop a).
 * Every change here re-triggers the dry-run review gate before a live import.
 */

export type OsmTags = Record<string, string>;

export type Access = 'free' | 'paid' | 'restricted' | 'school';

/** leisure values extracted unconditionally. */
export const QUALIFYING_LEISURE = new Set(['pitch', 'fitness_station', 'sports_centre', 'track']);

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
 * leisure=fitness_station implies fitness when no sport tag maps.
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
  if (sports.size === 0 && leisure === 'fitness_station') {
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
 * First matching rule wins. OSM has no reliable school tag — `school`
 * classification comes from crowd verification and municipal data (Stage 6).
 */
export function mapAccess(tags: OsmTags): Access {
  const access = tags['access']?.toLowerCase();
  if (access === 'private' || access === 'no' || access === 'military') return 'restricted';
  if (tags['fee']?.toLowerCase() === 'yes') return 'paid';
  if (access === 'customers') return 'paid';
  if (tags['fee']?.toLowerCase() === 'no') return 'free';
  if (tags['leisure'] === 'sports_centre') return 'paid';
  return 'free';
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
