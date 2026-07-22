import { mergeFields, type EditSource, type JsonValue } from '@sportkarta/lib';
import type pg from 'pg';

import type { FacilityCandidate } from './normalize.js';

/** Fields the import manages through the merge policy. */
const MANAGED_FIELDS = [
  'name',
  'sport_types',
  'surface',
  'lighting',
  'covered',
  'access',
  'geom',
  'attrs',
] as const;

export interface ImportCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  /** field → count of merge-policy freezes (crowd/municipal protected). */
  frozenFields: Record<string, number>;
  /** facilities in DB with osm refs that are absent from this extract. */
  missingFromExtract: number;
  constraintSkips: number;
}

interface ExistingFacility {
  id: string;
  key: string;
  current: Record<string, JsonValue>;
}

function centroidValue(lon: number, lat: number): JsonValue {
  // 7 decimal places ≈ 1 cm — beyond OSM precision, stable across runs.
  return { lon: Number(lon.toFixed(7)), lat: Number(lat.toFixed(7)) };
}

function candidateAttrs(candidate: FacilityCandidate): JsonValue {
  return {
    osm: {
      tags: candidate.tags,
      geometry: candidate.osmType,
      geometry_kind: candidate.geometryKind,
    },
  };
}

function candidateFields(
  candidate: FacilityCandidate,
  centroid: { lon: number; lat: number },
): Record<string, JsonValue> {
  return {
    name: candidate.name,
    sport_types: candidate.sportTypes,
    surface: candidate.surface,
    lighting: candidate.lighting,
    covered: candidate.covered,
    access: candidate.access,
    geom: centroidValue(centroid.lon, centroid.lat),
    attrs: candidateAttrs(candidate),
  };
}

/** Batch-compute candidate centroids in PostGIS (single round trip per chunk). */
async function computeCentroids(
  client: pg.ClientBase,
  candidates: FacilityCandidate[],
): Promise<{ lon: number; lat: number }[]> {
  const out: { lon: number; lat: number }[] = [];
  const CHUNK = 500;
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const result = await client.query<{ lon: number; lat: number }>(
      `
      SELECT ST_X(c) AS lon, ST_Y(c) AS lat
      FROM unnest($1::text[]) WITH ORDINALITY AS g(json, ord),
           LATERAL (SELECT ST_Centroid(ST_SetSRID(ST_GeomFromGeoJSON(g.json), 4326))) AS t(c)
      ORDER BY g.ord
      `,
      [chunk.map((c) => c.geometryJson)],
    );
    for (const row of result.rows) out.push({ lon: Number(row.lon), lat: Number(row.lat) });
  }
  return out;
}

async function loadExisting(client: pg.ClientBase): Promise<Map<string, ExistingFacility>> {
  const result = await client.query<{
    id: string;
    osm_type: string;
    osm_id: string;
    name: string | null;
    sport_types: string[];
    surface: string | null;
    lighting: boolean | null;
    covered: boolean;
    access: string;
    attrs: JsonValue;
    lon: number;
    lat: number;
  }>(`
    SELECT id, osm_type, osm_id, name, sport_types, surface, lighting, covered,
           access, attrs, ST_X(geom) AS lon, ST_Y(geom) AS lat
    FROM facilities
    WHERE osm_type IS NOT NULL
  `);

  const map = new Map<string, ExistingFacility>();
  for (const row of result.rows) {
    const key = `${row.osm_type}:${row.osm_id}`;
    map.set(key, {
      id: row.id,
      key,
      current: {
        name: row.name,
        sport_types: row.sport_types,
        surface: row.surface,
        lighting: row.lighting,
        covered: row.covered,
        access: row.access,
        geom: centroidValue(Number(row.lon), Number(row.lat)),
        attrs: row.attrs,
      },
    });
  }
  return map;
}

/** Last audited edit source per (facility, field) — the merge-policy input. */
async function loadLastEditSources(
  client: pg.ClientBase,
  facilityIds: string[],
): Promise<Map<string, Record<string, EditSource>>> {
  const map = new Map<string, Record<string, EditSource>>();
  if (facilityIds.length === 0) return map;
  const result = await client.query<{ facility_id: string; field: string; source: EditSource }>(
    `
    SELECT DISTINCT ON (facility_id, field) facility_id, field, source
    FROM facility_edits
    WHERE facility_id = ANY($1::uuid[]) AND field = ANY($2::text[])
    ORDER BY facility_id, field, created_at DESC, id DESC
    `,
    [facilityIds, [...MANAGED_FIELDS]],
  );
  for (const row of result.rows) {
    const entry = map.get(row.facility_id) ?? {};
    entry[row.field] = row.source;
    map.set(row.facility_id, entry);
  }
  return map;
}

/**
 * Upsert all candidates inside the caller's transaction. Keyed
 * (osm_type, osm_id); source=osm; new rows land as needs_verification.
 * Every applied field change writes one facility_edits audit row; fields
 * last edited by crowd/municipal are frozen (merge policy, lib).
 */
