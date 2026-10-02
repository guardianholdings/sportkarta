import { getDb, publicFacilityVisible, sql, type SQL } from '@sportkarta/db';

import type { PublicFilters } from '@/lib/filters';

/**
 * Read-side queries for the PUBLIC map + facility pages. Server-only.
 *
 * Visibility: every query here — the map feed, the SSR list AND the single
 * facility page — asks `publicFacilityVisible` (see publicConditions below):
 * not `gone`, has a slug, and a paid venue only while the master switch and its
 * business allow it. The bulk of the dataset is OSM-imported and still
 * `needs_verification` — that is a data-quality signal shown per-facility
 * ("awaiting verification"), not a reason to hide it from the national map.
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
  /**
   * Whether `covered` is something a source actually said. The column is NOT
   * NULL with a false default, so `covered: false` alone cannot tell "open-air"
   * from "nobody knows" — the page shows "unknown" unless this is true.
   */
  coveredKnown: boolean;
  access: string;
  status: string;
  source: string;
  quarter: string | null;
  municipalityName: string | null;
  lon: number;
  lat: number;
  /** Latest verification evidence (VERIFICATION_EVIDENCE); null = never checked. */
  lastVerifiedAt: string | null;
  /** Latest crowd-reported condition; null = nobody has reported one yet. */
  condition: string | null;
  conditionReportedAt: string | null;
  photos: string[];
}

/**
 * The facility_edits rows that mean somebody CHECKED the facility, and so may
 * date «Последна проверка» (last checked).
 *
 * Deliberately a list of what counts rather than of what does not: every other
 * actor-attributed row is a claim or a complaint, not a check. `created` is the
 * adder's own claim (verify-facility refuses to let them confirm it), and
 * `reported_missing` says the opposite of "checked, it is here". `condition` is
 * a wear report — a remote one does not even repaint the facility — and the
 * admin editor's descriptive fields (name, quarter) are desk edits. A new
 * facility_edits field stays out of this date until somebody decides it is
 * evidence.
 *
 * What does count: `verified` (a member confirmed the checklist unchanged), a
 * correction of a checklist field (the same form, with a change — it writes the
 * field instead of `verified`; the admin editor writes the same fields), and a
 * `status` change to `active` (published by an on-site confirmer or a
 * moderator). All of them only with an actor: an import is not a check.
 */
export const VERIFICATION_EVIDENCE = {
  fields: ['verified', 'access', 'surface', 'lighting', 'covered', 'sport_types'],
  publishedStatus: 'active',
} as const;

/**
 * OSM keys that state something about a roof. mapCovered (scripts/import-osm)
 * turns their absence into `covered = false`, so only their presence makes an
 * OSM row's `false` an answer.
 */
const OSM_COVERED_KEYS = ['covered', 'indoor', 'building'] as const;

/** Full detail for /obekt/[slug]; null when unknown or not public. */
export async function getFacilityBySlug(slug: string): Promise<FacilityDetail | null> {
  if (!SLUG_RE.test(slug)) return null;
  const db = getDb();
  const evidence = sql`e.actor IS NOT NULL AND (
    e.field = ANY(${textArray([...VERIFICATION_EVIDENCE.fields])})
    OR (e.field = 'status'
        AND e.new_value = to_jsonb(${VERIFICATION_EVIDENCE.publishedStatus}::text)))`;
  const result = await db.execute(sql`
    SELECT f.id, f.slug, f.name, f.sport_types, f.surface, f.lighting, f.covered,
           f.access, f.status, f.source, f.quarter, f.condition, f.condition_reported_at,
           m.name_bg AS municipality_name,
           ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat,
           (SELECT max(e.created_at) FROM facility_edits e
             WHERE e.facility_id = f.id AND ${evidence}) AS last_verified_at,
           -- covered is known when it is true, when OSM tagged a roof either way,
           -- when a non-OSM source set it (an OSM change is already in the
           -- tags), or when a person submitted the checklist — the verify form
           -- and the admin editor always present the covered box, so leaving it
           -- unticked there is an answer. A moderator publishing a pin is not:
           -- the queue asks no roof question.
           (f.covered
            OR COALESCE((f.attrs #> '{osm,tags}') ?| ${textArray([...OSM_COVERED_KEYS])}, false)
            OR EXISTS (SELECT 1 FROM facility_edits e
                        WHERE e.facility_id = f.id
                          AND ((e.field = 'covered' AND e.source <> 'osm')
                               OR (e.actor IS NOT NULL
                                   AND e.field = ANY(${textArray([...VERIFICATION_EVIDENCE.fields])}))))
           ) AS covered_known,
           COALESCE(
             (SELECT array_agg(p.storage_path ORDER BY p.created_at)
              FROM facility_photos p
              WHERE p.facility_id = f.id AND p.status = 'approved'),
             '{}'
           ) AS photos
    FROM facilities f
    LEFT JOIN municipalities m ON m.id = f.municipality_id
    WHERE f.slug = ${slug} AND ${publicFacilityVisible}
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
    coveredKnown: Boolean(row.covered_known),
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
    photos: (row.photos as string[] | null) ?? [],
  };
}
