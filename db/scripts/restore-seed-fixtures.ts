import { readFile } from 'node:fs/promises';

import { config } from 'dotenv';
import pg from 'pg';

import { parseSeedFixtureExport, restoreSeedFixtures } from '../src/seed-fixtures.js';
import { refreshStats } from '../src/stats.js';

// CLI: `pnpm db:restore-seed-fixtures <export.json>` — the undo for the
// production seed's fixture retirement (Boss decision #18; the export is what
// that step wrote BEFORE changing anything, see db/src/seed-fixtures.ts). On
// the server, from /opt/sportkarta:
//
//   docker compose -f compose.prod.yml --profile ops run --rm migrate \
//     pnpm db:restore-seed-fixtures /exports/seed-fixtures/<file>.json
//
// A retired fixture gets its exported status back; one missing from the table
// is inserted again from the export. One transaction, every change audited in
// facility_edits with a NULL actor, then the statistics views are refreshed.
// The next deploy leaves a restored fixture alone: retirement runs at most
// once per row. Prints counts only — the rows stay in the file.
config({ path: new URL('../../.env', import.meta.url).pathname });

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    throw new Error('usage: pnpm db:restore-seed-fixtures <export.json>');
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env.example)');

  const doc = parseSeedFixtureExport(JSON.parse(await readFile(file, 'utf8')) as unknown);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    try {
      const report = await restoreSeedFixtures(client, doc);
      await client.query('COMMIT');
      console.log(
        `restore-seed-fixtures: ${String(report.republished)} republished, ${String(report.reinserted)} re-inserted, ${String(report.untouched)} left as they were`,
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    await refreshStats(client);
    console.log('restore-seed-fixtures: refreshed statistics materialized views');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('[restore-seed-fixtures] failed', error instanceof Error ? error.message : error);
  process.exit(1);
});
