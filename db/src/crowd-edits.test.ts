import type { SQL } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  listCrowdEdits,
  MAX_BULK_REVERT,
  revertAccountEdits,
  revertCrowdEdit,
} from './crowd-edits.js';
import { renderSql } from './render-sql.js';

/**
 * The crowd-edit undo (pre-launch audit finding 53).
 *
 * Two layers. The statement-level block below runs everywhere and pins what a
 * revert may and may not write. The integration block runs against real
 * Postgres, because the whole mechanism is jsonb equality between a live column
 * and what facility_edits recorded — the part a fake cannot prove.
 *
 * facility_edits is append-only (triggers, 0001), so the audit rows these tests
 * write STAY. A facility is therefore BORROWED rather than created — a created
 * one could never be deleted again (RESTRICT) and would drift the statistics
 * views stats-reconcile checks — and every column the tests touch is put back
 * after each test. Actor ids carry the run's timestamp so a re-run against the
 * same dev database never counts a previous run's edits.
 */

/** Records every statement; answers reads from a scripted queue. */
function fakeDb(responses: Record<string, unknown>[][] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const queue = [...responses];
  const runner = {
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows: queue.shift() ?? [] });
    },
  };
  return {
    statements,
    ...runner,
    transaction<T>(callback: (tx: typeof runner) => Promise<T>): Promise<T> {
      return callback(runner);
    },
  };
}

const FACILITY = '00000000-0000-4000-8000-000000000001';

describe('revertCrowdEdit (statements)', () => {
  it('undoes a crowd-ADDED facility by taking it off the map, not by deleting it', async () => {
    const db = fakeDb([
      [{ facility_id: FACILITY, field: 'created', status: 'needs_verification' }],
    ]);
    const result = await revertCrowdEdit(db, { editId: 7, actorId: 'admin_1' });

    expect(result.outcome).toBe('reverted');
    const text = db.statements.map((s) => `${s.sql} ${JSON.stringify(s.params)}`).join('\n');
    expect(text).toMatch(/UPDATE facilities SET status = 'gone'/);
    expect(text).not.toMatch(/DELETE/i);
    // The audit row names the real column, so the merge policy sees it.
    expect(text).toMatch(/INSERT INTO facility_edits/);
    expect(text).toContain('admin_1');
    // The previous status is recorded as the audit row's old value.
    expect(db.statements[2]?.params).toContain('"needs_verification"');
  });

  it('writes nothing for an edit that changed no column', async () => {
    const db = fakeDb([[{ facility_id: FACILITY, field: 'verified', at_new: true }]]);
    const result = await revertCrowdEdit(db, { editId: 7, actorId: 'admin_1' });

    expect(result.outcome).toBe('not_revertable');
    expect(db.statements).toHaveLength(1);
  });

  it('never clobbers a value somebody changed since', async () => {
    const db = fakeDb([
      [{ facility_id: FACILITY, field: 'access', at_new: false, at_old: false, old_value: 'free' }],
    ]);
    const result = await revertCrowdEdit(db, { editId: 7, actorId: 'admin_1' });

    expect(result.outcome).toBe('superseded');
    expect(db.statements).toHaveLength(1);
  });

  it('refuses to empty a column that can never be empty', async () => {
    const db = fakeDb([
      [{ facility_id: FACILITY, field: 'access', at_new: true, at_old: false, old_value: null }],
    ]);
    expect((await revertCrowdEdit(db, { editId: 7, actorId: 'a' })).outcome).toBe('not_revertable');
    expect(db.statements).toHaveLength(1);
  });

  it('only ever reads crowd edits, and locks the facility it will write', async () => {
    const db = fakeDb([[]]);
    expect((await revertCrowdEdit(db, { editId: 7, actorId: 'a' })).outcome).toBe('not_found');
    expect(db.statements[0]?.sql).toMatch(/e\.source = 'crowd'/);
    expect(db.statements[0]?.sql).toMatch(/FOR UPDATE OF f/);
  });

  it('rejects a nonsense id without a query', async () => {
    const db = fakeDb();
    expect((await revertCrowdEdit(db, { editId: -1, actorId: 'a' })).outcome).toBe('not_found');
    expect(db.statements).toHaveLength(0);
  });
});

