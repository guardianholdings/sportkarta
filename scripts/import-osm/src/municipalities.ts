import { readFile } from 'node:fs/promises';
import type pg from 'pg';

import { readFeatures } from './extract.js';
import { parseOsmRef, roughCenter, type OsmFeature } from './normalize.js';

export interface RegisterRow {
  ekatteCode: string;
  nameBg: string;
  nameEn: string;
}

export interface BoundaryFeature {
  relationId: number;
  name: string;
  geometryJson: string;
  center: { lon: number; lat: number } | null;
}

export interface BoundaryMatch {
  boundary: BoundaryFeature;
  register: RegisterRow;
}

export interface UnmatchedBoundary {
  boundary: BoundaryFeature;
  reason: 'no_match' | 'ambiguous_name' | 'duplicate_code';
  /** Register candidates for ambiguous names — evidence for the operator. */
  candidates?: string[];
}

export interface MunicipalityMatchResult {
  matched: BoundaryMatch[];
  unmatched: UnmatchedBoundary[];
  /** Register municipalities with no OSM boundary this run. */
  missingFromOsm: RegisterRow[];
}

const DEFAULT_DATA_DIR = new URL('../data', import.meta.url).pathname;

/** Simple 3-column CSV without quoting — names contain no commas (asserted). */
function parseCsv(content: string, expectedHeader: string): string[][] {
  const lines = content.trim().split('\n');
  const header = lines[0]?.trim();
  if (header !== expectedHeader) {
    throw new Error(`unexpected CSV header "${String(header)}" (want "${expectedHeader}")`);
  }
  return lines.slice(1).map((line, i) => {
    const cols = line.split(',').map((c) => c.trim());
    if (cols.some((c) => !c)) throw new Error(`blank CSV field at data row ${String(i + 1)}`);
    return cols;
  });
}

/** The checked-in NSI EKATTE register extract (see data/README.md). */
export async function loadRegister(dataDir = DEFAULT_DATA_DIR): Promise<RegisterRow[]> {
  const content = await readFile(`${dataDir}/ekatte-municipalities.csv`, 'utf8');
  const rows = parseCsv(content, 'ekatte_code,name_bg,name_en').map(
    ([ekatteCode, nameBg, nameEn]) => ({
      ekatteCode: ekatteCode ?? '',
      nameBg: nameBg ?? '',
      nameEn: nameEn ?? '',
    }),
  );
  if (rows.length !== 265) {
    throw new Error(`register CSV has ${String(rows.length)} rows, expected 265`);
  }
  return rows;
}

/** Operator-decided relation-id → ekatte_code mappings (never automatic). */
export async function loadOverrides(dataDir = DEFAULT_DATA_DIR): Promise<Map<number, string>> {
  const content = await readFile(`${dataDir}/municipality-name-overrides.csv`, 'utf8');
  const lines = content.trim().split('\n');
  if (lines[0]?.trim() !== 'osm_relation_id,ekatte_code') {
    throw new Error('municipality-name-overrides.csv: unexpected header');
  }
  const map = new Map<number, string>();
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const [id, code] = line.split(',').map((c) => c.trim());
    if (!id || !code) throw new Error(`overrides: malformed line "${line}"`);
    map.set(Number(id), code);
  }
  return map;
}

/**
 * Conservative normalization for exact matching only: casefold, unify
 * dashes to spaces, drop the word „община“. No fuzzy matching — anything
 * still ambiguous or unmatched is flagged for the operator.
 */
export function normalizeMunicipalityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[-–—]/g, ' ')
    .split(/\s+/)
    .filter((w) => w && w !== 'община')
    .join(' ');
}

