import { config } from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { runImport } from './run.js';

// Dev: repo-root .env (src/ and dist/ are the same depth below the package).
config({ path: new URL('../../../.env', import.meta.url).pathname });

const REPORTS_DIR = new URL('../reports', import.meta.url).pathname;

/**
 * pnpm import:osm [--dry-run] [--live] [--skip-download]
 * Dry-run is the DEFAULT (full pipeline, transaction rolled back). A live
 * import requires the explicit --live flag — and, per docs/ROADMAP.md §3,
 * an operator-approved dry-run report first.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
      'skip-download': { type: 'boolean', default: false },
    },
  });

  if (values['dry-run'] && values.live) {
    throw new Error('--dry-run and --live are mutually exclusive');
  }
  const dryRun = !values.live;

  console.log(`[import:osm] starting ${dryRun ? 'DRY-RUN' : 'LIVE'} import`);
  const { report, stats } = await runImport({
    dryRun,
    skipDownload: values['skip-download'],
  });

  await mkdir(REPORTS_DIR, { recursive: true });
  const date = stats.startedAt.toISOString().slice(0, 10);
  const reportPath = path.join(REPORTS_DIR, `${date}${dryRun ? '-dry-run' : ''}.md`);
  await writeFile(reportPath, report);

  console.log(report);
  console.log(`[import:osm] report written to ${reportPath}`);
}

main().catch((error: unknown) => {
  console.error('[import:osm] failed', error);
  process.exit(1);
});
