import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PUBLIC_FACILITY_PREDICATE } from '@sportkarta/lib/opendata';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  EXPORT_KIND,
  FACILITY_DEPENDENTS,
  fixtureRetirementsRecorded,
  parseSeedFixtureExport,
  restoreSeedFixtures,
  retireSeedFixtures,
  SEED_FIXTURE_IDS,
  type SeedFixtureExport,
} from './seed-fixtures.js';
import { refreshStats } from './stats.js';

/**
 * Boss decision #18: the seven seed fixtures leave PRODUCTION — exported
 * first, retired (`status = 'gone'`) in one transaction, at most once — and
 * stay in every dev and CI database. The db-backed half runs every case inside
 * a transaction it rolls back, so the fixtures the other suites borrow are
 * untouched and the statistics views do not drift.
 */

const url = process.env.DATABASE_URL;

function exportRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: 'Стрийтбол – Морска градина',
    slug: 'striytbol-morska-gradina',
    sport_types: ['basketball'],
    surface: 'asphalt',
    lighting: true,
    covered: false,
    access: 'free',
    status: 'needs_verification',
    municipality_id: 3,
    business_id: null,
    quarter: 'Приморски',
    source: 'crowd',
    osm_type: null,
    osm_id: null,
    condition: null,
    condition_reported_at: null,
    attrs: { seed: true },
    created_at: '2026-08-08T19:00:00+00:00',
    updated_at: '2026-08-09T12:51:13.15+00:00',
    ...overrides,
  };
}

function exportDoc(rows: Record<string, unknown>[]): unknown {
  return {
    kind: EXPORT_KIND,
    version: 1,
    exportedAt: '2026-10-04T09:00:00.000Z',
    database: 'sportkarta',
    reason: 'test',
    facilities: rows.map((row) => ({ row, lon: 27.926, lat: 43.2141 })),
    dependents: { facility_edits: 2 },
    personEdits: 0,
    restore: 'test',
  };
}

describe('seed-fixture export format', () => {
  const seventh = SEED_FIXTURE_IDS[6] ?? '';

  it('accepts what the retirement writes', () => {
    const doc = parseSeedFixtureExport(exportDoc([exportRow(seventh)]));
    expect(doc.facilities).toHaveLength(1);
    expect(doc.dependents).toEqual({ facility_edits: 2 });
  });

  it('refuses anything that is not one of the seven, triple-identified and visible', () => {
    const refused: [string, unknown][] = [
      ['an id outside the seven', exportDoc([exportRow('00000000-0000-4000-8000-000000000008')])],
      ['another source', exportDoc([exportRow(seventh, { source: 'osm' })])],
      ['no seed mark', exportDoc([exportRow(seventh, { attrs: {} })])],
      ['an already-retired row', exportDoc([exportRow(seventh, { status: 'gone' })])],
      ['a duplicate', exportDoc([exportRow(seventh), exportRow(seventh)])],
      ['another kind', { ...(exportDoc([exportRow(seventh)]) as object), kind: 'x' }],
      ['no facilities', exportDoc([])],
    ];
    for (const [why, doc] of refused) {
      expect(() => parseSeedFixtureExport(doc), why).toThrow(/not a seed-fixture export/);
    }
  });
});

