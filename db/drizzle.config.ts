import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` works without a database; `migrate`/`studio` require
// DATABASE_URL (never a production URL from inside a session — CLAUDE.md).
export default defineConfig({
  dialect: 'postgresql',
  schema: './schema/index.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