export async function importCandidates(
  client: pg.ClientBase,
  candidates: FacilityCandidate[],
): Promise<ImportCounts> {
  const counts: ImportCounts = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    frozenFields: {},
    missingFromExtract: 0,
    constraintSkips: 0,
  };

  const centroids = await computeCentroids(client, candidates);
  const existing = await loadExisting(client);
  const existingIds = [...existing.values()].map((f) => f.id);
  const lastEdits = await loadLastEditSources(client, existingIds);

  const seenKeys = new Set<string>();

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const centroid = centroids[i];
    if (!candidate || !centroid) continue;
    const key = `${candidate.osmType}:${String(candidate.osmId)}`;
    if (seenKeys.has(key)) continue; // extract duplicates (should not happen)
    seenKeys.add(key);

    const fields = candidateFields(candidate, centroid);
    const found = existing.get(key);

    if (!found) {
      await client.query('SAVEPOINT import_row');
      try {
        const inserted = await client.query<{ id: string }>(
          `
          INSERT INTO facilities
            (geom, name, sport_types, surface, lighting, covered, access, status,
             municipality_id, source, osm_type, osm_id, attrs)
          VALUES
            (ST_SetSRID(ST_MakePoint($1, $2), 4326), $3, $4::text[], $5, $6, $7, $8,
             'needs_verification',
             (SELECT m.id FROM municipalities m
               WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) LIMIT 1),
             'osm', $9, $10, $11::jsonb)
          RETURNING id
          `,
          [
            centroid.lon,
            centroid.lat,
            candidate.name,
            candidate.sportTypes,
            candidate.surface,
            candidate.lighting,
            candidate.covered,
            candidate.access,
            candidate.osmType,
            candidate.osmId,
            JSON.stringify(candidateAttrs(candidate)),
          ],
        );
        const newId = inserted.rows[0]?.id;
        if (newId) {
          await client.query(
            `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
             VALUES ($1, NULL, 'osm', 'created', NULL, $2::jsonb)`,
            [newId, JSON.stringify(fields)],
          );
        }
        await client.query('RELEASE SAVEPOINT import_row');
        counts.inserted += 1;
      } catch (error) {
        // Border noise can slip past the rough bbox screen and hit the
        // facilities_geom_in_bulgaria CHECK — count it, keep importing.
        await client.query('ROLLBACK TO SAVEPOINT import_row');
        counts.constraintSkips += 1;
        if (!/facilities_geom_in_bulgaria/.test(String(error))) throw error;
      }
      continue;
    }

    const merge = mergeFields({
      incomingSource: 'osm',
      current: found.current,
      incoming: fields,
      lastEditSources: lastEdits.get(found.id) ?? {},
    });

    for (const field of merge.frozen) {
      counts.frozenFields[field] = (counts.frozenFields[field] ?? 0) + 1;
    }

    if (merge.applied.length === 0) {
      counts.unchanged += 1;
      continue;
    }

    const sets: string[] = [];
    const params: unknown[] = [found.id];
    for (const change of merge.applied) {
      if (change.field === 'geom') {
        const geo = change.newValue as { lon: number; lat: number };
        params.push(geo.lon, geo.lat);
        sets.push(
          `geom = ST_SetSRID(ST_MakePoint($${String(params.length - 1)}, $${String(params.length)}), 4326)`,
        );
        sets.push(`municipality_id = (SELECT m.id FROM municipalities m
          WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint($${String(params.length - 1)}, $${String(params.length)}), 4326)) LIMIT 1)`);
      } else if (change.field === 'sport_types') {
        params.push(change.newValue);
        sets.push(`sport_types = $${String(params.length)}::text[]`);
      } else if (change.field === 'attrs') {
        params.push(JSON.stringify(change.newValue));
        sets.push(`attrs = $${String(params.length)}::jsonb`);
      } else {
        params.push(change.newValue);
        sets.push(`${change.field} = $${String(params.length)}`);
      }
    }
    await client.query(`UPDATE facilities SET ${sets.join(', ')} WHERE id = $1`, params);

    for (const change of merge.applied) {
      await client.query(
        `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
         VALUES ($1, NULL, 'osm', $2, $3::jsonb, $4::jsonb)`,
        [found.id, change.field, JSON.stringify(change.oldValue), JSON.stringify(change.newValue)],
      );
    }
    counts.updated += 1;
  }

  for (const key of existing.keys()) {
    if (!seenKeys.has(key)) counts.missingFromExtract += 1;
  }

  return counts;
}

export interface DistributionRow {
  label: string;
  count: number;
}

/** Post-merge distributions (inside the tx, so dry-run sees would-be state). */
export async function queryDistributions(client: pg.ClientBase): Promise<{
  bySport: DistributionRow[];
  byMunicipality: DistributionRow[];
  totalOsm: number;
}> {
  const bySport = await client.query<{ label: string; count: string }>(`
    SELECT COALESCE(s.sport, '(без спорт)') AS label, count(*) AS count
    FROM facilities f
    LEFT JOIN LATERAL unnest(f.sport_types) AS s(sport) ON true
    WHERE f.source = 'osm'
    GROUP BY 1 ORDER BY 2 DESC, 1
  `);
  const byMunicipality = await client.query<{ label: string; count: string }>(`
    SELECT COALESCE(m.name_bg, '(без община)') AS label, count(*) AS count
    FROM facilities f
    LEFT JOIN municipalities m ON m.id = f.municipality_id
    WHERE f.source = 'osm'
    GROUP BY 1 ORDER BY 2 DESC, 1
  `);
  const total = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM facilities WHERE source = 'osm'`,
  );
  return {
    bySport: bySport.rows.map((r) => ({ label: r.label, count: Number(r.count) })),
    byMunicipality: byMunicipality.rows.map((r) => ({ label: r.label, count: Number(r.count) })),
    totalOsm: Number(total.rows[0]?.n ?? 0),
  };
}