describe.skipIf(!url)('retiring the seed fixtures (production seed step)', () => {
  let client: pg.Client;
  let dir: string;
  const ids = [...SEED_FIXTURE_IDS];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'seed-fixtures-'));
    await client.query('BEGIN');
    const visible = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM facilities f
        WHERE f.id = ANY($1::uuid[]) AND f.source = 'crowd' AND f.attrs->>'seed' = 'true'
          AND ${PUBLIC_FACILITY_PREDICATE}`,
      [ids],
    );
    if (visible.rows[0]?.n !== ids.length) {
      throw new Error('fixture: the seven seed facilities are not all public — run pnpm db:seed');
    }
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
    await rm(dir, { recursive: true, force: true });
  });

  /** id → status, updated_at for every facility OUTSIDE the seven. */
  async function everyOtherFacility(): Promise<string> {
    const result = await client.query<{ digest: string | null }>(
      `SELECT md5(string_agg(id::text || status::text || updated_at::text, ',' ORDER BY id)) AS digest
         FROM facilities WHERE id <> ALL($1::uuid[])`,
      [ids],
    );
    return result.rows[0]?.digest ?? '';
  }

  async function statuses(): Promise<string[]> {
    const result = await client.query<{ status: string }>(
      `SELECT status::text AS status FROM facilities WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [ids],
    );
    return result.rows.map((r) => r.status);
  }

  async function readExport(file: string | null): Promise<SeedFixtureExport> {
    expect(file).not.toBeNull();
    return parseSeedFixtureExport(JSON.parse(await readFile(file ?? '', 'utf8')) as unknown);
  }

  it('exports, then retires exactly the seven — and nothing else', async () => {
    const others = await everyOtherFacility();
    const report = await retireSeedFixtures(client, { exportDir: dir });

    expect(report).toMatchObject({ present: 7, retired: 7 });
    expect(await statuses()).toEqual(Array(7).fill('gone'));
    expect(await everyOtherFacility()).toBe(others);

    const audit = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM facility_edits
        WHERE facility_id = ANY($1::uuid[]) AND actor IS NULL AND source = 'crowd'
          AND field = 'status' AND new_value = '"gone"'::jsonb
          AND old_value = '"needs_verification"'::jsonb`,
      [ids],
    );
    expect(audit.rows[0]?.n).toBe(7);

    // The export: the seven rows as they were, and facility columns only.
    const doc = await readExport(report.exportPath);
    expect(doc.facilities.map((f) => f.row.id)).toEqual(ids);
    expect(new Set(doc.facilities.map((f) => f.row.status))).toEqual(
      new Set(['needs_verification']),
    );
    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'facilities' AND column_name <> 'geom'`,
    );
    const allowed = new Set(columns.rows.map((r) => r.column_name));
    for (const facility of doc.facilities) {
      for (const key of Object.keys(facility.row)) expect(allowed.has(key), key).toBe(true);
    }
    expect(Object.keys(doc.dependents).sort()).toEqual(
      FACILITY_DEPENDENTS.map((d) => d.table).sort(),
    );
    expect(doc.dependents.facility_edits).toBeGreaterThanOrEqual(7); // the seed's 'created' rows
  });

  it('takes them off every public surface, and the statistics with them', async () => {
    await refreshStats(client, { concurrently: false });
    const before = await client.query<{ total: number }>(
      'SELECT total::int AS total FROM mv_national_stats',
    );
    await retireSeedFixtures(client, { exportDir: dir });

    const visible = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM facilities f
        WHERE f.id = ANY($1::uuid[]) AND ${PUBLIC_FACILITY_PREDICATE}`,
      [ids],
    );
    expect(visible.rows[0]?.n).toBe(0);

    await refreshStats(client, { concurrently: false });
    const after = await client.query<{ total: number }>(
      'SELECT total::int AS total FROM mv_national_stats',
    );
    expect((before.rows[0]?.total ?? 0) - (after.rows[0]?.total ?? 0)).toBe(7);
  });

  it('is triple-identified: a fixture id that lost a mark, or a look-alike, stays', async () => {
    const first = ids[0] ?? '';
    await client.query(`UPDATE facilities SET attrs = attrs - 'seed' WHERE id = $1::uuid`, [first]);
    const decoy = await client.query<{ id: string }>(
      `INSERT INTO facilities (geom, name, access, status, source, attrs)
       VALUES (ST_SetSRID(ST_MakePoint(23.3219, 42.6977), 4326), 'Look-alike', 'free',
               'needs_verification', 'crowd', '{"seed": true}'::jsonb)
       RETURNING id`,
    );

    const report = await retireSeedFixtures(client, { exportDir: dir });
    expect(report.retired).toBe(6);
    expect((await statuses())[0]).toBe('needs_verification');
    const lookalike = await client.query<{ status: string }>(
      `SELECT status::text AS status FROM facilities WHERE id = $1::uuid`,
      [decoy.rows[0]?.id],
    );
    expect(lookalike.rows[0]?.status).toBe('needs_verification');
  });

  it('runs once: a second run retires nothing and writes no second export', async () => {
    await retireSeedFixtures(client, { exportDir: dir });
    const again = await retireSeedFixtures(client, { exportDir: dir });
    expect(again).toMatchObject({ present: 7, retired: 0, exportPath: null });
    expect(await readdir(dir)).toHaveLength(1);
    expect(await fixtureRetirementsRecorded(client)).toBe(7);
  });

  it('changes nothing without somewhere to export to', async () => {
    await expect(retireSeedFixtures(client, { exportDir: undefined })).rejects.toThrow(
      /SEED_FIXTURE_EXPORT_DIR/,
    );
    expect(await statuses()).toEqual(Array(7).fill('needs_verification'));
    expect(await fixtureRetirementsRecorded(client)).toBe(0);
  });

  it('undo: restore republishes them, and the next deploy leaves them published', async () => {
    const retired = await retireSeedFixtures(client, { exportDir: dir });
    const doc = await readExport(retired.exportPath);

    const restored = await restoreSeedFixtures(client, doc);
    expect(restored).toEqual({ republished: 7, reinserted: 0, untouched: 0 });
    expect(await statuses()).toEqual(Array(7).fill('needs_verification'));

    // A second restore finds them visible already.
    expect(await restoreSeedFixtures(client, doc)).toEqual({
      republished: 0,
      reinserted: 0,
      untouched: 7,
    });
    // The next deploy's retirement respects the human decision…
    expect((await retireSeedFixtures(client, { exportDir: dir })).retired).toBe(0);
    expect(await statuses()).toEqual(Array(7).fill('needs_verification'));
    // …and the database still knows it is production for the fixture seed.
    expect(await fixtureRetirementsRecorded(client)).toBe(7);
  });

  it('undo: re-inserts a row that is no longer in the table', async () => {
    const retired = await retireSeedFixtures(client, { exportDir: dir });
    const doc = await readExport(retired.exportPath);
    const source = doc.facilities[6];
    expect(source).toBeDefined();
    // A fixture cannot be deleted (facility_edits is append-only and RESTRICT),
    // so the absent row is played by a copy under an id nobody uses.
    const ghost = '00000000-0000-4000-8000-0000000000ff';
    const copy: SeedFixtureExport = {
      ...doc,
      facilities: [
        {
          row: { ...(source?.row ?? {}), id: ghost, slug: 'seed-restore-test-ghost' },
          lon: source?.lon ?? 0,
          lat: source?.lat ?? 0,
        },
      ],
    };

    const restored = await restoreSeedFixtures(client, copy, { allowedIds: [ghost] });
    expect(restored).toEqual({ republished: 0, reinserted: 1, untouched: 0 });
    const row = await client.query<{
      name: string;
      status: string;
      sport_types: string[];
      lon: number;
      lat: number;
    }>(
      `SELECT name, status::text AS status, sport_types, ST_X(geom) AS lon, ST_Y(geom) AS lat
         FROM facilities WHERE id = $1::uuid`,
      [ghost],
    );
    expect(row.rows[0]).toMatchObject({
      name: source?.row.name,
      status: 'needs_verification',
      sport_types: source?.row.sport_types,
    });
    expect(row.rows[0]?.lon).toBeCloseTo(source?.lon ?? 0, 6);
    const created = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM facility_edits
        WHERE facility_id = $1::uuid AND field = 'created' AND actor IS NULL`,
      [ghost],
    );
    expect(created.rows[0]?.n).toBe(1);
  });

  it('accounts for every foreign key to facilities, and which are append-only', async () => {
    const fks = await client.query<{ tbl: string; col: string; on_delete: string }>(
      `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confdeltype AS on_delete
         FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        WHERE c.contype = 'f' AND c.confrelid = 'facilities'::regclass`,
    );
    expect(fks.rows.map((r) => `${r.tbl}.${r.col}:${r.on_delete}`).sort()).toEqual(
      FACILITY_DEPENDENTS.map((d) => `${d.table}.facility_id:${d.onDelete}`).sort(),
    );

    const guarded = await client.query<{ tbl: string }>(
      `SELECT DISTINCT t.tgrelid::regclass::text AS tbl
         FROM pg_trigger t
        WHERE NOT t.tgisinternal AND t.tgname LIKE '%\\_no\\_delete'
          AND t.tgrelid = ANY($1::regclass[])`,
      [FACILITY_DEPENDENTS.map((d) => d.table)],
    );
    expect(guarded.rows.map((r) => r.tbl).sort()).toEqual(
      FACILITY_DEPENDENTS.filter((d) => d.appendOnly)
        .map((d) => d.table)
        .sort(),
    );
  });
});