describe('revertAccountEdits (statements)', () => {
  it('walks the account’s edits newest first, bounded, in one transaction', async () => {
    const db = fakeDb([[]]);
    await revertAccountEdits(db, { accountId: 'vandal', withinHours: 24, actorId: 'admin_1' });

    const first = db.statements[0];
    expect(first?.sql).toMatch(/ORDER BY id DESC/);
    expect(first?.sql).toMatch(/source = 'crowd'/);
    expect(first?.params).toContain(MAX_BULK_REVERT + 1);
  });

  it('does nothing without an account or a window', async () => {
    const db = fakeDb();
    await revertAccountEdits(db, { accountId: ' ', withinHours: 24, actorId: 'a' });
    await revertAccountEdits(db, { accountId: 'x', withinHours: 0, actorId: 'a' });
    expect(db.statements).toHaveLength(0);
  });
});

const hasDb = Boolean(process.env.DATABASE_URL);

type Runner = Parameters<typeof revertCrowdEdit>[0];

interface Borrowed {
  id: string;
  access: string;
  surface: string | null;
  lighting: boolean | null;
  covered: boolean;
  sport_types: string[];
  status: string;
  condition: string | null;
  condition_reported_at: Date | null;
}

const RUN = String(Date.now());
const ADMIN = `e2e_crowd_admin_${RUN}`;

