import { config } from 'dotenv';
import pg from 'pg';

import { purgeDemoClub, seedDemoClub } from '../src/clubs/demo-seed.js';

// CLI: `pnpm db:seed-demo-club` rebuilds the demo club (Boss decision #53) in one
// transaction and prints the row counts by table before COMMIT; `--purge` is
// the one-off rollback (the club, every row reached from its id, and its three
// staff accounts). Without `--commit` it rolls back after printing, so a run
// first shows what it would do. It prints table names and counts only.
config({ path: new URL('../../.env', import.meta.url).pathname });

class DryRun extends Error {}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--purge' && arg !== '--commit');
  if (unknown.length > 0)
    throw new Error(`unknown argument(s): ${unknown.join(' ')} (use --purge, --commit)`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env.example)');
  const commit = args.includes('--commit');
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    if (args.includes('--purge')) {
      await purgeDemoClub(pool, {
        beforeCommit: (report) => {
          console.log(`seed-demo-club: the purge removes ${JSON.stringify(report.removed)}`);
          if (!commit) throw new DryRun();
        },
      });
    } else {
      await seedDemoClub(pool, {
        beforeCommit: (report) => {
          console.log(
            `seed-demo-club: run day ${report.today}, staff accounts inserted ${String(report.staffInserted)}`,
          );
          console.log(`seed-demo-club: removes ${JSON.stringify(report.removed)}`);
          console.log(`seed-demo-club: writes ${JSON.stringify(report.written)}`);
          if (!commit) throw new DryRun();
        },
      });
    }
    console.log('seed-demo-club: committed');
  } catch (error: unknown) {
    if (!(error instanceof DryRun)) throw error;
    console.log('seed-demo-club: rolled back (a dry run; add --commit to write)');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('[seed-demo-club] failed', error);
    process.exit(1);
  });
}
