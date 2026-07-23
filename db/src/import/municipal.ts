import {
  CANDIDATE_M,
  classify,
  facilitySlug,
  mergeFields,
  type Classification,
  type EditSource,
  type JsonValue,
  type NearbyCandidate,
  type NormalizedRow,
} from '@sportkarta/lib';
import type pg from 'pg';

/**
 * The database half of the municipal CSV inbox (docs/ROADMAP.md §8, Stage 6.3).
 * Takes a `pg.ClientBase` and runs inside the caller's transaction, exactly
 * like the OSM importer — so the web adapter and a rolled-back test share one
 * implementation.
 *
 * source=municipal, THROUGH facility_edits AND THE MERGE POLICY. A new registry
 * row is inserted as source=municipal with a `created` audit row; an update
 * runs mergeFields with incomingSource='municipal', so a crowd-verified field
 * is FROZEN (a resident outranks a possibly-stale registry) while an OSM-set
 * field is OVERWRITTEN (a municipality outranks the map). Every applied change
 * writes one facility_edits row; actor is NULL, because a registry import is
 * institutional data, not a person's contribution.
 *
 * `facilities.source` on an UPDATED row is left as it was — it records where the
 * ROW originated, and the OSM importer treats it the same way. Per-field
 * provenance lives in facility_edits.source, which is what the merge policy
 * reads; bumping the row's origin to 'municipal' would misreport where an
 * OSM-created facility came from and buys nothing the audit does not already
 * give.
 */

/** The fields a municipal import manages through the merge policy. */
const MANAGED_FIELDS = [
  'name',
  'sport_types',
  'surface',
  'lighting',
  'covered',
  'access',
  'quarter',
  'geom',
] as const;

/** 7 decimals ≈ 1 cm — the same shape the OSM importer stores geom edits as. */
function geomValue(lon: number, lat: number): JsonValue {
  return { lon: Number(lon.toFixed(7)), lat: Number(lat.toFixed(7)) };
}

/** The managed-field bag for one normalised row, in facility_edits shape. */
function rowFields(row: NormalizedRow): Record<string, JsonValue> {
  return {
    name: row.name,
    sport_types: row.sportTypes,
    surface: row.surface,
    lighting: row.lighting,
    covered: row.covered,
    access: row.access,
    quarter: row.quarter,
    geom: geomValue(row.lon, row.lat),
  };
}

export type RowOutcome =
  | { kind: 'new' }
  | { kind: 'match'; candidate: NearbyCandidate }
  | { kind: 'conflict'; reason: string; candidates: NearbyCandidate[] };

export interface RowPreview {
  rowNumber: number;
  name: string | null;
  outcome: RowOutcome;
}

/** Find facilities within CANDIDATE_M of a point, nearest first. */
async function nearbyCandidates(
  client: pg.ClientBase | pg.Pool,
  lon: number,
  lat: number,
): Promise<NearbyCandidate[]> {
  // Two-stage, like the crowd add-facility guard: the ST_DWithin degree
  // predicate uses facilities_geom_gist, and ST_DistanceSphere then gives exact
  // metres. 0.0016° comfortably covers CANDIDATE_M (120 m) at Bulgarian
  // latitudes, so nothing real is filtered before the exact test.
  const result = await client.query<{
    id: string;
    name: string | null;
    slug: string | null;
    distance_m: number;
  }>(
    `
    SELECT id, name, slug,
           ST_DistanceSphere(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) AS distance_m
    FROM facilities
    WHERE status <> 'gone'
      AND ST_DWithin(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326), 0.0016)
      AND ST_DistanceSphere(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) <= $3
    ORDER BY distance_m
    `,
    [lon, lat, CANDIDATE_M],
  );
  return result.rows.map((r) => ({
    facilityId: r.id,
    name: r.name,
    slug: r.slug,
    distanceM: Number(r.distance_m),
  }));
}

function toOutcome(classification: Classification): RowOutcome {
  if (classification.kind === 'new') return { kind: 'new' };
  if (classification.kind === 'match') return { kind: 'match', candidate: classification.candidate };
  return {
    kind: 'conflict',
    reason: classification.reason,
    candidates: classification.candidates,
  };
}

/**
 * Classify every normalised row against the live map. READ-ONLY — no
 * transaction required, and safe to call for the preview screen. The commit
 * re-runs this, so what the operator approved is what is written.
 */
