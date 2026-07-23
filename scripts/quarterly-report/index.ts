import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { asQueryable, runReport } from '@sportkarta/db';
import {
  dayRangePeriod,
  GRANT_REPORT,
  previousQuarter,
  quarterPeriod,
  QUARTERLY_REPORT,
  renderReportCsv,
  renderReportHtml,
  reportFilename,
  type ReportDefinition,
} from '@sportkarta/lib/reports';
import { config } from 'dotenv';
import pg from 'pg';

/**
 * The national quarterly report, and the grant annex, rendered to HTML and PDF
 * (docs/ROADMAP.md §8, Stage 6.2).
 *
 *   pnpm report:quarterly                 → the quarter that just ended
 *   pnpm report:quarterly -- 2026-Q2      → a named quarter
 *   pnpm report:grant -- --from 2026-04-01 --to 2026-06-30 [--municipality 12]
 *
 * WHY THE PDF IS MADE HERE AND NOT IN THE WEB APP. Rendering a PDF server-side
 * means Chromium in the production image — several hundred megabytes and a
 * memory spike on a €15–25/month VPS — for a document produced four times a
 * year. Here it costs nothing: Playwright's Chromium is already installed for
 * the e2e suite, and this script runs on the operator's machine inside a Claude
 * Code session, which is where every other operational script in this repo
 * runs. The admin screen serves the same HTML for the browser's own print
 * dialog, so nobody is blocked when this script is unavailable.
 *
 * IF CHROMIUM IS MISSING the HTML is still written and the run reports success
 * with a clear note. A report generator that produces nothing because an
 * optional renderer is absent has failed at its actual job, which is producing
 * the report.
 *
 * Output lands in `docs/reports/`, which is gitignored by default: a report
 * generated from a DEVELOPMENT database holds partial figures, and a half-real
 * report sitting in the repository is one somebody eventually cites. A report
 * generated from production and actually published is the opposite case and
 * should be committed deliberately (`git add -f`), so that a figure quoted in a
 * grant file can still be found a year later. docs/reports/README.md says so
 * where whoever runs this will look.
 */

config({ path: new URL('../../.env', import.meta.url).pathname });

const OUTPUT_DIR = resolve(new URL('../../docs/reports', import.meta.url).pathname);

interface Args {
  grant: boolean;
  quarter?: string;
  from?: string;
  to?: string;
  municipality?: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { grant: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--grant') args.grant = true;
    else if (value === '--from') args.from = argv[++i];
    else if (value === '--to') args.to = argv[++i];
    else if (value === '--municipality') args.municipality = Number(argv[++i]);
    else if (value && !value.startsWith('--')) args.quarter = value;
  }
  return args;
}

async function municipalityName(client: pg.Client, id: number | undefined): Promise<string | null> {
  if (id === undefined) return null;
  const result = await client.query<{ name_bg: string }>(
    'SELECT name_bg FROM municipalities WHERE id = $1',
    [id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`no municipality with id ${String(id)}`);
  return row.name_bg;
}

/**
 * HTML → PDF through Playwright's Chromium.
 *
 * `print` media, background graphics on (the table headers and the methodology
 * blocks are shaded, and a report whose structure disappears in print is
 * harder to read than one that was never styled), and the page size comes from
 * the document's own `@page` rule rather than being set twice.
 */
async function renderPdf(html: string, outputPath: string): Promise<boolean> {
  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    return false;
  }
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    return false;
  }
  try {
    const page = await browser.newPage();
    // setContent rather than a file:// navigation: the document is entirely
    // self-contained (lib/src/reports/render.ts), so there is nothing to load
    // from disk and no chance of a half-written file being rendered.
    await page.setContent(html, { waitUntil: 'load' });
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: outputPath, printBackground: true, preferCSSPageSize: true });
    return true;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env.example)');

  const args = parseArgs(process.argv.slice(2));
  const definition: ReportDefinition = args.grant ? GRANT_REPORT : QUARTERLY_REPORT;

  let period;
  if (args.grant) {
    if (!args.from || !args.to) {
      throw new Error('pnpm report:grant -- --from YYYY-MM-DD --to YYYY-MM-DD [--municipality ID]');
    }
    period = dayRangePeriod(args.from, args.to);
  } else {
    // Default to the quarter that has just ENDED, which is what "generate the
    // quarterly report" means on the 1st of a new quarter — the only day
    // anybody runs it.
    period = quarterPeriod(args.quarter ?? previousQuarter(new Date()));
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const name = await municipalityName(client, args.municipality);
    const data = await runReport(
      asQueryable(client),
      definition,
      { from: period.from, to: period.to, municipalityId: args.municipality ?? null },
      name,
    );

    const stem = args.grant ? reportFilename(definition, data.scope) : `otchet-${period.label}`;
    const htmlPath = resolve(OUTPUT_DIR, `${stem}.html`);
    const pdfPath = resolve(OUTPUT_DIR, `${stem}.pdf`);
    const csvPath = resolve(OUTPUT_DIR, `${stem}.csv`);

    mkdirSync(dirname(htmlPath), { recursive: true });
    const html = renderReportHtml(definition, data);
    writeFileSync(htmlPath, html, 'utf8');
    writeFileSync(csvPath, renderReportCsv(definition, data), 'utf8');

    const pdf = await renderPdf(html, pdfPath);

    console.log(`report:   ${definition.id}`);
    console.log(`period:   ${period.label}`);
    console.log(`scope:    ${name ?? 'national'}`);
    console.log(`html:     ${htmlPath}`);
    console.log(`csv:      ${csvPath}`);
    console.log(
      pdf
        ? `pdf:      ${pdfPath}`
        : 'pdf:      not generated (Playwright Chromium unavailable — run `pnpm --filter @sportkarta/web exec playwright install chromium`). The HTML above is print-ready.',
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('[quarterly-report]', error);
  process.exit(1);
});