/** Parse the boundary export into candidate municipality polygons. */
export async function readBoundaries(featuresPath: string): Promise<BoundaryFeature[]> {
  const out: BoundaryFeature[] = [];
  for await (const feature of readFeatures(featuresPath)) {
    const tags = feature.properties ?? {};
    if (tags['boundary'] !== 'administrative' || tags['admin_level'] !== '5') continue;
    const geometry = (feature as OsmFeature).geometry;
    if (!geometry || (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon')) continue;
    const ref = parseOsmRef(feature.id);
    if (!ref || ref.type !== 'relation') continue;
    const name = tags['name'];
    if (!name) continue;
    out.push({
      relationId: ref.id,
      name,
      geometryJson: JSON.stringify(geometry),
      center: roughCenter(geometry.coordinates),
    });
  }
  return out;
}

export function matchBoundaries(
  boundaries: BoundaryFeature[],
  register: RegisterRow[],
  overrides: Map<number, string>,
): MunicipalityMatchResult {
  const byCode = new Map(register.map((r) => [r.ekatteCode, r]));
  const byName = new Map<string, RegisterRow[]>();
  for (const row of register) {
    const key = normalizeMunicipalityName(row.nameBg);
    byName.set(key, [...(byName.get(key) ?? []), row]);
  }

  const matched: BoundaryMatch[] = [];
  const unmatched: UnmatchedBoundary[] = [];
  const usedCodes = new Set<string>();

  for (const boundary of boundaries) {
    const overrideCode = overrides.get(boundary.relationId);
    let target: RegisterRow | undefined;
    if (overrideCode !== undefined) {
      target = byCode.get(overrideCode);
      if (!target) {
        throw new Error(
          `override maps relation ${String(boundary.relationId)} to unknown code ${overrideCode}`,
        );
      }
    } else {
      const candidates = byName.get(normalizeMunicipalityName(boundary.name)) ?? [];
      if (candidates.length === 1) {
        target = candidates[0];
      } else if (candidates.length > 1) {
        unmatched.push({
          boundary,
          reason: 'ambiguous_name',
          candidates: candidates.map((c) => `${c.ekatteCode} (${c.nameBg})`),
        });
        continue;
      } else {
        unmatched.push({ boundary, reason: 'no_match' });
        continue;
      }
    }
    if (!target) continue;
    if (usedCodes.has(target.ekatteCode)) {
      unmatched.push({ boundary, reason: 'duplicate_code', candidates: [target.ekatteCode] });
      continue;
    }
    usedCodes.add(target.ekatteCode);
    matched.push({ boundary, register: target });
  }

  const missingFromOsm = register.filter((r) => !usedCodes.has(r.ekatteCode));
  return { matched, unmatched, missingFromOsm };
}

export interface MunicipalityCounts {
  matched: number;
  inserted: number;
  updated: number;
  unchanged: number;
}

/**
 * Idempotent upsert keyed ekatte_code. Geometry is hardened to a valid
 * MultiPolygon (schema CHECK ST_IsValid); updates happen only on real change.
 */
export async function importMunicipalities(
  client: pg.ClientBase,
  matches: BoundaryMatch[],
): Promise<MunicipalityCounts> {
  const counts: MunicipalityCounts = {
    matched: matches.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
  };
  for (const { boundary, register } of matches) {
    const result = await client.query<{ inserted: boolean }>(
      `
      INSERT INTO municipalities (ekatte_code, name_bg, name_en, geom)
      VALUES ($1, $2, $3,
        ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)), 3)))
      ON CONFLICT (ekatte_code) DO UPDATE
        SET name_bg = EXCLUDED.name_bg, name_en = EXCLUDED.name_en, geom = EXCLUDED.geom
        WHERE municipalities.name_bg IS DISTINCT FROM EXCLUDED.name_bg
           OR municipalities.name_en IS DISTINCT FROM EXCLUDED.name_en
           OR NOT ST_Equals(municipalities.geom, EXCLUDED.geom)
      RETURNING (xmax = 0) AS inserted
      `,
      [register.ekatteCode, register.nameBg, register.nameEn, boundary.geometryJson],
    );
    if (result.rowCount === 0) counts.unchanged += 1;
    else if (result.rows[0]?.inserted) counts.inserted += 1;
    else counts.updated += 1;
  }
  return counts;
}

/**
 * A facility a few metres past the edge of every municipality polygon still
 * belongs to the nearest one. Coastline and Danube boundaries are drawn at a
 * precision where a beach court or a riverside pitch can land just outside —
 * one production row sat 5 m off the coast and was counted nationally but in
 * no municipality (audit finding 87). Ten metres snaps that without reaching
 * across a real border: the other out-of-polygon rows were 171–625 m out.
 */
export const MUNICIPALITY_SNAP_M = 10;

/**
 * Index pre-filter in degrees for the snap: wider than MUNICIPALITY_SNAP_M on
 * both axes anywhere in Bulgaria (10 m is ≈0.000126° of longitude at 44.5°N),
 * so the exact geography test below it never misses a match.
 */
const SNAP_PREFILTER_DEG = 0.0002;

/**
 * THE municipality of a point, as one SQL expression: the polygon containing
 * it, else the nearest within MUNICIPALITY_SNAP_M. Every derivation in the
 * importer (insert, moved geometry, the full re-assignment) and the audit's
 * expectation use this one definition, so they can never disagree with each
 * other. `point` must be a side-effect-free geometry(Point,4326) expression;
 * it is repeated.
 */
export function municipalityOfSql(point: string): string {
  return `COALESCE(
    (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, ${point}) LIMIT 1),
    (SELECT m.id FROM municipalities m
      WHERE ST_DWithin(m.geom, ${point}, ${String(SNAP_PREFILTER_DEG)})
        AND ST_DWithin(m.geom::geography, (${point})::geography, ${String(MUNICIPALITY_SNAP_M)})
      ORDER BY ST_Distance(m.geom::geography, (${point})::geography), m.id
      LIMIT 1)
  )`;
}

/**
 * Does the database hold a boundary for every municipality in the register?
 * Only then is "outside every municipality" evidence of being outside
 * Bulgaria; with a boundary missing it would also describe every facility in
 * the hole it leaves, so callers must not act on it.
 */
export async function municipalityLayerComplete(
  client: pg.ClientBase,
  register: RegisterRow[],
): Promise<boolean> {
  const result = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM municipalities WHERE ekatte_code = ANY($1::text[])`,
    [register.map((r) => r.ekatteCode)],
  );
  return Number(result.rows[0]?.n ?? 0) === register.length;
}

export interface OutOfPolygonFacility {
  /** `osm_type:osm_id`, or null for a crowd/municipal row. */
  ref: string | null;
  slug: string | null;
  name: string | null;
  lon: number;
  lat: number;
}

export interface AssignmentResult {
  changed: number;
  /** Rows not `gone` that no municipality claims, even with the snap. */
  outOfPolygon: number;
  /** Up to OUT_OF_POLYGON_LISTED rows, for the operator to check one by one. */
  outSamples: OutOfPolygonFacility[];
}

const OUT_OF_POLYGON_LISTED = 25;

/**
 * municipality_id is a DERIVED cache (geom × boundaries), recomputable at
 * will — direct update, no facility_edits rows, outside the merge policy
 * (operator-approved design). ST_Contains rides the municipalities GIST index;
 * the snap subquery only runs for the handful of rows it does not place.
 */
export async function assignMunicipalities(client: pg.ClientBase): Promise<AssignmentResult> {
  const result = await client.query<{ changed: string; out_of_polygon: string }>(`
    WITH derived AS (
      SELECT f.id AS fid, f.status, ${municipalityOfSql('f.geom')} AS mid
      FROM facilities f
    ),
    changed AS (
      UPDATE facilities f SET municipality_id = d.mid
      FROM derived d
      WHERE f.id = d.fid AND f.municipality_id IS DISTINCT FROM d.mid
      RETURNING f.id
    )
    SELECT (SELECT count(*) FROM changed) AS changed,
           (SELECT count(*) FROM derived WHERE mid IS NULL AND status <> 'gone') AS out_of_polygon
  `);
  // Every row the public map shows but no municipality claims — listed, not
  // acted on: whether a pin 400 m over the border is Romanian or a mis-drawn
  // Bulgarian one is for a human (status stays whatever it is).
  const samples = await client.query<{
    osm_type: string | null;
    osm_id: string | null;
    slug: string | null;
    name: string | null;
    lon: number;
    lat: number;
  }>(
    `
    SELECT osm_type, osm_id, slug, name, ST_X(geom) AS lon, ST_Y(geom) AS lat
    FROM facilities WHERE municipality_id IS NULL AND status <> 'gone'
    ORDER BY id LIMIT $1
    `,
    [OUT_OF_POLYGON_LISTED],
  );
  return {
    changed: Number(result.rows[0]?.changed ?? 0),
    outOfPolygon: Number(result.rows[0]?.out_of_polygon ?? 0),
    outSamples: samples.rows.map((r) => ({
      ref: r.osm_type && r.osm_id ? `${r.osm_type}:${r.osm_id}` : null,
      slug: r.slug,
      name: r.name,
      lon: Number(r.lon),
      lat: Number(r.lat),
    })),
  };
}
