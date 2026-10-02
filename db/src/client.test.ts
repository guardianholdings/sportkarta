import { EventEmitter } from 'node:events';

import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { describePoolError, getDb, getPool, POOL_LIMITS } from './client';

/**
 * The shared pool fails fast instead of hanging (pre-launch audit, findings 127
 * and 159): node-postgres defaults to an unbounded wait for a connection, and
 * Postgres to `statement_timeout = 0`, so one held lock used to queue every page
 * behind it forever.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('pool limits', () => {
  it('bounds the wait for a connection and each statement', () => {
    // 0 means "no limit" to both node-postgres and Postgres, so each must be a
    // positive, finite number of milliseconds.
    for (const key of ['connectionTimeoutMillis', 'statement_timeout'] as const) {
      const value = POOL_LIMITS[key];
      expect(Number.isFinite(value) && value > 0, key).toBe(true);
    }
  });

  it('never ends a transaction for idling, because the worker idles across an SMTP send', () => {
    // The worker's mail jobs share this pool and keep their claim transaction
    // open while the relay answers — two minutes when it is unreachable. An idle
    // limit kills that session mid-send: the mail goes out, the COMMIT fails,
    // and the member is mailed again on the retry.
    expect(POOL_LIMITS).not.toHaveProperty('idle_in_transaction_session_timeout');
  });

  it('logs the class and SQLSTATE of a pool error, never its message', () => {
    // A pg error message can quote the statement, and a statement carries what
    // a member typed.
    const error = Object.assign(
      new Error('duplicate key value (email)=(someone@example.org) violates "users_email"'),
      { code: '23505' },
    );
    const described = describePoolError(error);
    expect(described).toBe('Error 23505');
    expect(described).not.toContain('example.org');
    expect(describePoolError('boom')).toBe('unknown');
  });

  it('survives a lost connection, idle or checked out, instead of crashing the process', () => {
    // An 'error' event with no listener is thrown by EventEmitter, which is an
    // uncaught exception that takes the web server, or the worker mid-run, down
    // with it. pg-pool listens to a client only while it is idle, so the
    // connection's own listener is what covers one inside a transaction.
    if (!hasDb) vi.stubEnv('DATABASE_URL', 'postgres://user:pass@127.0.0.1:1/never');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = getPool();
    const lost = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });

    // Checked out: what pg-pool hands over has no listener of the pool's own.
    const client = new EventEmitter() as unknown as pg.PoolClient;
    pool.emit('connect', client);
    expect(() => client.emit('error', lost)).not.toThrow();
    expect(logged).toHaveBeenCalledWith('[db-pool] connection error:', 'Error 57P01');

    // Idle: pg-pool re-emits on the pool what the connection already reported.
    logged.mockClear();
    expect(() => pool.emit('error', lost, client)).not.toThrow();
    expect(logged).not.toHaveBeenCalled();
  });
});

// Integration: the limits actually reach the server session. They travel as
// startup parameters, so a typo in a key would be silently ignored by the
// client — only the server's own SHOW proves they took effect.
describe.skipIf(!hasDb)('pool limits on a live connection (requires database)', () => {
  it('runs every session under the statement timeout', async () => {
    const pool = getPool();
    const statement = await pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
    expect(statement.rows[0]?.statement_timeout).toBe(`${POOL_LIMITS.statement_timeout / 1000}s`);
  });

  it('survives its connection being killed in the middle of a transaction', async () => {
    // The worker's shape: a transaction that has run a statement and is now
    // waiting on something else (the relay), when the server ends the session.
    // Without a listener on the checked-out client this was an uncaught
    // exception; vitest fails the run on one, so reaching the end is the proof.
    const logged = vi.spyOn(console, 'error');
    const reported = new Promise<void>((resolve) => {
      logged.mockImplementation(() => resolve());
    });
    const pool = getPool();

    const run = getDb().transaction(async (tx) => {
      const { rows } = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      // From ANOTHER connection, while this one sits idle in its transaction.
      await pool.query('SELECT pg_terminate_backend($1)', [rows[0]?.pid]);
      await reported;
      await tx.execute(sql`SELECT 1`);
    });

    await expect(run).rejects.toThrow();
    expect(logged).toHaveBeenCalledWith(
      '[db-pool] connection error:',
      expect.stringContaining('57P01'),
    );
    // The dead connection was dropped, and the pool still serves.
    const alive = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    expect(alive.rows[0]?.ok).toBe(1);
  });
});
