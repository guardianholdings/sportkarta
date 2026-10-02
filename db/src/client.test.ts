import { afterEach, describe, expect, it, vi } from 'vitest';

import { describePoolError, getPool, POOL_LIMITS } from './client';

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
  it('bounds the wait for a connection, each statement, and an abandoned transaction', () => {
    // 0 means "no limit" to both node-postgres and Postgres, so each must be a
    // positive, finite number of milliseconds.
    for (const key of [
      'connectionTimeoutMillis',
      'statement_timeout',
      'idle_in_transaction_session_timeout',
    ] as const) {
      const value = POOL_LIMITS[key];
      expect(Number.isFinite(value) && value > 0, key).toBe(true);
    }
    // A statement must be allowed to finish before the transaction around it is
    // declared abandoned, or the idle timeout would be the effective limit.
    expect(POOL_LIMITS.idle_in_transaction_session_timeout).toBeGreaterThan(
      POOL_LIMITS.statement_timeout,
    );
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

  it('survives an idle client error instead of crashing the process', () => {
    // An 'error' event with no listener is thrown by EventEmitter, which in the
    // web server is an uncaught exception that takes every request down with it.
    if (!hasDb) vi.stubEnv('DATABASE_URL', 'postgres://user:pass@127.0.0.1:1/never');
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = getPool();
    expect(pool.listenerCount('error')).toBeGreaterThan(0);
    const lost = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    });
    expect(() => pool.emit('error', lost)).not.toThrow();
    expect(logged).toHaveBeenCalledWith('[db-pool] idle client error:', 'Error 57P01');
  });
});

// Integration: the limits actually reach the server session. They travel as
// startup parameters, so a typo in a key would be silently ignored by the
// client — only the server's own SHOW proves they took effect.
describe.skipIf(!hasDb)('pool limits on a live connection (requires database)', () => {
  it('runs every session under the statement and idle-transaction timeouts', async () => {
    const pool = getPool();
    const statement = await pool.query<{ statement_timeout: string }>('SHOW statement_timeout');
    const idle = await pool.query<{ idle_in_transaction_session_timeout: string }>(
      'SHOW idle_in_transaction_session_timeout',
    );
    expect(statement.rows[0]?.statement_timeout).toBe(`${POOL_LIMITS.statement_timeout / 1000}s`);
    expect(idle.rows[0]?.idle_in_transaction_session_timeout).toBe(
      `${POOL_LIMITS.idle_in_transaction_session_timeout / 1000}s`,
    );
  });
});
