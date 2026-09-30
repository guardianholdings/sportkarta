import { facilitySlug, mergeFields, type EditSource, type JsonValue } from '@sportkarta/lib';
import type pg from 'pg';

import { findDuplicates, type DuplicatePair } from './dedupe.js';
import { municipalityOfSql } from './municipalities.js';
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
  /**
   * facilities in DB with osm refs that are absent from this extract — not
   * counting the ones OSM withdrew (those are in `withdrawn`/`withdrawnKept`).
   */
  missingFromExtract: number;
  constraintSkips: number;
  /** Rows OSM now marks abandoned/disused that this run took off the map. */
  withdrawn: number;
  /** Rows OSM marks abandoned/disused but a person has vouched for — left as they are. */
  withdrawnKept: WithdrawnKeptRow[];
  /** Rows this importer had withdrawn whose OSM object is back in use. */
  restored: number;
  /** New candidates not inserted because they duplicate a row that is (dedupe.ts). */
  duplicatesSkipped: DuplicatePair[];
  /** Pairs of rows that were BOTH already in the database — for a moderator. */
  existingDuplicates: DuplicatePair[];
  /**
   * New candidates not inserted because no municipality claims them, even
   * with the coastline snap — only counted while the boundary layer is complete.
   */
  outsideMunicipalities: { ref: string; name: string | null; lon: number; lat: number }[];
}

/** A lifecycle-tagged row the importer left alone, for a human to look at. */
export interface WithdrawnKeptRow {
  ref: string;
  slug: string | null;
  name: string | null;
  status: string;
}

export interface ImportOptions {
  /** `osm_type:osm_id` refs OSM marks abandoned/disused (extract.ts). */
  withdrawn?: ReadonlySet<string>;
  /**
   * Refuse NEW rows outside every municipality. Pass true only when the
   * boundary layer is complete (municipalityLayerComplete): with a boundary
   * missing, "outside every municipality" also means "inside the hole".
   */
  dropOutsideMunicipalities?: boolean;
}

type FacilityStatus = 'active' | 'needs_verification' | 'gone';

interface ExistingFacility {
  id: string;
  key: string;
  status: FacilityStatus;
  current: Record<string, JsonValue>;
}

function centroidValue(lon: number, lat: number): JsonValue {
  // 7 decimal places ≈ 1 cm — beyond OSM precision, stable across runs.
  return { lon: Number(lon.toFixed(7)), lat: Number(lat.toFixed(7)) };
}

