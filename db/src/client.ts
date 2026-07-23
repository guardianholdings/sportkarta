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
  pool ??= new pg.Pool({ connectionString: requireDatabaseUrl() });
  return pool;
}
