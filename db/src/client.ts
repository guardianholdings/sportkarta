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
  pool ??= new pg.Pool({ connectionString: requireDatabaseUrl() });
  return drizzle(pool);
}
