import {
  mapAccess,
  mapCovered,
  mapLighting,
  mapSports,
  mapSurface,
  QUALIFYING_LEISURE,
  venueSkipReason,
  type Access,
  type OsmTags,
} from './mapping.js';

/** Matches the facilities_geom_in_bulgaria CHECK constraint (migration 0001). */
export const BULGARIA_BBOX = { minLon: 22.0, maxLon: 29.0, minLat: 41.0, maxLat: 44.5 };

export type OsmType = 'node' | 'way' | 'relation';

export interface OsmFeature {
  type: 'Feature';
  id?: string | number;
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, string> | null;
}

export interface FacilityCandidate {
  osmType: OsmType;
  osmId: number;
  name: string | null;
  sportTypes: string[];
  surface: string | null;
  lighting: boolean | null;
  covered: boolean;
  access: Access;
  /** Raw GeoJSON geometry (string) — centroid is computed in PostGIS. */
  geometryJson: string;
  geometryKind: string;
  tags: OsmTags;
  /** Report metadata. */
  unmappedSports: string[];
  unmappedSurface?: string;
  unusualLit?: string;
  noSportBucket?: string;
}

export type NormalizeResult =
  | { kind: 'candidate'; candidate: FacilityCandidate }
  | { kind: 'skip'; reason: string; detail?: string };

const GEOMETRY_RANK: Record<string, number> = {
  MultiPolygon: 3,
  Polygon: 3,
  Point: 2,
  LineString: 1,
  MultiLineString: 1,
};

/**
 * osmium export emits a closed way matching both area and linear tag rules
 * TWICE: as an area ("a" id, MultiPolygon) and as its perimeter ring ("w" id,
 * LineString) — same (osm_type, osm_id) after area-id decoding. The polygon
 * carries the true centroid, so it wins; ties keep the first seen.
 */
export function preferCandidate(a: FacilityCandidate, b: FacilityCandidate): FacilityCandidate {
  const rankA = GEOMETRY_RANK[a.geometryKind] ?? 0;
  const rankB = GEOMETRY_RANK[b.geometryKind] ?? 0;
  return rankB > rankA ? b : a;
}

/**
 * Parse an osmium `-u type_id` feature id ("n123" / "w123" / "r123").
 * Areas assembled by osmium may surface as "a<n>" using the libosmium
 * convention: even n = way n/2, odd n = relation (n-1)/2.
 */
export function parseOsmRef(id: string | number | undefined): { type: OsmType; id: number } | null {
  if (id === undefined) return null;
  const s = String(id);
  const prefix = s[0];
  const rest = Number(s.slice(1));
  if (!Number.isInteger(rest) || rest <= 0) return null;
  switch (prefix) {
    case 'n':
      return { type: 'node', id: rest };
    case 'w':
      return { type: 'way', id: rest };
    case 'r':
      return { type: 'relation', id: rest };
    case 'a':
      return rest % 2 === 0
        ? { type: 'way', id: rest / 2 }
        : { type: 'relation', id: (rest - 1) / 2 };
    default:
      return null;
  }
}

/** Rough center (bbox midpoint) for the pre-insert bbox screen. */
export function roughCenter(coordinates: unknown): { lon: number; lat: number } | null {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let found = false;

  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
      const lon = value[0];
      const lat = value[1];
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      found = true;
      return;
    }
    for (const child of value) visit(child);
  };
  visit(coordinates);
  return found ? { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2 } : null;
}

export function normalizeFeature(feature: OsmFeature): NormalizeResult {
  const tags = feature.properties;
  if (!tags || Object.keys(tags).length === 0) {
    return { kind: 'skip', reason: 'invalid_feature', detail: 'no tags' };
  }

  const ref = parseOsmRef(feature.id);
  if (!ref) {
    return {
      kind: 'skip',
      reason: 'invalid_feature',
      detail: `unparseable id ${String(feature.id)}`,
    };
  }

  const leisure = tags['leisure'];
  const sportTag = tags['sport'];

  // Operator-approved spec: playground only when sport-tagged.
  if (leisure === 'playground' && sportTag === undefined) {
    return { kind: 'skip', reason: 'playground_without_sport' };
  }

  const venueReason = venueSkipReason(tags);
  if (venueReason) {
    return { kind: 'skip', reason: venueReason };
  }

  const qualifying = leisure !== undefined && QUALIFYING_LEISURE.has(leisure);
  const { sports, unmapped } = mapSports(sportTag, leisure);

  // Standalone sport=* objects must map at least one token; qualifying
  // leisure objects import regardless (report buckets the sport-less ones).
  if (!qualifying && sports.length === 0) {
    return { kind: 'skip', reason: 'unmapped_sport_only', detail: sportTag };
  }

  if (!feature.geometry) {
    return { kind: 'skip', reason: 'no_geometry' };
  }

  const center = roughCenter(feature.geometry.coordinates);
  if (!center) {
    return { kind: 'skip', reason: 'no_geometry', detail: 'empty coordinates' };
  }
  if (
    center.lon < BULGARIA_BBOX.minLon ||
    center.lon > BULGARIA_BBOX.maxLon ||
    center.lat < BULGARIA_BBOX.minLat ||
    center.lat > BULGARIA_BBOX.maxLat
  ) {
    return { kind: 'skip', reason: 'outside_bbox' };
  }

  const surfaceMapping = mapSurface(tags['surface']);
  const lightingMapping = mapLighting(tags['lit']);

  let noSportBucket: string | undefined;
  if (sports.length === 0 && leisure !== undefined) {
    noSportBucket = `${leisure}_no_sport`;
  }

  return {
    kind: 'candidate',
    candidate: {
      osmType: ref.type,
      osmId: ref.id,
      name: tags['name:bg'] ?? tags['name'] ?? null,
      sportTypes: sports,
      surface: surfaceMapping.surface,
      lighting: lightingMapping.lighting,
      covered: mapCovered(tags),
      access: mapAccess(tags),
      geometryJson: JSON.stringify(feature.geometry),
      geometryKind: feature.geometry.type,
      tags,
      unmappedSports: unmapped,
      ...(surfaceMapping.unmapped !== undefined && { unmappedSurface: surfaceMapping.unmapped }),
      ...(lightingMapping.unusual !== undefined && { unusualLit: lightingMapping.unusual }),
      ...(noSportBucket !== undefined && { noSportBucket }),
    },
  };
}
