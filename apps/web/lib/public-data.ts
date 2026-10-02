import { getDb, publicFacilityVisible, sql, type SQL } from '@sportkarta/db';
import { cityDisplayName } from '@sportkarta/lib/cities';

import type { PublicFilters } from '@/lib/filters';
import { placeLabel } from '@/lib/geo';
import { PHOTO_PUBLIC } from '@/lib/photos';

/**
 * Read-side queries for the PUBLIC map + facility pages. Server-only.
 *
 * Visibility: every facility that is not `gone` and has a slug is public. The
 * bulk of the dataset is OSM-imported and still `needs_verification` — that is
 * a data-quality signal shown per-facility ("last verified"), not a reason to
 * hide it from the national map. Only human-confirmed `gone` rows drop out.
 *
 * Filter parsing/serialization lives in lib/filters.ts (client-safe); its
 * values are already allowlisted, so they are safe to interpolate here.
 */

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// drizzle's sql`` spreads a JS array into separate bound params, so build an
// explicit ARRAY[...] constructor (each element a scalar param) to pass a
// single Postgres text[]. Values are already allowlisted in parsePublicFilters.
function textArray(values: string[]): SQL {
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::text[]`;
}

/**
 * Every public facility query starts from `publicFacilityVisible` (Stage 6.1),
 * which is compiled from the single predicate string the open-data catalogue
 * declares and the PII test reads.
 *
 * Before Stage 6 this was two literals here, which was fine while the map was
 * the only reader. It stopped being fine when the same corpus started leaving
 * as a nightly file anyone can download: two copies of "which facilities are
 * public" would agree on the day they were written and diverge the first time
 * one was edited, and a facility withdrawn from the map that stayed in the CSV
 * is not a rendering bug — it is publishing something we decided not to.
 */
function publicConditions(f: PublicFilters): SQL {
  const conditions: SQL[] = [publicFacilityVisible];
  if (f.sports.length) conditions.push(sql`f.sport_types && ${textArray(f.sports)}`);
  if (f.access.length) conditions.push(sql`f.access::text = ANY(${textArray(f.access)})`);
  if (f.onlyLit) conditions.push(sql`f.lighting IS TRUE`);
  if (f.surfaces.length) conditions.push(sql`f.surface = ANY(${textArray(f.surfaces)})`);
  return sql.join(conditions, sql` AND `);
}

export interface PublicFacility {
  slug: string;
  name: string | null;
  sportTypes: string[];
  lon: number;
  lat: number;
  /** "Лозенец, София" — see `placeLabel`. Null when neither part is known. */
  place: string | null;
}

/**
 * Where a facility is, in the reader's locale, from the quarter and the
 * municipality columns the two map queries below select. It is what the map
 * labels an unnamed facility by (components/map/facility-label.ts), and 91% of
 * the corpus is unnamed. The municipality goes through `cityDisplayName`, so
 * «Столична» reads «София» here exactly as it does on the place pages.
 */
const PLACE_COLUMNS = sql`f.quarter, m.name_bg AS municipality_bg, m.name_en AS municipality_en`;
const PLACE_JOIN = sql`LEFT JOIN municipalities m ON m.id = f.municipality_id`;

function rowPlace(row: Record<string, unknown>, locale: string): string | null {
  const bg = row.municipality_bg as string | null;
  const municipality = bg
    ? cityDisplayName(bg, (row.municipality_en as string | null) ?? bg, locale)
    : null;
  return placeLabel(row.quarter as string | null, municipality);
}

// Safety cap: comfortably above the ~6.6k national dataset, bounds the payload
// if the corpus grows before viewport-scoped tiling lands.
const GEOJSON_LIMIT = 12000;

export interface FacilityFeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    /** `place` is OMITTED rather than null when unknown — ~6k features ride this feed. */
    properties: { slug: string; name: string | null; sports: string[]; place?: string };
  }[];
}

/** GeoJSON for the map source (clustered client-side). Minimal properties. */
export async function facilitiesGeoJSON(
  f: PublicFilters,
  locale = 'bg',
): Promise<FacilityFeatureCollection> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT f.slug, f.name, f.sport_types, ${PLACE_COLUMNS},
           ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat
    FROM facilities f
    ${PLACE_JOIN}
    WHERE ${publicConditions(f)}
    ORDER BY f.id
    LIMIT ${GEOJSON_LIMIT}
  `);
  return {
    type: 'FeatureCollection',
    features: result.rows.map((r) => {
      const row = r as Record<string, unknown>;
      const place = rowPlace(row, locale);
      return {
        type: 'Feature' as const,
        geometry: {
          type: 'Point' as const,
          coordinates: [Number(row.lon), Number(row.lat)] as [number, number],
        },
        properties: {
          slug: String(row.slug),
          name: (row.name as string | null) ?? null,
          sports: (row.sport_types as string[] | null) ?? [],
          ...(place ? { place } : {}),
        },
      };
    }),
  };
}

