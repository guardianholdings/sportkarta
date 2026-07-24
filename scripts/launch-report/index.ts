import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { config } from 'dotenv';
import pg from 'pg';

// Reproducible launch press statistics. Each headline figure is produced by the
// exact SQL shown next to it, run against the live database — so any journalist
// or municipality can re-run and verify. The numbers reconcile with /statistika,
// which requires every query here to carry the SAME public-visibility predicate
// as the materialized views and the map: status <> 'gone' AND slug IS NOT NULL
// (0017). One slugless row counted here and not there is exactly the
// credibility failure this script exists to prevent. Run:
//   pnpm stats:launch-report
config({ path: new URL('../../.env', import.meta.url).pathname });

interface Metric {
  heading: string;
  sql: string;
  format: (rows: Record<string, unknown>[]) => string;
}

const scalar =
  (key: string, suffix = '') =>
  (rows: Record<string, unknown>[]): string =>
    rows[0] ? `${String(rows[0][key])}${suffix}` : 'n/a';

const METRICS: Metric[] = [
  {
    heading: 'Public sports facilities on the map',
    sql: "SELECT count(*) AS n FROM facilities WHERE status <> 'gone' AND slug IS NOT NULL;",
    format: scalar('n'),
  },
  {
    heading: 'Facilities with free public access (%)',
    sql: "SELECT round(100.0 * count(*) FILTER (WHERE access = 'free') / count(*), 1) AS pct\nFROM facilities WHERE status <> 'gone' AND slug IS NOT NULL;",
    format: scalar('pct', '%'),
  },
  {
    heading: 'Municipalities with at least one facility',
    sql: "SELECT count(DISTINCT municipality_id) AS n\nFROM facilities WHERE status <> 'gone' AND slug IS NOT NULL AND municipality_id IS NOT NULL;",
    format: scalar('n'),
  },
  {
    heading: 'Distinct sports represented',
    sql: "SELECT count(DISTINCT s.sport) AS n\nFROM facilities f, LATERAL unnest(f.sport_types) AS s(sport)\nWHERE f.status <> 'gone' AND f.slug IS NOT NULL;",
    format: scalar('n'),
  },
  {
    heading: 'Awaiting community verification (%)',
    sql: "SELECT round(100.0 * count(*) FILTER (WHERE status = 'needs_verification') / count(*), 1) AS pct\nFROM facilities WHERE status <> 'gone' AND slug IS NOT NULL;",
    format: scalar('pct', '%'),
  },
  {
    heading: 'Top 5 municipalities by facility count',
    sql: "SELECT m.name_bg, count(*) AS n\nFROM facilities f JOIN municipalities m ON m.id = f.municipality_id\nWHERE f.status <> 'gone' AND f.slug IS NOT NULL\nGROUP BY m.id, m.name_bg ORDER BY n DESC, m.name_bg LIMIT 5;",
    format: (rows) => rows.map((r) => `${String(r.name_bg)} (${String(r.n)})`).join(', '),
  },
  {
    heading:
      'Best-covered municipality — facilities per 10,000 residents (cities with population data)',
    sql: 'SELECT name_bg, per_10k FROM mv_municipality_stats\nWHERE per_10k IS NOT NULL ORDER BY per_10k DESC LIMIT 1;',
    format: (rows) =>
      rows[0] ? `${String(rows[0].name_bg)} — ${String(rows[0].per_10k)} per 10k` : 'n/a',
  },
];

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env.example)');
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const sections: string[] = [];
  try {
    for (const metric of METRICS) {
      const result = await client.query<Record<string, unknown>>(metric.sql);
      const value = metric.format(result.rows);
      sections.push(`## ${metric.heading}\n\n**${value}**\n\n\`\`\`sql\n${metric.sql}\n\`\`\``);
    }
  } finally {
    await client.end();
  }

  const generated = new Date().toISOString().slice(0, 10);
  const doc = `# SportKarta — launch press statistics

_Generated ${generated} by \`pnpm stats:launch-report\` (scripts/launch-report)._

Every figure below is produced by the **exact SQL query** shown beneath it, run
against the live database — reproducible and verifiable by anyone. The numbers
reconcile with the [/statistika](../../apps/web/app/[locale]/statistika) page
(its materialized views derive from the same base data). Facility data ©
OpenStreetMap contributors (ODbL); municipality population from NSI (2021
Census, see db/data/README.md). Regenerate against production at launch.

${sections.join('\n\n')}
`;

  const outPath = new URL('../../docs/launch/press-stats.md', import.meta.url).pathname;
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, doc);
  console.log(`launch-report: wrote ${outPath}`);
}

main().catch((error: unknown) => {
  console.error('[launch-report] failed', error);
  process.exit(1);
});
