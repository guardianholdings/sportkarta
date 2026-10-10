import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Migration 0037 against the real schema: a contribution stored at the clamp
 * because the parser read "no location" as 0°N 0°E gets back the NULL that 0029
 * reserves for "no position offered" — in facility_edits (crowd rows only,
 * under the append-only trigger, which is on again afterwards) and in
 * facility_reports — while every real distance, every honest NULL and every
 * non-crowd row is left exactly as it was. Each test runs the migration's own
 * statements inside a transaction and rolls everything back.
 */

const url = process.env.DATABASE_URL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, '..', 'migrations', '0037_contribution_location_off.sql');

/** The writers' ceiling (MAX_RECORDED_DISTANCE_M), where the zeros landed. */
const CLAMP = 1_000_000;

/** The statements exactly as drizzle's migrator splits them. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

describe('migration 0037 — the shape of the trigger lift', () => {
  it('lifts one trigger around exactly one UPDATE, and bounds and resets the lock wait', () => {
    const statements = migrationStatements().map((statement) =>
      // The header is comment lines; keep only the SQL of each statement.
      statement
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    expect(statements[0]).toBe(`SET LOCAL lock_timeout = '3s';`);
    expect(statements.at(-1)).toBe('SET LOCAL lock_timeout = DEFAULT;');

    const disable = statements.findIndex((s) => /DISABLE TRIGGER/.test(s));
    const enable = statements.findIndex((s) => /ENABLE TRIGGER/.test(s));
    expect(statements[disable]).toBe(
      'ALTER TABLE "facility_edits" DISABLE TRIGGER "facility_edits_no_update";',
    );
    expect(statements[enable]).toBe(
      'ALTER TABLE "facility_edits" ENABLE TRIGGER "facility_edits_no_update";',
    );
    // Nothing but the one UPDATE of facility_edits runs while it is off.
    expect(enable - disable).toBe(2);
    expect(statements[disable + 1]).toMatch(/^UPDATE "facility_edits" SET "distance_m" = NULL /);
    expect(statements.filter((s) => /TRIGGER/.test(s))).toHaveLength(2);
    // The reports go first, so the facility_edits write lock waits on nothing
    // but its own scan.
    const reports = statements.findIndex((s) => /^UPDATE "facility_reports"/.test(s));
    expect(reports).toBeGreaterThan(0);
    expect(reports).toBeLessThan(disable);
  });
});

describe.skipIf(!url)('migration 0037 — location off is NULL, not 1 000 km', () => {
  let client: pg.Client;
  let facilityId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    const found = await client.query<{ id: string }>(
      `SELECT id FROM facilities ORDER BY created_at, id LIMIT 1`,
    );
    const id = found.rows[0]?.id;
    if (!id) throw new Error('fixture: no facility to attach rows to — run pnpm db:seed');
    facilityId = id;
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  async function migrate(): Promise<void> {
    for (const statement of migrationStatements()) await client.query(statement);
  }

  async function edit(source: 'crowd' | 'osm', distanceM: number | null): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value, distance_m)
       VALUES ($1::uuid, $2, $3::facility_source, 'condition', NULL, '"good"'::jsonb, $4)
       RETURNING id::text AS id`,
      [facilityId, source === 'crowd' ? 'migration-0037-test' : null, source, distanceM],
    );
    return result.rows[0]?.id ?? '';
  }

  async function report(distanceM: number | null): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO facility_reports (facility_id, issue, distance_m)
       VALUES ($1::uuid, 'other', $2)
       RETURNING id::text AS id`,
      [facilityId, distanceM],
    );
    return result.rows[0]?.id ?? '';
  }

  async function editDistance(id: string): Promise<number | null> {
    const result = await client.query<{ distance_m: number | null }>(
      `SELECT distance_m FROM facility_edits WHERE id = $1::bigint`,
      [id],
    );
    return result.rows[0]?.distance_m ?? null;
  }

  async function reportDistance(id: string): Promise<number | null> {
    const result = await client.query<{ distance_m: number | null }>(
      `SELECT distance_m FROM facility_reports WHERE id = $1::uuid`,
      [id],
    );
    return result.rows[0]?.distance_m ?? null;
  }

  it('gives the zeros back their NULL, in edits and in reports', async () => {
    const locationOff = await edit('crowd', CLAMP);
    const reportedOff = await report(CLAMP);
    await migrate();
    expect(await editDistance(locationOff)).toBeNull();
    expect(await reportDistance(reportedOff)).toBeNull();
  });

  it('leaves every real distance, every honest NULL and every non-crowd row alone', async () => {
    const onSite = await edit('crowd', 120);
    const farButMeasured = await edit('crowd', CLAMP - 1);
    const honestNull = await edit('crowd', null);
    // No importer writes a distance; a row that has one anyway is not ours to fix.
    const notCrowd = await edit('osm', CLAMP);
    const reportOnSite = await report(300);
    const reportNull = await report(null);

    await migrate();

    expect(await editDistance(onSite)).toBe(120);
    expect(await editDistance(farButMeasured)).toBe(CLAMP - 1);
    expect(await editDistance(honestNull)).toBeNull();
    expect(await editDistance(notCrowd)).toBe(CLAMP);
    expect(await reportDistance(reportOnSite)).toBe(300);
    expect(await reportDistance(reportNull)).toBeNull();
  });

  it('leaves facility_edits append-only again', async () => {
    const row = await edit('crowd', CLAMP);
    await migrate();

    // Each refusal aborts its statement; a savepoint keeps the test's own
    // transaction alive for the next check.
    for (const statement of [
      `UPDATE facility_edits SET distance_m = 5 WHERE id = $1::bigint`,
      `DELETE FROM facility_edits WHERE id = $1::bigint`,
    ]) {
      await client.query('SAVEPOINT refused');
      await expect(client.query(statement, [row])).rejects.toThrow(/append-only/);
      await client.query('ROLLBACK TO SAVEPOINT refused');
    }

    const triggers = await client.query<{ tgname: string; tgenabled: string }>(
      `SELECT tgname, tgenabled FROM pg_trigger
        WHERE tgrelid = 'facility_edits'::regclass AND NOT tgisinternal
        ORDER BY tgname`,
    );
    expect(triggers.rows).toEqual([
      { tgname: 'facility_edits_no_delete', tgenabled: 'O' },
      { tgname: 'facility_edits_no_truncate', tgenabled: 'O' },
      { tgname: 'facility_edits_no_update', tgenabled: 'O' },
    ]);
  });

  it('says in the catalogue what an old NULL can also mean', async () => {
    await migrate();
    for (const table of ['facility_edits', 'facility_reports']) {
      const result = await client.query<{ comment: string | null }>(
        `SELECT col_description($1::regclass, attnum) AS comment
           FROM pg_attribute WHERE attrelid = $1::regclass AND attname = 'distance_m'`,
        [table],
      );
      const comment = result.rows[0]?.comment ?? '';
      expect(comment, table).toMatch(/NULL = no position offered; never a coordinate\./);
      expect(comment, table).toMatch(/before migration 0037, NULL can also be a reading/);
    }
  });
});
