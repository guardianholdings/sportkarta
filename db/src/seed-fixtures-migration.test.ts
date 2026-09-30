import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Migration 0031 against the real schema: the five seed fixtures that reached
 * production as `active` are relabelled `needs_verification`, audited once
 * each with a NULL actor, and — the part that matters — a row a PERSON has
 * written to is left alone. CI's database was built by the current seed, so
 * the fixtures are already `needs_verification` there; each test first puts
 * them back into the pre-0031 production state, runs the migration's own
 * statements, and rolls everything back.
 */

const url = process.env.DATABASE_URL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, '..', 'migrations', '0031_seed_fixtures_unverified.sql');

const FIXTURES = [1, 2, 3, 4, 5].map((n) => `00000000-0000-4000-8000-00000000000${String(n)}`);

/** The statements exactly as drizzle's migrator splits them. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

describe.skipIf(!url)('migration 0031 — seed fixtures lose an unearned `active`', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
    const present = await client.query<{ id: string }>(
      `SELECT id FROM facilities WHERE id = ANY($1::uuid[]) AND attrs->>'seed' = 'true'`,
      [FIXTURES],
    );
    if (present.rows.length !== FIXTURES.length) {
      throw new Error('fixture: the seed facilities 1–5 are missing — run pnpm db:seed');
    }
    // The pre-0031 production state.
    await client.query(`UPDATE facilities SET status = 'active' WHERE id = ANY($1::uuid[])`, [
      FIXTURES,
    ]);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  async function migrate(): Promise<void> {
    for (const statement of migrationStatements()) await client.query(statement);
  }

  async function statuses(): Promise<Map<string, string>> {
    const result = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM facilities WHERE id = ANY($1::uuid[])`,
      [FIXTURES],
    );
    return new Map(result.rows.map((r) => [r.id, r.status]));
  }

  async function relabelAudits(): Promise<Map<string, number>> {
    const result = await client.query<{ facility_id: string; n: string }>(
      `SELECT facility_id, count(*) AS n FROM facility_edits
        WHERE facility_id = ANY($1::uuid[]) AND field = 'status' AND actor IS NULL
          AND old_value = '"active"'::jsonb AND new_value = '"needs_verification"'::jsonb
        GROUP BY facility_id`,
      [FIXTURES],
    );
    return new Map(result.rows.map((r) => [r.facility_id, Number(r.n)]));
  }

  it('relabels the untouched fixtures, audits each once, and is idempotent', async () => {
    // Other suites attach attributed edits to a borrowed seed facility, and
    // facility_edits is append-only — so which fixtures count as "touched by a
    // person" is read, not assumed.
    const touched = await client.query<{ facility_id: string }>(
      `SELECT DISTINCT facility_id FROM facility_edits
        WHERE facility_id = ANY($1::uuid[]) AND actor IS NOT NULL`,
      [FIXTURES],
    );
    const vouched = new Set(touched.rows.map((r) => r.facility_id));
    const untouched = FIXTURES.filter((id) => !vouched.has(id));
    expect(
      untouched.length,
      'every fixture has a person edit; nothing left to prove',
    ).toBeGreaterThan(0);

    const auditsBefore = await relabelAudits();
    await migrate();

    const after = await statuses();
    const auditsAfter = await relabelAudits();
    for (const id of FIXTURES) {
      const relabelled = !vouched.has(id);
      expect(after.get(id), id).toBe(relabelled ? 'needs_verification' : 'active');
      expect((auditsAfter.get(id) ?? 0) - (auditsBefore.get(id) ?? 0), id).toBe(relabelled ? 1 : 0);
    }

    // A second run finds nothing `active` to correct and writes nothing.
    await migrate();
    expect(await relabelAudits()).toEqual(auditsAfter);
  });

  it('never overrides a person who has been there', async () => {
    const [vouchedId] = FIXTURES as [string, ...string[]];
    // An on-site verification of an already-active row writes field edits and
    // no status edit — this attributed row is the only trace, and it must hold.
    await client.query(
      `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
       VALUES ($1, 'migration-0031-test', 'crowd', 'surface', NULL, '"asphalt"'::jsonb)`,
      [vouchedId],
    );
    await migrate();
    expect((await statuses()).get(vouchedId)).toBe('active');
  });

  it('touches only rows that are still marked as seed data', async () => {
    const [claimedId] = FIXTURES as [string, ...string[]];
    await client.query(`UPDATE facilities SET attrs = '{}'::jsonb WHERE id = $1`, [claimedId]);
    await migrate();
    expect((await statuses()).get(claimedId)).toBe('active');
  });
});
