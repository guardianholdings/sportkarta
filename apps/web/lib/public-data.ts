import { getDb } from '@sportkarta/db';
import { sql, type SQL } from 'drizzle-orm';

import type { PublicFilters } from '@/lib/filters';

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

function publicConditions(f: PublicFilters): SQL {
  const conditions: SQL[] = [sql`f.status <> 'gone'`, sql`f.slug IS NOT NULL`];
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
}

// Safety cap: comfortably above the ~6.6k national dataset, bounds the payload
// if the corpus grows before viewport-scoped tiling lands.
const GEOJSON_LIMIT = 12000;

export interface FacilityFeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: { slug: string; name: string | null; sports: string[] };
  }[];
}

/** GeoJSON for the map source (clustered client-side). Minimal properties. */
export async function facilitiesGeoJSON(f: PublicFilters): Promise<FacilityFeatureCollection> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT f.slug, f.name, f.sport_types, ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat
    FROM facilities f
    WHERE ${publicConditions(f)}
    ORDER BY f.id
    LIMIT ${GEOJSON_LIMIT}
  `);
  return {
    type: 'FeatureCollection',
    features: result.rows.map((r) => {
      const row = r as Record<string, unknown>;
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
): Promise<PublicFacility[]> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT f.slug, f.name, f.sport_types, ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat
    FROM facilities f
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
  photos: string[];
}

/** Full detail for /obekt/[slug]; null when unknown or not public. */
export async function getFacilityBySlug(slug: string): Promise<FacilityDetail | null> {
  if (!SLUG_RE.test(slug)) return null;
  const db = getDb();
  const result = await db.execute(sql`
    SELECT f.id, f.slug, f.name, f.sport_types, f.surface, f.lighting, f.covered,
           f.access, f.status, f.source, f.quarter,
           m.name_bg AS municipality_name,
           ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat,
           (SELECT max(e.created_at) FROM facility_edits e
             WHERE e.facility_id = f.id AND e.actor IS NOT NULL) AS last_verified_at,
           COALESCE(
             (SELECT array_agg(p.storage_path ORDER BY p.created_at)
              FROM facility_photos p
              WHERE p.facility_id = f.id AND p.status = 'approved'),
             '{}'
           ) AS photos
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
    photos: (row.photos as string[] | null) ?? [],
  };
}
