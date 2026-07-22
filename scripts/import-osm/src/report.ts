import type { DistributionRow, ImportCounts } from './importer.js';

export interface ImportStats {
  mode: 'dry-run' | 'live';
  startedAt: Date;
  extractMd5: string;
  extractDownloaded: boolean;
  featuresTotal: number;
  skips: Record<string, number>;
  /** Closed ways exported by osmium as both area and perimeter ring. */
  geometryTwins: number;
  candidates: number;
  counts: ImportCounts;
  unmappedSports: Record<string, number>;
  unmappedSurfaces: Record<string, number>;
  unusualLit: Record<string, number>;
  noSportBuckets: Record<string, number>;
  bySport: DistributionRow[];
  byMunicipality: DistributionRow[];
  totalOsm: number;
}

function freqTable(header: [string, string], entries: Record<string, number>): string {
  const rows = Object.entries(entries).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (rows.length === 0) return '_None._\n';
  return [
    `| ${header[0]} | ${header[1]} |`,
    '|---|---|',
    ...rows.map(([k, v]) => `| \`${k}\` | ${String(v)} |`),
    '',
  ].join('\n');
}

function distTable(label: string, rows: DistributionRow[]): string {
  if (rows.length === 0) return '_None._\n';
  return [
    `| ${label} | Count |`,
    '|---|---|',
    ...rows.map((r) => `| ${r.label} | ${String(r.count)} |`),
    '',
  ].join('\n');
}

/** ROADMAP §3 gate: national count sanity — investigate the filter if far below ~5,000. */
const NATIONAL_COUNT_EXPECTATION = 5000;

export function buildReport(stats: ImportStats): string {
  const s = stats;
  const skipTotal = Object.values(s.skips).reduce((a, b) => a + b, 0);
  const sanity =
    s.totalOsm >= NATIONAL_COUNT_EXPECTATION
      ? `PASS — ${String(s.totalOsm)} ≥ ${String(NATIONAL_COUNT_EXPECTATION)}`
      : `REVIEW — ${String(s.totalOsm)} < ${String(NATIONAL_COUNT_EXPECTATION)} expected national facilities (ROADMAP §3: investigate the filter before trusting this run)`;

  return `# OSM import report — ${s.startedAt.toISOString().slice(0, 10)} (${s.mode})

- Run started: ${s.startedAt.toISOString()}
- Extract: bulgaria-latest.osm.pbf, md5 \`${s.extractMd5}\`${s.extractDownloaded ? ' (freshly downloaded)' : ' (cache hit)'}
- Mode: **${s.mode}**${s.mode === 'dry-run' ? ' — transaction rolled back, zero writes' : ''}

## Totals

| Metric | Count |
|---|---|
| GeoJSON features from osmium | ${String(s.featuresTotal)} |
| Geometry twins deduped (area + ring of the same way; polygon wins) | ${String(s.geometryTwins)} |
| Candidates after normalization | ${String(s.candidates)} |
| Skipped (all reasons) | ${String(skipTotal)} |
| Inserted (new, needs_verification) | ${String(s.counts.inserted)} |
| Updated (≥1 field applied) | ${String(s.counts.updated)} |
| Unchanged (idempotent no-op) | ${String(s.counts.unchanged)} |
| Bbox CHECK skips at insert | ${String(s.counts.constraintSkips)} |
| In DB but missing from extract | ${String(s.counts.missingFromExtract)} (reported only — never auto-marked gone) |
| **OSM facilities after run** | **${String(s.totalOsm)}** |

National count sanity: **${sanity}**

## Skip reasons

${freqTable(['Reason', 'Count'], s.skips)}
## Merge policy — frozen fields (crowd/municipal protected)

${freqTable(['Field', 'Skipped overwrites'], s.counts.frozenFields)}
## Facilities per sport

${distTable('Sport', s.bySport)}
## Facilities per municipality

${distTable('Municipality', s.byMunicipality)}
## Unmapped \`sport\` values (imported without this token; raw kept in attrs)

${freqTable(['OSM value', 'Frequency'], s.unmappedSports)}
## Unmapped \`surface\` values (surface set NULL; raw kept in attrs)

${freqTable(['OSM value', 'Frequency'], s.unmappedSurfaces)}
## Unusual \`lit\` values (lighting set NULL)

${freqTable(['OSM value', 'Frequency'], s.unusualLit)}
## Sport-less qualifying leisure objects (imported with empty sport_types)

${freqTable(['Bucket', 'Count'], s.noSportBuckets)}
`;
}
