import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';

import type pg from 'pg';

/**
 * The seven fixture facilities, and their retirement from PRODUCTION.
 *
 * WHAT THEY ARE. db/scripts/seed.ts inserts seven hand-made facilities — fixed
 * ids, `source = 'crowd'`, `attrs.seed = true` — so dev, CI and e2e have a
 * small world the db-backed tests borrow. Nobody verified them. They reached
 * the production map through a full fixture seed run against it (audit
 * finding 82; 0030/0031 relabelled them `needs_verification`). Boss decision
 * #18: take them off production before launch, and nowhere else.
 *
 * WHY "RETIRE" (`status = 'gone'`) AND NOT DELETE. Every fixture has
 * `facility_edits` rows — the seed writes its own 'created' audit row in the
 * same statement as the insert — and `facility_edits` references facilities
 * ON DELETE RESTRICT and is append-only by trigger (0001). `points_ledger`
 * (0006) and `moderation_decisions` (0007) are RESTRICT and append-only the
 * same way. A hard DELETE would mean disabling those triggers, i.e. rewriting
 * the audit log. `gone` is the platform's own takedown — the status a
 * moderator's "gone" decision sets — and the public-visibility predicate
 * (PUBLIC_FACILITY_PREDICATE) drops such a row from the map and its list,
 * /obekt (404), the sitemaps, the open-data export, the photo routes and the
 * statistics views, while the history stays whole. It also outlives any
 * re-run of an older fixture seed: that seed inserts by fixed id ON CONFLICT
 * DO NOTHING, so a tombstone cannot be re-published by it, where a deleted id
 * would simply be inserted again.
 *
 * TRIPLE-IDENTIFIED. A row is a candidate only when its id is one of the seven
 * AND `source = 'crowd'` AND `attrs->>'seed' = 'true'` — the three marks the
 * seed itself writes. No other facility can match.
 *
 * EXPORT FIRST, ONE TRANSACTION (the caller's). The candidates are locked,
 * written to a JSON file that is fsynced and read back, and only then
 * updated. No export directory, or one that cannot be written, throws before
 * anything has changed. The file holds facility rows and dependent-row COUNTS
 * — no person data — and never leaves the server: the repository is public,
 * and so are its deploy logs.
 *
 * AT MOST ONCE PER ROW. A fixture that carries this step's own audit row (a
 * NULL-actor status edit to "gone") is never a candidate again — so a second
 * run finds nothing, and a fixture somebody deliberately RE-PUBLISHED with
 * restoreSeedFixtures() stays published instead of being retired again by the
 * next deploy (the house rule of 0030/0031: a correction never fights a human).
 */

export const SEED_FIXTURE_IDS: readonly string[] = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007',
];

export interface FacilityDependent {
  table: string;
  /** pg_constraint.confdeltype of its foreign key: r = RESTRICT, c = CASCADE, n = SET NULL. */
  onDelete: 'r' | 'c' | 'n';
  /** Rows may never be deleted (a BEFORE DELETE trigger raises). */
  appendOnly: boolean;
}

/**
 * Every foreign key to facilities.id, each on a `facility_id` column.
 * Retirement deletes nothing, so none of these rows is touched; they are
 * COUNTED into the export so the record says what each facility carried. A
 * db-backed test holds this list equal to pg_constraint, so a new referencing
 * table cannot slip past it.
 */
export const FACILITY_DEPENDENTS: readonly FacilityDependent[] = [
  { table: 'facility_edits', onDelete: 'r', appendOnly: true }, // 0001
  { table: 'facility_photos', onDelete: 'c', appendOnly: false }, // 0001
  { table: 'facility_reports', onDelete: 'c', appendOnly: false }, // 0003
  { table: 'facility_condition_reports', onDelete: 'c', appendOnly: false }, // 0006
  { table: 'points_ledger', onDelete: 'r', appendOnly: true }, // 0006
  { table: 'moderation_decisions', onDelete: 'r', appendOnly: true }, // 0007
  { table: 'play_sessions', onDelete: 'r', appendOnly: false }, // 0008
  { table: 'facility_sponsorships', onDelete: 'r', appendOnly: false }, // 0023
  { table: 'training_logs', onDelete: 'n', appendOnly: false }, // 0027
];

