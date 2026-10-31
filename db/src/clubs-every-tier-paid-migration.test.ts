import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { makeClub } from './clubs/test-fixtures.js';

/**
 * Migration 0060 against the real schema: every tier is paid (2026-10-31), so
 * an approved community club that never needed a date gets the trial it would
 * get if approved today — and nothing else moves: not a pending club, not a
 * standard club the operator withdrew, not a club already in a trial or paid.
 * Each test runs the migration's own statements inside a transaction and
 * rolls everything back.
 */

const url = process.env.DATABASE_URL;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, '..', 'migrations', '0060_clubs_every_tier_paid.sql');

/** The statements exactly as drizzle's migrator splits them. */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** A statement without its comment lines, on one line. */
function sqlOf(statement: string): string {
  return statement
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('migration 0060 — the shape', () => {
  it('bounds the lock wait and the statement, and resets both', () => {
    const statements = migrationStatements().map(sqlOf);
    expect(statements.slice(0, 2)).toEqual([
      `SET LOCAL lock_timeout = '3s';`,
      `SET LOCAL statement_timeout = '30s';`,
    ]);
    expect(statements.slice(-2)).toEqual([
      'SET LOCAL lock_timeout = DEFAULT;',
      'SET LOCAL statement_timeout = DEFAULT;',
    ]);
    expect(statements.filter((s) => /^UPDATE /.test(s))).toHaveLength(1);
  });
});

describe.skipIf(!url)('migration 0060 — a trial for the approved community clubs', () => {
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
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  async function migrate(): Promise<number> {
    let updated = 0;
    for (const statement of migrationStatements()) {
      const result = await client.query(statement);
      if (/^UPDATE /.test(sqlOf(statement))) updated = result.rowCount ?? 0;
    }
    return updated;
  }

  async function dates(clubId: string): Promise<{ trial: string | null; paid: string | null }> {
    const result = await client.query<{ trial: string | null; paid: string | null }>(
      `SELECT to_char(trial_ends_on, 'YYYY-MM-DD') AS trial,
              to_char(paid_until, 'YYYY-MM-DD') AS paid
         FROM clubs WHERE id = $1::uuid`,
      [clubId],
    );
    return result.rows[0] ?? { trial: null, paid: null };
  }

  it('dates every approved community club with neither date, and nothing else', async () => {
    const expected = String(
      (
        await client.query<{ d: string }>(
          `SELECT to_char((now() AT TIME ZONE 'Europe/Sofia')::date + 30, 'YYYY-MM-DD') AS d`,
        )
      ).rows[0]?.d,
    );
    const active = await makeClub(client, 'm60-active', { tier: 'community' });
    const suspended = await makeClub(client, 'm60-suspended', {
      tier: 'community',
      status: 'suspended',
    });
    const archived = await makeClub(client, 'm60-archived', {
      tier: 'community',
      status: 'archived',
    });
    const pending = await makeClub(client, 'm60-pending', { tier: 'community', status: 'pending' });
    const withdrawn = await makeClub(client, 'm60-withdrawn', { tier: 'standard' });
    const paying = await makeClub(client, 'm60-paying', { tier: 'community', paid: true });
    const trialling = await makeClub(client, 'm60-trialling', { tier: 'community' });
    await client.query(`UPDATE clubs SET trial_ends_on = current_date + 3 WHERE id = $1::uuid`, [
      trialling.clubId,
    ]);
    const before = {
      paying: await dates(paying.clubId),
      trialling: await dates(trialling.clubId),
    };

    expect(await migrate()).toBeGreaterThanOrEqual(3);

    for (const club of [active, suspended, archived]) {
      expect(await dates(club.clubId)).toEqual({ trial: expected, paid: null });
    }
    expect(await dates(pending.clubId)).toEqual({ trial: null, paid: null });
    expect(await dates(withdrawn.clubId)).toEqual({ trial: null, paid: null });
    expect(await dates(paying.clubId)).toEqual(before.paying);
    expect(await dates(trialling.clubId)).toEqual(before.trialling);

    // Idempotent: a second run finds nothing left to date.
    expect(await migrate()).toBe(0);
  });
});
