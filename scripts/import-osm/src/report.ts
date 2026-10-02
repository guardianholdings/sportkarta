import { DUPLICATE_RADIUS_M, type DuplicatePair } from './dedupe.js';
import type { DistributionRow, ImportCounts } from './importer.js';
import {
  MUNICIPALITY_SNAP_M,
  type AssignmentResult,
  type MunicipalityCounts,
  type RegisterRow,
  type UnmatchedBoundary,
} from './municipalities.js';

export interface MunicipalityStageStats {
  boundariesFound: number;
  counts: MunicipalityCounts;
  unmatched: UnmatchedBoundary[];
  missingFromOsm: RegisterRow[];
  /** Every register municipality has a boundary — arms the out-of-border gate. */
  layerComplete: boolean;
}

export interface ImportStats {
  municipalities: MunicipalityStageStats;
  assignment: AssignmentResult;
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

/** Long lists stay readable in a dry-run report; the counts above them are exact. */
const LISTED = 50;

function pairTable(pairs: DuplicatePair[], keepLabel: string, dropLabel: string): string {
  if (pairs.length === 0) return '_None._\n';
  const shown = pairs.slice(0, LISTED);
  return [
    `| ${keepLabel} | ${dropLabel} | Distance |`,
    '|---|---|---|',
    ...shown.map((p) => `| \`${p.keep}\` | \`${p.drop}\` | ${p.distanceM.toFixed(1)} m |`),
    ...(pairs.length > shown.length
      ? [`| … | ${String(pairs.length - shown.length)} more | |`]
      : []),
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

  const m = s.municipalities;
  const unmatchedRows =
    m.unmatched.length === 0
      ? '_None._\n'
      : [
          '| OSM relation | Name | Reason | Center | Register candidates |',
          '|---|---|---|---|---|',
          ...m.unmatched.map((u) => {
            const c = u.boundary.center;
            const center = c ? `${String(c.lon.toFixed(3))}, ${String(c.lat.toFixed(3))}` : '?';
            return `| r${String(u.boundary.relationId)} | ${u.boundary.name} | ${u.reason} | ${center} | ${(u.candidates ?? []).join('; ') || '—'} |`;
          }),
          '',
        ].join('\n');
  const missingRows =
    m.missingFromOsm.length === 0
      ? '_None._\n'
      : m.missingFromOsm.map((r) => `- ${r.ekatteCode} ${r.nameBg} (${r.nameEn})`).join('\n') +
        '\n';
  const outSamples =
    s.assignment.outSamples.length === 0
      ? ''
      : [
          '',
          '| Ref | Slug | Name | Lon, lat |',
          '|---|---|---|---|',
          ...s.assignment.outSamples.map(
            (o) =>
              `| ${o.ref ? `\`${o.ref}\`` : '—'} | ${o.slug ?? '—'} | ${o.name ?? '(без име)'} | ${o.lon.toFixed(4)}, ${o.lat.toFixed(4)} |`,
          ),
          '',
        ].join('\n');
  const outsideRows =
    s.counts.outsideMunicipalities.length === 0
      ? '_None._\n'
      : [
          '| Ref | Name | Lon, lat |',
          '|---|---|---|',
          ...s.counts.outsideMunicipalities
            .slice(0, LISTED)
            .map(
              (o) =>
                `| \`${o.ref}\` | ${o.name ?? '(без име)'} | ${o.lon.toFixed(4)}, ${o.lat.toFixed(4)} |`,
            ),
          '',
        ].join('\n');
  const keptRows =
    s.counts.withdrawnKept.length === 0
      ? '_None._\n'
      : [
          '| Ref | Slug | Name | Status |',
          '|---|---|---|---|',
          ...s.counts.withdrawnKept
            .slice(0, LISTED)
            .map(
              (k) => `| \`${k.ref}\` | ${k.slug ?? '—'} | ${k.name ?? '(без име)'} | ${k.status} |`,
            ),
          '',
        ].join('\n');
  const borderGate = m.layerComplete
    ? `armed — all 265 municipality boundaries present, so a NEW facility outside every one of them (beyond the ${String(MUNICIPALITY_SNAP_M)} m coastline snap) is not inserted`
    : 'NOT armed — a municipality boundary is missing, so "outside every municipality" could mean "inside the gap"; nothing was refused on that ground';

  return `# OSM import report — ${s.startedAt.toISOString().slice(0, 10)} (${s.mode})

- Run started: ${s.startedAt.toISOString()}
- Extract: bulgaria-latest.osm.pbf, md5 \`${s.extractMd5}\`${s.extractDownloaded ? ' (freshly downloaded)' : ' (cache hit)'}
- Mode: **${s.mode}**${s.mode === 'dry-run' ? ' — transaction rolled back, zero writes' : ''}

## Municipality boundaries (admin_level=5 ↔ EKATTE register)

| Metric | Count |
|---|---|
| OSM boundary relations found | ${String(m.boundariesFound)} |
| Matched to register | ${String(m.counts.matched)} / 265 |
| Inserted | ${String(m.counts.inserted)} |
| Updated | ${String(m.counts.updated)} |
| Unchanged | ${String(m.counts.unchanged)} |

### Unmatched OSM boundaries — operator decision required, never guessed

${unmatchedRows}
### Register municipalities without an OSM boundary this run

${missingRows}
## Facility → municipality assignment (derived: ST_Contains, else nearest within ${String(MUNICIPALITY_SNAP_M)} m)

- Assignments changed this run: ${String(s.assignment.changed)}
- Facilities (not gone) outside every municipality polygon: ${String(s.assignment.outOfPolygon)} — existing rows are listed for a human to check, never withdrawn automatically
- Border gate for new facilities: ${borderGate}
${outSamples}
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
| Not inserted — duplicates a row within ${String(DUPLICATE_RADIUS_M)} m (other element type, shared sport) | ${String(s.counts.duplicatesSkipped.length)} |
| Not inserted — outside every municipality | ${String(s.counts.outsideMunicipalities.length)} |
| Withdrawn — OSM now marks abandoned/disused (status → gone) | ${String(s.counts.withdrawn)} |
| Lifecycle-tagged but kept — a person or registry vouched for it | ${String(s.counts.withdrawnKept.length)} |
| Restored — OSM dropped the lifecycle tag on a row this importer withdrew | ${String(s.counts.restored)} |
| In DB but missing from extract | ${String(s.counts.missingFromExtract)} (reported only — never auto-marked gone) |
| **OSM facilities after run** | **${String(s.totalOsm)}** |

National count sanity: **${sanity}**

## Skip reasons

${freqTable(['Reason', 'Count'], s.skips)}
## Lifecycle-tagged rows left on the map — a person, registry or session vouches for them

${keptRows}
## New candidates not inserted as duplicates

${pairTable(s.counts.duplicatesSkipped, 'Kept', 'Not inserted')}
## Existing duplicate rows — for a moderator (both already on the map; nothing changed)

${pairTable(s.counts.existingDuplicates, 'Preferred', 'Candidate to mark gone')}
## New candidates not inserted — outside every municipality

${outsideRows}
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