export const EXPORT_KIND = 'pops/seed-fixture-export';

/** One exported `facilities` row: every column as to_jsonb renders it, geometry as lon/lat. */
export interface ExportedFacility {
  row: Record<string, unknown>;
  lon: number;
  lat: number;
}

export interface SeedFixtureExport {
  kind: typeof EXPORT_KIND;
  version: 1;
  exportedAt: string;
  database: string;
  reason: string;
  facilities: ExportedFacility[];
  /** Rows referencing the exported facilities, per table — counts only, never contents. */
  dependents: Record<string, number>;
  /** facility_edits rows on them written by a person (actor IS NOT NULL). */
  personEdits: number;
  restore: string;
}

export interface RetireOptions {
  /** Where the export goes BEFORE anything changes; required when there is something to retire. */
  exportDir: string | undefined;
  now?: Date;
}

export interface RetireReport {
  /** Fixture ids present in `facilities` at all, whatever their markers. */
  present: number;
  /** Rows this run retired — 0 on every run after the first. */
  retired: number;
  exportPath: string | null;
  dependents: Record<string, number>;
  personEdits: number;
}

export interface RestoreReport {
  /** `gone` → the exported status. */
  republished: number;
  /** Absent from `facilities` and inserted again from the export. */
  reinserted: number;
  /** Present but not a retired fixture (already visible, or no longer marked as seed). */
  untouched: number;
}

/**
 * The audit row retirement writes, and the mark that it already happened. No
 * other writer produces it: people's edits carry an actor, the importers write
 * source 'osm' / 'municipal', the seed writes field 'created', and 0030/0031
 * wrote status rows to "needs_verification".
 */
const RETIREMENT_EDIT = `e.actor IS NULL AND e.source = 'crowd' AND e.field = 'status' AND e.new_value = '"gone"'::jsonb`;

/** A fixture candidate: the three marks, still visible, never retired before. */
const CANDIDATE = `
  f.id = ANY($1::uuid[])
  AND f.source = 'crowd'
  AND f.attrs->>'seed' = 'true'
  AND f.status <> 'gone'
  AND NOT EXISTS (
    SELECT 1 FROM facility_edits e WHERE e.facility_id = f.id AND ${RETIREMENT_EDIT}
  )`;

const REASON =
  'Boss decision #18: remove the seven seed fixtures from production before launch (status gone; facility_edits is append-only, so the rows are retired, not deleted)';

/**
 * Retire the fixture facilities that reached this database. The CALLER owns
 * the transaction (BEGIN … COMMIT); throwing at any point leaves it to roll
 * back with nothing changed.
 */
