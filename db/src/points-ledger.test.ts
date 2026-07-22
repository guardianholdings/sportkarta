import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The points ledger's two guarantees, proven against real Postgres:
 *
 *  1. Idempotency — an award may be retried in any pattern, concurrently or
 *     serially, and still lands exactly once. This is a UNIQUE index plus
 *     ON CONFLICT DO NOTHING, not application logic, so it holds across
 *     processes and restarts.
 *  2. Append-only — rows cannot be edited or removed, EXCEPT by the account
 *     erasure cascade. That exception is load-bearing for GDPR, so it is
 *     tested as carefully as the prohibition.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const USER_ID = 'e2e_points_user';
const OTHER_USER_ID = 'e2e_points_other';

describe.skipIf(!hasDb)('points_ledger (requires running database)', () => {
  let client: pg.Client;
  let facilityId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const facility = await client.query<{ id: string }>(
      `SELECT id FROM facilities ORDER BY created_at, id LIMIT 1`,
    );
    facilityId = facility.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  beforeEach(async () => {
    await cleanup();
    for (const [id, email] of [
      [USER_ID, 'points@example.org'],
      [OTHER_USER_ID, 'points-other@example.org'],
    ]) {
      await client.query(`INSERT INTO users (id, display_name, email) VALUES ($1, 'Тест', $2)`, [
        id,
        email,
      ]);
    }
  });

  async function cleanup(): Promise<void> {
    // Deleting the users cascades the ledger — the only way rows may leave.
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[USER_ID, OTHER_USER_ID]]);
  }

  /** The production award statement, verbatim in shape. */
  async function award(key: string, userId = USER_ID, points = 10): Promise<number> {
    const result = await client.query(
      `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key)
       VALUES ($1, 'facility_added', $2, $3::uuid, $4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [userId, points, facilityId, key],
    );
    return result.rowCount ?? 0;
  }

  async function totalFor(userId: string): Promise<number> {
    const result = await client.query<{ total: string | null }>(
      `SELECT sum(points) AS total FROM points_ledger WHERE user_id = $1`,
      [userId],
    );
    return Number(result.rows[0]?.total ?? 0);
  }

  it('awards once no matter how many times the action is retried', async () => {
    const key = `facility_added:${facilityId}`;
    const inserted = await Promise.all([award(key), award(key), award(key), award(key)]);
    // Exactly one INSERT reported a row; the rest were no-ops.
    expect(inserted.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await totalFor(USER_ID)).toBe(10);
  });

  it('holds under concurrent retries from separate connections', async () => {
    const key = `facility_added:concurrent:${facilityId}`;
    const clients = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const extra = new pg.Client({ connectionString: process.env.DATABASE_URL });
        await extra.connect();
        return extra;
      }),
    );
    try {
      const results = await Promise.all(
        clients.map((c) =>
          c.query(
            `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key)
             VALUES ($1, 'facility_added', 10, $2::uuid, $3)
             ON CONFLICT (idempotency_key) DO NOTHING`,
            [USER_ID, facilityId, key],
          ),
        ),
      );
      expect(results.reduce((sum, r) => sum + (r.rowCount ?? 0), 0)).toBe(1);
    } finally {
      await Promise.all(clients.map((c) => c.end()));
    }
    expect(await totalFor(USER_ID)).toBe(10);
  });

  it('cannot be double-awarded by any retry pattern (property)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A random interleaving of retries across two keys and two users.
        fc.array(fc.constantFrom('a', 'b'), { minLength: 1, maxLength: 12 }),
        fc.array(fc.constantFrom(USER_ID, OTHER_USER_ID), { minLength: 1, maxLength: 12 }),
        async (keySeq, userSeq) => {
          await cleanupLedgerOnly();
          const attempts = keySeq.map((k, i) => ({
            key: `prop:${k}`,
            user: userSeq[i % userSeq.length] as string,
          }));
          for (const attempt of attempts) {
            await award(attempt.key, attempt.user, 5);
          }
          // One row per distinct key, whatever the order or repetition count —
          // and the first writer of a key owns it.
          const distinctKeys = new Set(attempts.map((a) => a.key));
          const rows = await client.query<{ n: string }>(
            `SELECT count(*) AS n FROM points_ledger WHERE idempotency_key LIKE 'prop:%'`,
          );
          expect(Number(rows.rows[0]?.n)).toBe(distinctKeys.size);
        },
      ),
      { numRuns: 15 },
    );
  });

  async function cleanupLedgerOnly(): Promise<void> {
    // Ledger rows are immutable, so the only way to reset between property runs
    // is to remove the accounts and recreate them — which is itself a check
    // that the erasure path works.
    await cleanup();
    for (const [id, email] of [
      [USER_ID, 'points@example.org'],
      [OTHER_USER_ID, 'points-other@example.org'],
    ]) {
      await client.query(`INSERT INTO users (id, display_name, email) VALUES ($1, 'Тест', $2)`, [
        id,
        email,
      ]);
    }
  }

  it('refuses to rewrite or hand-delete an award', async () => {
    await award('immutable-key');
    await expect(
      client.query(
        `UPDATE points_ledger SET points = 9999 WHERE idempotency_key = 'immutable-key'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.query(`DELETE FROM points_ledger WHERE idempotency_key = 'immutable-key'`),
    ).rejects.toThrow(/append-only/);
    await expect(client.query(`TRUNCATE points_ledger`)).rejects.toThrow(/append-only/);
    expect(await totalFor(USER_ID)).toBe(10);
  });

  it('cannot be tricked into deleting by shadowing the users table', async () => {
    await award('shadow-key');
    // The trigger's escape hatch asks "is the owning account gone?". If that
    // name resolved through the caller's search_path, a temp table called
    // `users` would answer "yes" for every row and turn the GDPR exception into
    // a general delete bypass. The function pins search_path and qualifies the
    // table, so the shadow is ignored.
    const attacker = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await attacker.connect();
    try {
      await attacker.query(`CREATE TEMP TABLE users (id text)`);
      await expect(
        attacker.query(`DELETE FROM points_ledger WHERE idempotency_key = 'shadow-key'`),
      ).rejects.toThrow(/append-only/);
    } finally {
      await attacker.end();
    }
    expect(await totalFor(USER_ID)).toBe(10);
  });

  it('still lets GDPR erasure take the points with the account', async () => {
    await award('erasure-key');
    expect(await totalFor(USER_ID)).toBe(10);

    // The FK cascade is the ONLY permitted delete, and it must not be blocked
    // by the append-only trigger — otherwise erasure would fail outright.
    await client.query(`DELETE FROM users WHERE id = $1`, [USER_ID]);
    expect(await totalFor(USER_ID)).toBe(0);
  });

  it('rejects a nonsensical award outright', async () => {
    // Bounded above as well as below: rows can never be edited or deleted, so
    // a pricing bug must not be able to write an unfixable balance.
    await expect(
      client.query(
        `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key)
         VALUES ($1, 'facility_added', 1000000, $2::uuid, 'absurd-points')`,
        [USER_ID, facilityId],
      ),
    ).rejects.toThrow(/points_ledger_points_sane/);
    await expect(
      client.query(
        `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key)
         VALUES ($1, 'facility_added', 0, $2::uuid, 'zero-points')`,
        [USER_ID, facilityId],
      ),
    ).rejects.toThrow(/points_ledger_points_sane/);
    await expect(
      client.query(
        `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key)
         VALUES ($1, 'facility_added', 10, $2::uuid, '   ')`,
        [USER_ID, facilityId],
      ),
    ).rejects.toThrow(/points_ledger_key_not_blank/);
  });
});