/**
 * A bounded, deterministic slice for the SSR list (SEO / no-JS / first paint).
 * The client list supersedes this with the full set + distance sorting.
 */
export async function listPublicFacilities(
  f: PublicFilters,
  limit = 100,
  locale = 'bg',
): Promise<PublicFacility[]> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT f.slug, f.name, f.sport_types, ${PLACE_COLUMNS},
           ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat
    FROM facilities f
    ${PLACE_JOIN}
    WHERE ${publicConditions(f)}
    ORDER BY f.name NULLS LAST, f.id
    LIMIT ${limit}
  `);
  return result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      slug: String(row.slug),
      name: (row.name as string | null) ?? null,
      sportTypes: (row.sport_types as string[] | null) ?? [],
      lon: Number(row.lon),
      lat: Number(row.lat),
      place: rowPlace(row, locale),
    };
  });
}

export interface FacilityDetail {
  id: string;
  slug: string;
  name: string | null;
  sportTypes: string[];
  surface: string | null;
  lighting: boolean | null;
  covered: boolean;
  access: string;
  status: string;
  source: string;
  quarter: string | null;
  municipalityName: string | null;
  lon: number;
  lat: number;
  /** Latest human (actor-attributed) audit entry; null = never verified. */
  lastVerifiedAt: string | null;
  /** Latest crowd-reported condition; null = nobody has reported one yet. */
  condition: string | null;
  conditionReportedAt: string | null;
  /**
   * Public photo IDS, oldest first — never storage keys. Pages render them
   * through lib/photo-url.ts, i.e. the route that re-checks PHOTO_PUBLIC.
   */
  photoIds: string[];
}

/** Full detail for /obekt/[slug]; null when unknown or not public. */
export async function getFacilityBySlug(slug: string): Promise<FacilityDetail | null> {
  if (!SLUG_RE.test(slug)) return null;
  const db = getDb();
  const result = await db.execute(sql`
    SELECT f.id, f.slug, f.name, f.sport_types, f.surface, f.lighting, f.covered,
           f.access, f.status, f.source, f.quarter, f.condition, f.condition_reported_at,
           m.name_bg AS municipality_name,
           ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat,
           (SELECT max(e.created_at) FROM facility_edits e
             WHERE e.facility_id = f.id AND e.actor IS NOT NULL) AS last_verified_at,
           COALESCE(
             (SELECT array_agg(p.id::text ORDER BY p.created_at)
              FROM facility_photos p
              WHERE p.facility_id = f.id AND ${PHOTO_PUBLIC}),
             '{}'
           ) AS photo_ids
    FROM facilities f
    LEFT JOIN municipalities m ON m.id = f.municipality_id
    WHERE f.slug = ${slug} AND f.status <> 'gone'
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    slug: String(row.slug),
    name: (row.name as string | null) ?? null,
    sportTypes: (row.sport_types as string[] | null) ?? [],
    surface: (row.surface as string | null) ?? null,
    lighting: (row.lighting as boolean | null) ?? null,
    covered: Boolean(row.covered),
    access: String(row.access),
    status: String(row.status),
    source: String(row.source),
    quarter: (row.quarter as string | null) ?? null,
    municipalityName: (row.municipality_name as string | null) ?? null,
    lon: Number(row.lon),
    lat: Number(row.lat),
    lastVerifiedAt: row.last_verified_at ? String(row.last_verified_at) : null,
    condition: (row.condition as string | null) ?? null,
    conditionReportedAt: row.condition_reported_at ? String(row.condition_reported_at) : null,
    photoIds: (row.photo_ids as string[] | null) ?? [],
  };
}
