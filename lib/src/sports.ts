/**
 * Canonical sport and surface slugs — the single vocabulary shared by the
 * OSM import mapping (scripts/import-osm asserts its outputs are a subset)
 * and the admin edit forms (which only accept these values). UI labels come
 * from i18n, never from these slugs directly.
 */

export const CANONICAL_SPORTS = [
  'archery',
  'athletics',
  'badminton',
  'basketball',
  'beach_volleyball',
  'bmx',
  'calisthenics',
  'chess',
  'climbing',
  'cycling',
  'equestrian',
  'fitness',
  'football',
  'gymnastics',
  'handball',
  'hockey',
  'ice_skating',
  'martial_arts',
  'multi',
  'petanque',
  'running',
  'shooting',
  'skateboard',
  'squash',
  'swimming',
  'table_tennis',
  'tennis',
  'volleyball',
] as const;

export const CANONICAL_SURFACES = [
  'acrylic',
  'artificial_turf',
  'asphalt',
  'clay',
  'concrete',
  'grass',
  'ice',
  'paved',
  'rubber',
  'sand',
  'tartan',
  'unpaved',
  'wood',
] as const;

export type CanonicalSport = (typeof CANONICAL_SPORTS)[number];
export type CanonicalSurface = (typeof CANONICAL_SURFACES)[number];
