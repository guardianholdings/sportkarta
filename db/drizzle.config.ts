import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Root .env (drizzle-kit runs with cwd = db/).
config({ path: '../.env' });

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