export async function previewMunicipalRows(
  client: pg.ClientBase | pg.Pool,
  rows: readonly NormalizedRow[],
): Promise<RowPreview[]> {
  const previews: RowPreview[] = [];
  for (const row of rows) {
    const candidates = await nearbyCandidates(client, row.lon, row.lat);
    previews.push({
      rowNumber: row.rowNumber,
      name: row.name,
      outcome: toOutcome(classify(row.name, candidates)),
    });
  }
  return previews;
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
  for (const r of result.rows) {
    const entry = map.get(r.facility_id) ?? {};
    entry[r.field] = r.source;
    map.set(r.facility_id, entry);
  }
  return map;
}

/** Current managed-field values of a facility, for the merge. */
async function loadCurrent(
  client: pg.ClientBase,
  facilityId: string,
): Promise<Record<string, JsonValue> | null> {
  const result = await client.query<{
    name: string | null;
    sport_types: string[];
    surface: string | null;
    lighting: boolean | null;
    covered: boolean;
    access: string;
    quarter: string | null;
    lon: number;
    lat: number;
  }>(
    `SELECT name, sport_types, surface, lighting, covered, access, quarter,
            ST_X(geom) AS lon, ST_Y(geom) AS lat
     FROM facilities WHERE id = $1`,
    [facilityId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    name: row.name,
    sport_types: row.sport_types,
    surface: row.surface,
    lighting: row.lighting,
    covered: row.covered,
    access: row.access,
    quarter: row.quarter,
    geom: geomValue(Number(row.lon), Number(row.lat)),
  };
}

/**
 * How the operator resolved each row, keyed by rowNumber. A row with no entry
 * takes its default: new → insert, match → update, conflict → SKIP. Conflicts
 * an operator did not touch are never written, because a conflict the importer
 * resolved on its own is the failure mode this whole feature exists to prevent.
 */
export type Resolution =
  | { action: 'skip' }
  | { action: 'new' }
  | { action: 'link'; facilityId: string };

export interface CommitInput {
  rows: readonly NormalizedRow[];
  /** rowNumber → the operator's choice. */
  resolutions: Record<number, Resolution>;
  /** Operator-supplied registry label, recorded as provenance in attrs. */
  registryLabel: string;
}

export interface CommitCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
  /** field → number of merge-policy freezes (crowd-protected). */
  frozenFields: Record<string, number>;
}

function attrsFor(registryLabel: string, now: Date): JsonValue {
  return { municipal: { registry: registryLabel, imported_at: now.toISOString() } };
}

/**
 * Decide what to DO with a row: its resolution if the operator gave one, else
 * the default for its classification. Re-classifies from scratch rather than
 * trusting a preview posted back from the browser — the preview is a rendering,
 * never an authorisation (the bulk-create rule).
 */
async function actionFor(
  client: pg.ClientBase,
  row: NormalizedRow,
  resolution: Resolution | undefined,
): Promise<{ do: 'insert' } | { do: 'update'; facilityId: string } | { do: 'skip' }> {
  const candidates = await nearbyCandidates(client, row.lon, row.lat);
  const classification = classify(row.name, candidates);

  if (resolution?.action === 'skip') return { do: 'skip' };

  if (resolution?.action === 'link') {
    // The operator may only link to a facility this row actually collided with,
    // re-checked live — not to an arbitrary id posted from the browser.
    const allowed = candidates.some((c) => c.facilityId === resolution.facilityId);
    if (!allowed) return { do: 'skip' };
    return { do: 'update', facilityId: resolution.facilityId };
  }

  if (resolution?.action === 'new') return { do: 'insert' };

  // No resolution: take the classification's own default.
  if (classification.kind === 'match') {
    return { do: 'update', facilityId: classification.candidate.facilityId };
  }
  if (classification.kind === 'new') return { do: 'insert' };
  return { do: 'skip' }; // an unresolved conflict is never written
}

async function insertFacility(
  client: pg.ClientBase,
  row: NormalizedRow,
  takenSlugs: Set<string>,
  registryLabel: string,
  now: Date,
): Promise<void> {
  const fields = rowFields(row);
  // A stable slug at creation only when the row is named; an unnamed multi-use
  // ground stays unslugged (and off the public map's slug-gated views) exactly
  // as an unnamed OSM import would, rather than getting a meaningless slug.
  const slug = row.name
    ? facilitySlug(row.name, `obshtina-${String(row.rowNumber)}`, (c) => takenSlugs.has(c))
    : null;

  const inserted = await client.query<{ id: string }>(
    `
    INSERT INTO facilities
      (geom, name, slug, sport_types, surface, lighting, covered, access, quarter, status,
       municipality_id, source, attrs)
    VALUES
      (ST_SetSRID(ST_MakePoint($1, $2), 4326), $3, $4, $5::text[], $6, $7, $8, $9, $10,
       'needs_verification',
       (SELECT m.id FROM municipalities m
         WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326)) LIMIT 1),
       'municipal', $11::jsonb)
    RETURNING id
    `,
    [
      row.lon,
      row.lat,
      row.name,
      slug,
      row.sportTypes,
      row.surface,
      row.lighting,
      row.covered,
      row.access,
      row.quarter,
      JSON.stringify(attrsFor(registryLabel, now)),
    ],
  );
  const id = inserted.rows[0]?.id;
  if (id) {
    await client.query(
      `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
       VALUES ($1, NULL, 'municipal', 'created', NULL, $2::jsonb)`,
      [id, JSON.stringify(fields)],
    );
    if (slug) takenSlugs.add(slug);
  }
}