export async function retireSeedFixtures(
  client: pg.ClientBase,
  options: RetireOptions,
): Promise<RetireReport> {
  const ids = [...SEED_FIXTURE_IDS];
  // As 0030/0031: never queue a deploy behind a long-held lock.
  await client.query(`SET LOCAL lock_timeout = '3s'`);

  const present = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM facilities WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const presentCount = present.rows[0]?.n ?? 0;

  const locked = await client.query<ExportedFacility>(
    `SELECT to_jsonb(f) - 'geom' AS "row", ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat
       FROM facilities f
      WHERE ${CANDIDATE}
      ORDER BY f.id
        FOR UPDATE`,
    [ids],
  );
  if (locked.rows.length === 0) {
    return { present: presentCount, retired: 0, exportPath: null, dependents: {}, personEdits: 0 };
  }
  const targetIds = locked.rows.map((r) => String(r.row.id));

  const dependents: Record<string, number> = {};
  for (const dependent of FACILITY_DEPENDENTS) {
    const counted = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${dependent.table} WHERE facility_id = ANY($1::uuid[])`,
      [targetIds],
    );
    dependents[dependent.table] = counted.rows[0]?.n ?? 0;
  }
  const person = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM facility_edits
      WHERE facility_id = ANY($1::uuid[]) AND actor IS NOT NULL`,
    [targetIds],
  );

  if (!options.exportDir) {
    throw new Error(
      'SEED_FIXTURE_EXPORT_DIR is not set: refusing to retire the seed fixtures without exporting them first',
    );
  }
  const database = await client.query<{ name: string }>('SELECT current_database() AS name');
  const now = options.now ?? new Date();
  const exportPath = await writeExport(options.exportDir, now, {
    kind: EXPORT_KIND,
    version: 1,
    exportedAt: now.toISOString(),
    database: database.rows[0]?.name ?? '',
    reason: REASON,
    facilities: locked.rows.map((r) => ({ row: r.row, lon: Number(r.lon), lat: Number(r.lat) })),
    dependents,
    personEdits: person.rows[0]?.n ?? 0,
    restore: 'pnpm db:restore-seed-fixtures <this file>  (db/scripts/restore-seed-fixtures.ts)',
  });

  // One statement, so the audit row is written for exactly the rows that
  // changed. actor NULL, as in 0030/0031: an attributed row would read as a
  // person's decision; source 'crowd' is the rows' own source.
  const retired = await client.query<{ facility_id: string }>(
    `WITH target AS (
       SELECT f.id, f.status::text AS old_status
         FROM facilities f
        WHERE f.id = ANY($1::uuid[])
          AND f.source = 'crowd'
          AND f.attrs->>'seed' = 'true'
          AND f.status <> 'gone'
     ), retired AS (
       UPDATE facilities f
          SET status = 'gone'
         FROM target t
        WHERE f.id = t.id
       RETURNING f.id, t.old_status
     )
     INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
     SELECT id, NULL, 'crowd', 'status', to_jsonb(old_status), '"gone"'::jsonb
       FROM retired
     RETURNING facility_id`,
    [targetIds],
  );
  if (retired.rows.length !== targetIds.length) {
    throw new Error(
      `retired ${String(retired.rows.length)} row(s) but exported ${String(targetIds.length)}: not committing`,
    );
  }

  return {
    present: presentCount,
    retired: retired.rows.length,
    exportPath,
    dependents,
    personEdits: person.rows[0]?.n ?? 0,
  };
}

/**
 * How many of the seven carry a retirement audit row. Non-zero means this
 * database once ran the production seed's retirement — it is production, or a
 * restored copy of it — whatever their status is now (the audit row is
 * append-only and outlives a restore).
 */
export async function fixtureRetirementsRecorded(client: pg.ClientBase): Promise<number> {
  const result = await client.query<{ n: number }>(
    `SELECT count(DISTINCT e.facility_id)::int AS n
       FROM facility_edits e
      WHERE e.facility_id = ANY($1::uuid[]) AND ${RETIREMENT_EDIT}`,
    [[...SEED_FIXTURE_IDS]],
  );
  return result.rows[0]?.n ?? 0;
}

async function writeExport(dir: string, now: Date, doc: SeedFixtureExport): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `seed-fixtures-${now.toISOString().replace(/[:.]/g, '-')}.json`);
  // 'wx': never overwrite an earlier export.
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Read it back: an export that does not parse is no export.
  const reread = parseSeedFixtureExport(JSON.parse(await readFile(file, 'utf8')) as unknown);
  if (reread.facilities.length !== doc.facilities.length) {
    throw new Error(`export ${file} reads back incomplete: not committing`);
  }
  return file;
}

/**
 * Undo: put the exported rows back. A retired fixture (`gone`, still marked as
 * seed) gets its exported status back; a fixture absent from the table is
 * inserted again from the export. Each change is audited with a NULL actor.
 * The CALLER owns the transaction. `allowedIds` exists for the tests; the
 * script always restores the seven.
 */