export function candidateAttrs(candidate: FacilityCandidate): JsonValue {
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
export async function computeCentroids(
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
    status: FacilityStatus;
    attrs: JsonValue;
    lon: number;
    lat: number;
  }>(`
    SELECT id, osm_type, osm_id, name, sport_types, surface, lighting, covered,
           access, status, attrs, ST_X(geom) AS lon, ST_Y(geom) AS lat
    FROM facilities
    WHERE osm_type IS NOT NULL
  `);

  const map = new Map<string, ExistingFacility>();
  for (const row of result.rows) {
    const key = `${row.osm_type}:${row.osm_id}`;
    map.set(key, {
      id: row.id,
      key,
      status: row.status,
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

/** All assigned slugs — the collision set for newly inserted facilities. */
async function loadTakenSlugs(client: pg.ClientBase): Promise<Set<string>> {
  const result = await client.query<{ slug: string }>(
    `SELECT slug FROM facilities WHERE slug IS NOT NULL`,
  );
  return new Set(result.rows.map((r) => r.slug));
}

/**
 * Last audited edit source per (facility, field) — the merge-policy input.
 * Includes `status`, which the importer never proposes but reads: a `gone`
 * whose last status word was 'osm' is the importer's own withdrawal.
 */
export async function loadLastEditSources(
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
    [facilityIds, [...MANAGED_FIELDS, 'status']],
  );
  for (const row of result.rows) {
    const entry = map.get(row.facility_id) ?? {};
    entry[row.field] = row.source;
    map.set(row.facility_id, entry);
  }
  return map;
}

/** The importer's own withdrawal is the only `status` edit it ever writes as 'osm'. */
function isOwnWithdrawal(
  found: ExistingFacility,
  lastEdits: Map<string, Record<string, EditSource>>,
): boolean {
  return found.status === 'gone' && lastEdits.get(found.id)?.['status'] === 'osm';
}

function parseKey(key: string): { osmType: string; osmId: string } {
  const [osmType = '', osmId = ''] = key.split(':');
  return { osmType, osmId };
}

/**
 * Upsert all candidates inside the caller's transaction. Keyed
 * (osm_type, osm_id); source=osm; new rows land as needs_verification.
 * Every applied field change writes one facility_edits audit row; fields
 * last edited by crowd/municipal are frozen (merge policy, lib).
 *
 * Beyond the field merge it does three things, none of which ever touches a
 * row a person has vouched for:
 *  - withdraws (status → gone) rows whose OSM object is now abandoned/disused,
 *    and puts them back if OSM later drops that tag (withdrawFromOsm below);
 *  - does not insert a new candidate that duplicates a row (dedupe.ts);
 *  - does not insert a new candidate outside every municipality, when told
 *    the boundary layer is complete.
 */
export async function importCandidates(
  client: pg.ClientBase,
  candidates: FacilityCandidate[],
  options: ImportOptions = {},
): Promise<ImportCounts> {
  const counts: ImportCounts = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    frozenFields: {},
    missingFromExtract: 0,
    constraintSkips: 0,
    withdrawn: 0,
    withdrawnKept: [],
    restored: 0,
    duplicatesSkipped: [],
    existingDuplicates: [],
    outsideMunicipalities: [],
  };
  const withdrawnKeys = options.withdrawn ?? new Set<string>();

  const centroids = await computeCentroids(client, candidates);
  const existing = await loadExisting(client);
  const existingIds = [...existing.values()].map((f) => f.id);
  const lastEdits = await loadLastEditSources(client, existingIds);
  const takenSlugs = await loadTakenSlugs(client);

  // Cross-element duplicates, decided before any write. A row somebody marked
  // `gone` is not on the map and must not block a new mapping of the place;
  // one this run is about to restore is on it again.
  const dedupe = findDuplicates(
    candidates.flatMap((candidate, i) => {
      const centroid = centroids[i];
      if (!centroid) return [];
      const key = `${candidate.osmType}:${String(candidate.osmId)}`;
      const found = existing.get(key);
      if (found && found.status === 'gone' && !isOwnWithdrawal(found, lastEdits)) return [];
      return [
        {
          key,
          osmType: candidate.osmType,
          geometryKind: candidate.geometryKind,
          sportTypes: candidate.sportTypes,
          lon: centroid.lon,
          lat: centroid.lat,
          existing: found !== undefined,
        },
      ];
    }),
  );
  const duplicateOf = new Map(dedupe.dropped.map((pair) => [pair.drop, pair]));
  counts.existingDuplicates = dedupe.existingPairs;

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
      const duplicate = duplicateOf.get(key);
      if (duplicate) {
        counts.duplicatesSkipped.push(duplicate);
        continue;
      }
      // Stable slug at creation (never regenerated on rename). Fallback keys
      // off the OSM ref so unnamed facilities still get a deterministic slug.
      const slug = facilitySlug(
        candidate.name,
        `${candidate.osmType}-${String(candidate.osmId)}`,
        (c) => takenSlugs.has(c),
      );
      await client.query('SAVEPOINT import_row');
      try {
        const inserted = await client.query<{ id: string; municipality_id: number | null }>(
          `
          INSERT INTO facilities
            (geom, name, slug, sport_types, surface, lighting, covered, access, status,
             municipality_id, source, osm_type, osm_id, attrs)
          VALUES
            (ST_SetSRID(ST_MakePoint($1, $2), 4326), $3, $4, $5::text[], $6, $7, $8, $9,
             'needs_verification',
             ${municipalityOfSql('ST_SetSRID(ST_MakePoint($1, $2), 4326)')},
             'osm', $10, $11, $12::jsonb)
          RETURNING id, municipality_id
          `,
          [
            centroid.lon,
            centroid.lat,
            candidate.name,
            slug,
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
        const row = inserted.rows[0];
        // Inside the bbox yet in no municipality (not even within the
        // coastline snap): over a land border or in the Danube (audit
        // finding 87). Undone the same way as the CHECK rejection below.
        if (row && row.municipality_id === null && options.dropOutsideMunicipalities) {
          await client.query('ROLLBACK TO SAVEPOINT import_row');
          counts.outsideMunicipalities.push({
            ref: key,
            name: candidate.name,
            lon: centroid.lon,
            lat: centroid.lat,
          });
          continue;
        }
        const newId = row?.id;
        if (newId) {
          await client.query(
            `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
             VALUES ($1, NULL, 'osm', 'created', NULL, $2::jsonb)`,
            [newId, JSON.stringify(fields)],
          );
        }
        await client.query('RELEASE SAVEPOINT import_row');
        // Only reserve the slug once the row actually committed (a bbox-CHECK
        // rollback below must not leak it out of the collision set).
        takenSlugs.add(slug);
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

    // OSM no longer marks it abandoned/disused, and the `gone` was ours: put
    // it back where every OSM row starts. A `gone` from a person is theirs.
    let restored = false;
    if (isOwnWithdrawal(found, lastEdits)) {
      const back = await client.query(
        `UPDATE facilities SET status = 'needs_verification' WHERE id = $1 AND status = 'gone'`,
        [found.id],
      );
      if ((back.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
           VALUES ($1, NULL, 'osm', 'status', '"gone"'::jsonb, '"needs_verification"'::jsonb)`,
          [found.id],
        );
        counts.restored += 1;
        restored = true;
      }
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
      if (restored) counts.updated += 1;
      else counts.unchanged += 1;
      continue;
    }

    const sets: string[] = [];
    const params: unknown[] = [found.id];
    for (const change of merge.applied) {
      if (change.field === 'geom') {
        const geo = change.newValue as { lon: number; lat: number };
        params.push(geo.lon, geo.lat);
        const point = `ST_SetSRID(ST_MakePoint($${String(params.length - 1)}, $${String(params.length)}), 4326)`;
        sets.push(`geom = ${point}`);
        sets.push(`municipality_id = ${municipalityOfSql(point)}`);
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

  const withdrawal = await withdrawFromOsm(client, withdrawnKeys);
  counts.withdrawn = withdrawal.withdrawn;
  counts.withdrawnKept = withdrawal.kept;

  for (const key of existing.keys()) {
    if (!seenKeys.has(key) && !withdrawnKeys.has(key)) counts.missingFromExtract += 1;
  }

  return counts;
}

/**
 * Take off the map the rows whose OSM object is now marked abandoned/disused
 * (audit finding 81: 24 of them were published, most as free, with a
 * «Упъти ме» hand-off to Waze or Google Maps).
 *
 * WHY THIS IS NOT "AUTO-MARKING GONE". Absence from the extract is never acted
 * on — a truncated download would look exactly like mass demolition. This is
 * the opposite case: OSM, the source that put the row on the map, now states
 * in so many words that the place is out of use, and the importer withdraws
 * what it alone published.
 *
 * ONLY WHAT OSM ALONE VOUCHED FOR. A row is withdrawn only while it is still
 * `needs_verification`, no person or municipal registry has ever written to it
 * (any non-'osm' facility_edits row — a verification, a condition report, a
 * correction, a moderator's decision), and nobody hosts a session there. Every
 * other lifecycle-tagged row is left exactly as it is and counted in `kept`,
 * for a human to look at: somebody who stood there outranks a map tag.
 *
 * The status edit is audited as source 'osm' with a NULL actor (institutional,
 * like every importer write, and — load-bearing — a NULL actor never reads as
 * "last verified"). That 'osm' stamp is also what lets a later run recognise
 * the withdrawal as its own and reverse it when the tag goes away.
 */
async function withdrawFromOsm(
  client: pg.ClientBase,
  keys: ReadonlySet<string>,
): Promise<{ withdrawn: number; kept: WithdrawnKeptRow[] }> {
  if (keys.size === 0) return { withdrawn: 0, kept: [] };
  const refs = [...keys].map(parseKey);
  const params = [refs.map((r) => r.osmType), refs.map((r) => r.osmId)];
  const refFilter = `(f.osm_type, f.osm_id) IN (
    SELECT r.osm_type, r.osm_id FROM unnest($1::text[], $2::bigint[]) AS r(osm_type, osm_id))`;

  const withdrawn = await client.query(
    `
    WITH withdrawn AS (
      UPDATE facilities f SET status = 'gone'
       WHERE ${refFilter}
         AND f.source = 'osm'
         AND f.status = 'needs_verification'
         AND NOT EXISTS (SELECT 1 FROM facility_edits e
                          WHERE e.facility_id = f.id AND e.source <> 'osm')
         AND NOT EXISTS (SELECT 1 FROM play_sessions s WHERE s.facility_id = f.id)
      RETURNING f.id
    )
    INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
    SELECT id, NULL, 'osm', 'status', '"needs_verification"'::jsonb, '"gone"'::jsonb
      FROM withdrawn
    `,
    params,
  );
  const kept = await client.query<{
    osm_type: string;
    osm_id: string;
    slug: string | null;
    name: string | null;
    status: string;
  }>(
    `SELECT f.osm_type, f.osm_id, f.slug, f.name, f.status FROM facilities f
      WHERE ${refFilter} AND f.status <> 'gone'
      ORDER BY f.osm_type, f.osm_id`,
    params,
  );
  return {
    withdrawn: withdrawn.rowCount ?? 0,
    kept: kept.rows.map((r) => ({
      ref: `${r.osm_type}:${r.osm_id}`,
      slug: r.slug,
      name: r.name,
      status: r.status,
    })),
  };
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
