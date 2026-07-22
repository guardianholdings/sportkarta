import { config } from 'dotenv';
import pg from 'pg';

import { refreshStats, STATS_MATVIEWS } from '../src/stats.js';

// CLI: `pnpm db:refresh-stats` — a manual refresh for the operator. The shared
// refreshStats helper lives in @sportkarta/db (used by the worker + seed too).
config({ path: new URL('../../.env', import.meta.url).pathname });

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env.example)');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await refreshStats(client);
    console.log(`refresh-stats: refreshed ${String(STATS_MATVIEWS.length)} materialized views`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('[refresh-stats] failed', error);
    process.exit(1);
  });
}