export async function restoreSeedFixtures(
  client: pg.ClientBase,
  doc: SeedFixtureExport,
  options: { allowedIds?: readonly string[] } = {},
): Promise<RestoreReport> {
  const allowed = options.allowedIds ?? SEED_FIXTURE_IDS;
  const snapshots = doc.facilities.map((facility) => facilitySnapshot(facility, allowed));
  await client.query(`SET LOCAL lock_timeout = '3s'`);
  const report: RestoreReport = { republished: 0, reinserted: 0, untouched: 0 };

  for (const s of snapshots) {
    const republished = await client.query(
      `WITH target AS (
         SELECT f.id FROM facilities f
          WHERE f.id = $1::uuid AND f.source = 'crowd' AND f.attrs->>'seed' = 'true'
            AND f.status = 'gone'
            FOR UPDATE
       ), restored AS (
         UPDATE facilities f
            SET status = $2::text::facility_status
           FROM target t
          WHERE f.id = t.id
         RETURNING f.id
       )
       INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
       SELECT id, NULL, 'crowd', 'status', '"gone"'::jsonb, to_jsonb($2::text)
         FROM restored
       RETURNING facility_id`,
      [s.id, s.status],
    );
    if ((republished.rowCount ?? 0) > 0) {
      report.republished += 1;
      continue;
    }

    const exists = await client.query(`SELECT 1 FROM facilities WHERE id = $1::uuid`, [s.id]);
    if ((exists.rowCount ?? 0) > 0) {
      report.untouched += 1;
      continue;
    }

    const inserted = await client.query(
      `WITH ins AS (
         INSERT INTO facilities
           (id, geom, name, slug, sport_types, surface, lighting, covered, access, status,
            municipality_id, business_id, quarter, source, osm_type, osm_id, condition,
            condition_reported_at, attrs, created_at, updated_at)
         VALUES
           ($1::uuid, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5, $6::text[], $7, $8, $9,
            $10::text::facility_access, $11::text::facility_status, $12, $13, $14,
            $15::text::facility_source, $16, $17, $18::text::facility_condition, $19::timestamptz,
            $20::jsonb, $21::timestamptz, $22::timestamptz)
         ON CONFLICT (id) DO NOTHING
         RETURNING id
       )
       INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
       SELECT id, NULL, 'crowd', 'created', NULL, '{"seed": true, "restored": true}'::jsonb
         FROM ins
       RETURNING facility_id`,
      [
        s.id,
        s.lon,
        s.lat,
        s.name,
        s.slug,
        s.sportTypes,
        s.surface,
        s.lighting,
        s.covered,
        s.access,
        s.status,
        s.municipalityId,
        s.businessId,
        s.quarter,
        s.source,
        s.osmType,
        s.osmId,
        s.condition,
        s.conditionReportedAt,
        JSON.stringify(s.attrs),
        s.createdAt,
        s.updatedAt,
      ],
    );
    if ((inserted.rowCount ?? 0) !== 1) {
      throw new Error(`could not re-insert fixture ${s.id}: not committing`);
    }
    report.reinserted += 1;
  }
  return report;
}

/** A typed, validated view of one exported row — what restore writes back. */
export interface FacilitySnapshot {
  id: string;
  lon: number;
  lat: number;
  name: string | null;
  slug: string | null;
  sportTypes: string[];
  surface: string | null;
  lighting: boolean | null;
  covered: boolean;
  access: string;
  status: 'active' | 'needs_verification';
  municipalityId: number | null;
  businessId: number | null;
  quarter: string | null;
  source: 'crowd';
  osmType: string | null;
  osmId: number | null;
  condition: string | null;
  conditionReportedAt: string | null;
  attrs: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`not a seed-fixture export: ${message}`);
}

function text(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== 'string' || value === '') fail(`${key} must be a non-empty string`);
  return value;
}

function textOrNull(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(`${key} must be a string or null`);
  return value;
}