async function updateFacility(
  client: pg.ClientBase,
  facilityId: string,
  row: NormalizedRow,
  counts: CommitCounts,
): Promise<void> {
  const current = await loadCurrent(client, facilityId);
  if (!current) {
    counts.skipped += 1;
    return;
  }
  const lastEdits = (await loadLastEditSources(client, [facilityId])).get(facilityId) ?? {};

  const merge = mergeFields({
    incomingSource: 'municipal',
    current,
    incoming: rowFields(row),
    lastEditSources: lastEdits,
  });

  for (const field of merge.frozen) {
    counts.frozenFields[field] = (counts.frozenFields[field] ?? 0) + 1;
  }

  if (merge.applied.length === 0) {
    counts.unchanged += 1;
    return;
  }

  const sets: string[] = [];
  const params: unknown[] = [facilityId];
  for (const change of merge.applied) {
    if (change.field === 'geom') {
      const geo = change.newValue as { lon: number; lat: number };
      params.push(geo.lon, geo.lat);
      sets.push(
        `geom = ST_SetSRID(ST_MakePoint($${String(params.length - 1)}, $${String(params.length)}), 4326)`,
      );
      // Keep the municipality in step with a moved point, exactly as the OSM
      // importer does — a facility that drifts across a boundary must not stay
      // filed under the wrong city.
      sets.push(`municipality_id = (SELECT m.id FROM municipalities m
        WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint($${String(params.length - 1)}, $${String(params.length)}), 4326)) LIMIT 1)`);
    } else if (change.field === 'sport_types') {
      params.push(change.newValue);
      sets.push(`sport_types = $${String(params.length)}::text[]`);
    } else {
      params.push(change.newValue);
      sets.push(`${change.field} = $${String(params.length)}`);
    }
  }
  await client.query(`UPDATE facilities SET ${sets.join(', ')} WHERE id = $1`, params);

  for (const change of merge.applied) {
    await client.query(
      `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
       VALUES ($1, NULL, 'municipal', $2, $3::jsonb, $4::jsonb)`,
      [facilityId, change.field, JSON.stringify(change.oldValue), JSON.stringify(change.newValue)],
    );
  }
  counts.updated += 1;
}

/** All assigned slugs — the collision set for newly inserted facilities. */
async function loadTakenSlugs(client: pg.ClientBase): Promise<Set<string>> {
  const result = await client.query<{ slug: string }>(
    `SELECT slug FROM facilities WHERE slug IS NOT NULL`,
  );
  return new Set(result.rows.map((r) => r.slug));
}

/**
 * Commit an import. MUST run inside the caller's transaction; one savepoint per
 * row, so a single bad row cannot half-write the file. Re-classifies every row
 * live rather than trusting the posted preview.
 */
export async function commitMunicipalImport(
  client: pg.ClientBase,
  input: CommitInput,
  now: Date = new Date(),
): Promise<CommitCounts> {
  const counts: CommitCounts = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    frozenFields: {},
  };
  const takenSlugs = await loadTakenSlugs(client);

  for (const row of input.rows) {
    const action = await actionFor(client, row, input.resolutions[row.rowNumber]);
    if (action.do === 'skip') {
      counts.skipped += 1;
      continue;
    }
    await client.query('SAVEPOINT municipal_row');
    try {
      if (action.do === 'insert') {
        await insertFacility(client, row, takenSlugs, input.registryLabel, now);
        counts.inserted += 1;
      } else {
        await updateFacility(client, action.facilityId, row, counts);
      }
      await client.query('RELEASE SAVEPOINT municipal_row');
    } catch (error) {
      // A row that trips a constraint (e.g. a point that slips past the bbox
      // screen) is skipped and counted, not fatal to the rest of the file —
      // the same posture as the OSM importer.
      await client.query('ROLLBACK TO SAVEPOINT municipal_row');
      counts.skipped += 1;
      if (!/facilities_geom_in_bulgaria|facilities_slug/.test(String(error))) throw error;
    }
  }

  return counts;
}