describe.skipIf(!hasDb)('crowd-edit revert (requires running database)', () => {
  let client: pg.Client;
  let db: Runner;
  let original: Borrowed;

  const actor = (name: string) => `e2e_crowd_${name}_${RUN}`;

  async function edit(
    who: string,
    field: string,
    oldValue: unknown,
    newValue: unknown,
    distanceM: number | null = 4200,
  ): Promise<number> {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value, distance_m)
       VALUES ($1::uuid, $2, 'crowd', $3, $4::jsonb, $5::jsonb, $6) RETURNING id`,
      [original.id, who, field, JSON.stringify(oldValue), JSON.stringify(newValue), distanceM],
    );
    return Number(inserted.rows[0]?.id);
  }

  async function facility(): Promise<Borrowed> {
    const row = await client.query<Borrowed>(
      `SELECT id, access::text AS access, surface, lighting, covered, sport_types,
              status::text AS status, condition::text AS condition, condition_reported_at
       FROM facilities WHERE id = $1::uuid`,
      [original.id],
    );
    return row.rows[0] as Borrowed;
  }

  async function lastAdminEdit(): Promise<Record<string, unknown> | undefined> {
    const row = await client.query(
      `SELECT field, old_value, new_value, source::text AS source, distance_m
       FROM facility_edits WHERE facility_id = $1::uuid AND actor = $2
       ORDER BY id DESC LIMIT 1`,
      [original.id, ADMIN],
    );
    return row.rows[0] as Record<string, unknown> | undefined;
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const { drizzle } = await import('drizzle-orm/node-postgres');
    db = drizzle(client) as unknown as Runner;

    // The NEWEST live facility: other suites borrow the oldest, and although
    // files run serially here, not sharing keeps each suite's story its own.
    const picked = await client.query<Borrowed>(
      `SELECT id, access::text AS access, surface, lighting, covered, sport_types,
              status::text AS status, condition::text AS condition, condition_reported_at
       FROM facilities WHERE status <> 'gone'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    );
    if (!picked.rows[0]) throw new Error('need at least one facility');
    original = picked.rows[0];

    await client.query(
      `INSERT INTO users (id, display_name, email, role)
       VALUES ($1, 'Вандал Тест', $2, 'user'), ($3, 'Админ Тест', $4, 'admin')`,
      [actor('named'), `${actor('named')}@example.test`, ADMIN, `${ADMIN}@example.test`],
    );
  });

  afterEach(async () => {
    // Put back every column a test touched. Direct UPDATE, deliberately without
    // an audit row: this is fixture teardown, not an edit.
    await client.query(
      `UPDATE facilities
          SET access = $2::facility_access, surface = $3, lighting = $4, covered = $5,
              sport_types = $6::text[], status = $7::facility_status,
              condition = $8::facility_condition, condition_reported_at = $9
        WHERE id = $1::uuid`,
      [
        original.id,
        original.access,
        original.surface,
        original.lighting,
        original.covered,
        original.sport_types,
        original.status,
        original.condition,
        original.condition_reported_at,
      ],
    );
  });

  afterAll(async () => {
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[actor('named'), ADMIN]]);
    await client.end();
  });

  const ACCESS = ['free', 'paid', 'restricted', 'school'];

  it('restores the column and appends a compensating audit row', async () => {
    const vandalised = ACCESS.find((a) => a !== original.access) as string;
    await client.query(`UPDATE facilities SET access = $2::facility_access WHERE id = $1::uuid`, [
      original.id,
      vandalised,
    ]);
    const editId = await edit(actor('one'), 'access', original.access, vandalised);

    const result = await revertCrowdEdit(db, { editId, actorId: ADMIN });

    expect(result.outcome).toBe('reverted');
    expect((await facility()).access).toBe(original.access);
    expect(await lastAdminEdit()).toEqual({
      field: 'access',
      old_value: vandalised,
      new_value: original.access,
      source: 'crowd',
      distance_m: null,
    });
    // The vandal's own row is untouched: the log is append-only.
    const kept = await client.query(`SELECT new_value FROM facility_edits WHERE id = $1`, [editId]);
    expect(kept.rows[0]?.new_value).toBe(vandalised);

    // A second click finds the value already back and writes nothing.
    expect((await revertCrowdEdit(db, { editId, actorId: ADMIN })).outcome).toBe('already');
  });

  it('leaves a later correction by somebody else in place', async () => {
    // Lighting is tri-state, so the three values below are always distinct:
    // what it was, what the vandal wrote, and a third a later visitor chose.
    const [vandalised, corrected] = [true, false, null].filter((v) => v !== original.lighting) as [
      boolean | null,
      boolean | null,
    ];
    await client.query(`UPDATE facilities SET lighting = $2 WHERE id = $1::uuid`, [
      original.id,
      vandalised,
    ]);
    const editId = await edit(actor('two'), 'lighting', original.lighting, vandalised);
    await client.query(`UPDATE facilities SET lighting = $2 WHERE id = $1::uuid`, [
      original.id,
      corrected,
    ]);
    await edit(actor('fixer'), 'lighting', vandalised, corrected, 10);

    const result = await revertCrowdEdit(db, { editId, actorId: ADMIN });

    expect(result.outcome).toBe('superseded');
    expect((await facility()).lighting).toBe(corrected);
  });

  it('unwinds everything one account did, newest first, and stops at nobody else', async () => {
    const vandal = actor('bulk');
    const first = ACCESS.find((a) => a !== original.access) as string;
    const second = ACCESS.find((a) => a !== original.access && a !== first) as string;
    const sports = original.sport_types.join() === 'tennis' ? ['volleyball'] : ['tennis'];

    await client.query(`UPDATE facilities SET access = $2::facility_access WHERE id = $1::uuid`, [
      original.id,
      first,
    ]);
    await edit(vandal, 'access', original.access, first);
    await client.query(`UPDATE facilities SET access = $2::facility_access WHERE id = $1::uuid`, [
      original.id,
      second,
    ]);
    await edit(vandal, 'access', first, second);
    await client.query(`UPDATE facilities SET sport_types = $2::text[] WHERE id = $1::uuid`, [
      original.id,
      sports,
    ]);
    await edit(vandal, 'sport_types', original.sport_types, sports);
    // Not a column change: ignored by the bulk revert, never counted.
    await edit(vandal, 'verified', null, true);

    const result = await revertAccountEdits(db, {
      accountId: vandal,
      withinHours: 1,
      actorId: ADMIN,
    });

    expect(result).toMatchObject({
      considered: 3,
      reverted: 3,
      superseded: 0,
      truncated: false,
      facilityIds: [original.id],
    });
    const after = await facility();
    expect(after.access).toBe(original.access);
    expect(after.sport_types).toEqual(original.sport_types);
  });

  it('clears the condition and its timestamp together when going back to "no report"', async () => {
    const reported = original.condition === 'unusable' ? 'poor' : 'unusable';
    await client.query(
      `UPDATE facilities SET condition = $2::facility_condition, condition_reported_at = now()
       WHERE id = $1::uuid`,
      [original.id, reported],
    );
    const editId = await edit(actor('cond'), 'condition', original.condition, reported, 20);

    expect((await revertCrowdEdit(db, { editId, actorId: ADMIN })).outcome).toBe('reverted');
    const after = await facility();
    expect(after.condition).toBe(original.condition);
    // facilities_condition_pair: both null, or both set.
    expect(after.condition_reported_at === null).toBe(original.condition === null);
  });

  it('lists crowd edits newest first with who made them and from how far', async () => {
    const named = actor('named');
    const older = await edit(named, 'surface', original.surface, 'grass', 3100);
    const newer = await edit(named, 'covered', original.covered, !original.covered, null);

    const rows = await listCrowdEdits(db, { accountId: named, withinHours: 1 });

    expect(rows.map((r) => r.id)).toEqual([newer, older]);
    expect(rows[0]).toMatchObject({ actorName: 'Вандал Тест', actorRole: 'user', distanceM: null });
    expect(rows[1]).toMatchObject({ field: 'surface', newValue: 'grass', distanceM: 3100 });
    expect(rows[1]?.facilityId).toBe(original.id);
  });
});
