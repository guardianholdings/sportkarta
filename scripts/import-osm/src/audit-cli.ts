import { config } from 'dotenv';
import { parseArgs } from 'node:util';

import { runAudit } from './audit.js';

// Dev: repo-root .env (src/ and dist/ are the same depth below the package).
config({ path: new URL('../../../.env', import.meta.url).pathname });

/**
 * pnpm import:osm:audit [--sample N] [--threshold PCT] [--skip-download]
 * Exits 1 when the mismatch rate exceeds the threshold — the weekly
 * GitHub Actions audit job fails loudly on that exit code.
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      sample: { type: 'string', default: '100' },
      threshold: { type: 'string', default: '2' },
      'skip-download': { type: 'boolean', default: false },
    },
  });

  const result = await runAudit({
    sampleSize: Number(values.sample),
    thresholdPct: Number(values.threshold),
    skipDownload: values['skip-download'],
  });

  console.log(result.report);
  if (!result.passed) {
    console.error(
      `[audit] FAIL: ${result.mismatchPct.toFixed(2)}% mismatch > ${String(result.thresholdPct)}% threshold`,
    );
    process.exit(1);
  }
  console.log('[audit] PASS');
}

main().catch((error: unknown) => {
  console.error('[audit] failed', error);
  process.exit(1);
});