function numberOrNull(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${key} must be a number or null`);
  return value;
}

export function facilitySnapshot(
  facility: ExportedFacility,
  allowedIds: readonly string[] = SEED_FIXTURE_IDS,
): FacilitySnapshot {
  const row = facility.row;
  const id = text(row, 'id');
  if (!allowedIds.includes(id)) fail(`${id} is not one of the seed fixtures`);
  if (row.source !== 'crowd') fail(`${id} is not source 'crowd'`);
  const attrs = row.attrs;
  if (!isRecord(attrs) || attrs.seed !== true) fail(`${id} is not marked attrs.seed = true`);
  const status = row.status;
  if (status !== 'active' && status !== 'needs_verification') {
    fail(`${id} has status ${String(status)}; only a visible row is ever exported`);
  }
  const sportTypes = row.sport_types;
  if (!Array.isArray(sportTypes) || !sportTypes.every((s) => typeof s === 'string')) {
    fail(`${id} sport_types must be a list of strings`);
  }
  const lighting = row.lighting;
  if (lighting !== null && lighting !== undefined && typeof lighting !== 'boolean') {
    fail(`${id} lighting must be a boolean or null`);
  }
  if (typeof row.covered !== 'boolean') fail(`${id} covered must be a boolean`);
  if (!Number.isFinite(facility.lon) || !Number.isFinite(facility.lat)) {
    fail(`${id} has no coordinates`);
  }
  return {
    id,
    lon: facility.lon,
    lat: facility.lat,
    name: textOrNull(row, 'name'),
    slug: textOrNull(row, 'slug'),
    sportTypes: sportTypes as string[],
    surface: textOrNull(row, 'surface'),
    lighting: typeof lighting === 'boolean' ? lighting : null,
    covered: row.covered,
    access: text(row, 'access'),
    status,
    municipalityId: numberOrNull(row, 'municipality_id'),
    businessId: numberOrNull(row, 'business_id'),
    quarter: textOrNull(row, 'quarter'),
    source: 'crowd',
    osmType: textOrNull(row, 'osm_type'),
    osmId: numberOrNull(row, 'osm_id'),
    condition: textOrNull(row, 'condition'),
    conditionReportedAt: textOrNull(row, 'condition_reported_at'),
    attrs,
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
}

/** Parse and validate an export file's JSON; throws on anything that is not one. */
export function parseSeedFixtureExport(
  value: unknown,
  allowedIds: readonly string[] = SEED_FIXTURE_IDS,
): SeedFixtureExport {
  if (!isRecord(value)) fail('not an object');
  if (value.kind !== EXPORT_KIND) fail(`kind must be ${EXPORT_KIND}`);
  if (value.version !== 1) fail('unknown version');
  const facilities = value.facilities;
  if (!Array.isArray(facilities) || facilities.length === 0) fail('no facilities');
  const parsed: ExportedFacility[] = facilities.map((entry: unknown) => {
    if (!isRecord(entry) || !isRecord(entry.row)) fail('a facility entry has no row');
    const facility: ExportedFacility = {
      row: entry.row,
      lon: Number(entry.lon),
      lat: Number(entry.lat),
    };
    facilitySnapshot(facility, allowedIds);
    return facility;
  });
  const ids = parsed.map((f) => String(f.row.id));
  if (new Set(ids).size !== ids.length) fail('a facility appears twice');
  const dependents = value.dependents;
  if (!isRecord(dependents) || !Object.values(dependents).every((n) => typeof n === 'number')) {
    fail('dependents must be counts');
  }
  return {
    kind: EXPORT_KIND,
    version: 1,
    exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '',
    database: typeof value.database === 'string' ? value.database : '',
    reason: typeof value.reason === 'string' ? value.reason : '',
    facilities: parsed,
    dependents: dependents as Record<string, number>,
    personEdits: typeof value.personEdits === 'number' ? value.personEdits : 0,
    restore: typeof value.restore === 'string' ? value.restore : '',
  };
}
