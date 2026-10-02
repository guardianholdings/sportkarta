import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

let pool: pg.Pool | undefined;

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required (see .env.example)');
  }
  return url;
}

/**
 * The limits every connection from this pool runs under.
 *
 * node-postgres defaults are "wait forever" on every axis: no bound on how long
 * a request queues for one of the ten connections, and Postgres itself ships
 * with `statement_timeout = 0`. On a single web process that is the difference
 * between a slow page and a site that hangs — a migration holding a lock (the
 * deploy runs them while the old web container is still serving), or a burst
 * of more than ten concurrent requests, used to park every page, sign-in and
 * `/api/health` behind it with no end. Now each of those fails within seconds
 * with an error the page can show, and the connection comes back.
 *
 * The numbers are deliberately generous next to the real costs (the heaviest
 * interactive query measured on production is ~7 ms; the worker's jobs run
 * per-member statements of the same order), so only a stuck statement ever
 * reaches them:
 *
 * - `connectionTimeoutMillis` — how long a caller may wait for a connection,
 *   whether it is being opened or queued behind a busy pool.
 * - `statement_timeout` — server-side, so Postgres cancels the statement itself
 *   (lock waits included) rather than the client abandoning a query that keeps
 *   running and keeps its locks.
 *
 * DELIBERATELY NOT `idle_in_transaction_session_timeout`. This pool is not only
 * the web's: the worker reaches it through `getDb()` too, and its mail jobs
 * hold a transaction open ACROSS the SMTP exchange by design — claim, send,
 * commit, so a failed send rolls its claim back and is retried. An unreachable
 * relay takes nodemailer two minutes to give up on, so any idle limit short
 * enough to matter would have Postgres kill the session in the middle of a
 * send: the mail goes out, the COMMIT fails on the dead connection, and the
 * member is mailed again on the retry. The web's transactions wait on nothing
 * slower than their own statements (each bounded by `statement_timeout`) and
 * the local disk; a handler that throws is rolled back, and a process that dies
 * takes its sockets with it, which ends the transaction on the server too.
 *
 * The worker's long `REFRESH MATERIALIZED VIEW` runs on its own pool
 * (apps/worker/src/index.ts) and is unaffected.
 */
export const POOL_LIMITS = {
  max: 10,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 15_000,
} as const satisfies pg.PoolConfig;

/**
 * A connection can be lost at any moment — Postgres restarted, the container
 * recycled, a backend terminated by an operator — and node-postgres reports it
 * as an `error` event on the CLIENT. With no listener that is an unhandled
 * 'error' event, which crashes the whole process (the web server, or the worker
 * halfway through a run). Only the error's class and SQLSTATE are logged: the
 * message of a pg error can quote the statement, and statements carry the
 * values a member typed.
 */
export function describePoolError(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name} ${code}` : error.name;
}

// Lazy singleton — nothing connects at import time, so typecheck, tests and
// builds never need a live database.
export function getDb() {
  return drizzle(getPool());
}

/**
 * The underlying pool, for the few callers that need POSITIONAL parameters
 * rather than drizzle's tagged templates — the report runner (Stage 6.2) binds
 * `$1..$n` itself, because its SQL comes from a catalogue rather than from a
 * template literal. Same pool, so there is still one connection budget.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: requireDatabaseUrl(), ...POOL_LIMITS });
    // Every connection gets its own listener, once, when the pool opens it.
    // pg-pool only listens to a client while it sits IDLE — it removes its
    // listener on checkout — so a connection lost inside a transaction (the
    // worker mid-send, a server action mid-write) had nobody to hear it.
    pool.on('connect', (client) => {
      client.on('error', (error) => {
        console.error('[db-pool] connection error:', describePoolError(error));
      });
    });
    // pg-pool also re-emits an idle client's error on the pool itself. The
    // connection's own listener above has already reported it; this one only
    // keeps the re-emission from being an unhandled 'error'.
    pool.on('error', () => undefined);
  }
  return pool;
}
