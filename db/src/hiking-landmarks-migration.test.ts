import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Migration 0036 against the real schema: the twenty curated hiking landmarks
 * that 0016 inserted as `active` are relabelled `needs_verification`, audited
 * once each with a NULL actor and their own `osm` source, and — the part that
 * matters — a landmark a PERSON has written to is left alone, as is a landmark
 * a moderator marked `gone` and every row that is not a curated landmark.
 * On an empty database 0016 and 0036 run in one batch, so in CI the landmarks
 * are already `needs_verification`; each test first puts them back into the
 * pre-0036 production state, runs the migration's own statements, and rolls
 * everything back.
 */

const url = process.env.DATABASE_URL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, '..', 'migrations', '0036_hiking_landmarks_unverified.sql');

/** 0016 inserts exactly twenty; any other count is a different database. */
const LANDMARK_COUNT = 20;

/** The rollback documented in the migration's header, whitespace aside. */
const ROLLBACK = `UPDATE facilities SET status = 'active'
   WHERE attrs->>'curated' = 'hiking_landmark'
     AND source = 'osm'
     AND status = 'needs_verification'`;

/** The statements exactly as drizzle's migrator splits them. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

describe.skipIf(!url)('migration 0036 — hiking landmarks lose an unearned `active`', () => {
  let client: pg.Client;
  let landmarks: [string, ...string[]];

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
      `SELECT id FROM facilities
        WHERE attrs->>'curated' = 'hiking_landmark' AND source = 'osm'
        ORDER BY slug`,
    );
    const ids = found.rows.map((r) => r.id);
    if (ids.length !== LANDMARK_COUNT) {
      throw new Error(
        `fixture: expected the ${String(LANDMARK_COUNT)} landmarks of 0016, found ` +
          `${String(ids.length)} — run pnpm db:migrate`,
      );
    }
    landmarks = ids as [string, ...string[]];
    // The pre-0036 production state.
    await client.query(`UPDATE facilities SET status = 'active' WHERE id = ANY($1::uuid[])`, [
      landmarks,
    ]);
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  async function migrate(): Promise<void> {
    for (const statement of migrationStatements()) await client.query(statement);
  }

  async function statusOf(id: string): Promise<string | undefined> {
    const result = await client.query<{ status: string }>(
      `SELECT status FROM facilities WHERE id = $1::uuid`,
      [id],
    );
    return result.rows[0]?.status;
  }

  async function statuses(): Promise<Map<string, string>> {
    const result = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM facilities WHERE id = ANY($1::uuid[])`,
      [landmarks],
    );
    return new Map(result.rows.map((r) => [r.id, r.status]));
  }

  /** This migration's audit row (osm, no actor, active → needs_verification), per facility. */
  async function relabelAudits(): Promise<Map<string, number>> {
    const result = await client.query<{ facility_id: string; n: string }>(
      `SELECT facility_id, count(*) AS n FROM facility_edits
        WHERE field = 'status' AND actor IS NULL AND source = 'osm'
          AND old_value = '"active"'::jsonb AND new_value = '"needs_verification"'::jsonb
        GROUP BY facility_id`,
    );
    return new Map(result.rows.map((r) => [r.facility_id, Number(r.n)]));
  }

  it('relabels every untouched landmark, audits each once, and is idempotent', async () => {
    // Other suites may attach attributed edits to a borrowed facility, and
    // facility_edits is append-only — so which landmarks count as "touched by
    // a person" is read, not assumed.
    const touched = await client.query<{ facility_id: string }>(
      `SELECT DISTINCT facility_id FROM facility_edits
        WHERE facility_id = ANY($1::uuid[]) AND actor IS NOT NULL`,
      [landmarks],
    );
    const vouched = new Set(touched.rows.map((r) => r.facility_id));
    expect(
      landmarks.filter((id) => !vouched.has(id)).length,
      'every landmark has a person edit; nothing left to prove',
    ).toBeGreaterThan(0);

    const auditsBefore = await relabelAudits();
    await migrate();

    const after = await statuses();
    const auditsAfter = await relabelAudits();
    for (const id of landmarks) {
      const relabelled = !vouched.has(id);
      expect(after.get(id), id).toBe(relabelled ? 'needs_verification' : 'active');
      expect((auditsAfter.get(id) ?? 0) - (auditsBefore.get(id) ?? 0), id).toBe(relabelled ? 1 : 0);
    }

    // A second run finds nothing `active` to correct and writes nothing.
    await migrate();
    expect(await relabelAudits()).toEqual(auditsAfter);
  });

  it('never overrides a person who has been there', async () => {
    const [vouchedId] = landmarks;
    // An on-site verification of an already-active row writes field edits and
    // no status edit — this attributed row is the only trace, and it must hold.
    await client.query(
      `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
       VALUES ($1, 'migration-0036-test', 'crowd', 'surface', NULL, '"asphalt"'::jsonb)`,
      [vouchedId],
    );
    await migrate();
    expect(await statusOf(vouchedId)).toBe('active');
  });

  it('never resurrects a landmark a moderator marked gone', async () => {
    const [goneId] = landmarks;
    await client.query(`UPDATE facilities SET status = 'gone' WHERE id = $1::uuid`, [goneId]);
    await migrate();
    expect(await statusOf(goneId)).toBe('gone');
  });

  it('touches only curated landmarks, never another active place', async () => {
    const [untaggedId] = landmarks;
    await client.query(`UPDATE facilities SET attrs = attrs - 'curated' WHERE id = $1::uuid`, [
      untaggedId,
    ]);
    const other = await client.query<{ id: string }>(
      `SELECT id FROM facilities
        WHERE attrs->>'curated' IS DISTINCT FROM 'hiking_landmark' AND status <> 'gone'
        ORDER BY id LIMIT 1`,
    );
    const otherId = other.rows[0]?.id;
    if (otherId === undefined) {
      throw new Error('fixture: no facility besides the landmarks — run pnpm db:seed');
    }
    await client.query(`UPDATE facilities SET status = 'active' WHERE id = $1::uuid`, [otherId]);

    const auditsBefore = await relabelAudits();
    await migrate();
    const auditsAfter = await relabelAudits();

    for (const id of [untaggedId, otherId]) {
      expect(await statusOf(id), id).toBe('active');
      expect(auditsAfter.get(id) ?? 0, id).toBe(auditsBefore.get(id) ?? 0);
    }
  });

  it('documents a rollback that restores the relabelled landmarks and nothing else', async () => {
    const header = readFileSync(MIGRATION, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('--'))
      .map((line) => line.replace(/^--/, ''))
      .join(' ');
    expect(squash(header)).toContain(squash(ROLLBACK));

    const [goneId, ...rest] = landmarks;
    await client.query(`UPDATE facilities SET status = 'gone' WHERE id = $1::uuid`, [goneId]);
    await migrate();
    await client.query(ROLLBACK);

    const after = await statuses();
    expect(after.get(goneId)).toBe('gone');
    for (const id of rest) expect(after.get(id), id).toBe('active');
  });
});
