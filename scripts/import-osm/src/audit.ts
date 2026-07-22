import { jsonEquals, SOURCE_PRIORITY, type EditSource, type JsonValue } from '@sportkarta/lib';
import pg from 'pg';

import { ensureExtract } from './download.js';
import { collectCandidates, runOsmium } from './extract.js';
import { candidateAttrs, computeCentroids, loadLastEditSources } from './importer.js';
import type { FacilityCandidate } from './normalize.js';

/**
 * Scripted fidelity audit: a random sample of source='osm' facilities is
 * compared field-by-field against values freshly re-derived from the raw
 * Geofabrik extract. Catches drift (stale data after upstream OSM edits),
 * partial imports, and tampering. It reuses the pipeline's mapping code, so
 * it can NOT catch a wrong mapping rule — that stays the job of the
 * independent osm-data-auditor agent at review gates.
 *
 * Fields whose last facility_edits entry outranks 'osm' (crowd/municipal)
 * are intentionally different — reported separately, never counted.
 */

export interface AuditOptions {
  sampleSize?: number;
  /** Mismatch percentage above which the audit fails (exit 1 in the CLI). */
  thresholdPct?: number;
  skipDownload?: boolean;
  cacheDir?: string;
  databaseUrl?: string;
}

export interface AuditResult {
  sampled: number;
  mismatchedRows: number;
  mismatchPct: number;
  passed: boolean;
  thresholdPct: number;
  byField: Record<string, number>;
  protectedDiffs: number;
  examples: string[];
  report: string;
}

interface SampledRow {
  id: string;
  osm_type: string;
  osm_id: string;
  name: string | null;
  sport_types: string[];
  surface: string | null;
  lighting: boolean | null;
  covered: boolean;
  access: string;
  attrs: JsonValue;
  lon: number;
  lat: number;
  municipality_id: number | null;
  expected_municipality_id: number | null;
}

const DEFAULT_CACHE_DIR = new URL('../../../var/cache/osm', import.meta.url).pathname;
const GEOM_TOLERANCE_DEG = 1e-6; // ≈ 0.1 m — far below OSM precision

export async function runAudit(options: AuditOptions = {}): Promise<AuditResult> {
  const sampleSize = options.sampleSize ?? 100;
  const thresholdPct = options.thresholdPct ?? 2;
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required (see .env.example)');

  const extract = await ensureExtract(cacheDir, { skipDownload: options.skipDownload ?? false });
  const { mkdtemp } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'sportkarta-audit-'));
  const featuresPath = await runOsmium(extract.pbfPath, workDir);
  const { byKey } = await collectCandidates(featuresPath);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const sample = await client.query<SampledRow>(
      `
      SELECT id, osm_type, osm_id, name, sport_types, surface, lighting, covered,
             access, attrs, ST_X(geom) AS lon, ST_Y(geom) AS lat, municipality_id,
             (SELECT m.id FROM municipalities m WHERE ST_Contains(m.geom, facilities.geom) LIMIT 1)
               AS expected_municipality_id
      FROM facilities
      WHERE source = 'osm'
      ORDER BY random()
      LIMIT $1
      `,
      [sampleSize],
    );
    const rows = sample.rows;
    if (rows.length === 0) {
      throw new Error('audit: no source=osm facilities in the database — run the import first');
    }

    const lastEdits = await loadLastEditSources(
      client,
      rows.map((r) => r.id),
    );

    // Expected centroids for the sampled refs present in the extract.
    const matched: { row: SampledRow; candidate: FacilityCandidate }[] = [];
    for (const row of rows) {
      const candidate = byKey.get(`${row.osm_type}:${row.osm_id}`);
      if (candidate) matched.push({ row, candidate });
    }
    const centroids = await computeCentroids(
      client,
      matched.map((m) => m.candidate),
    );
    const centroidByFacility = new Map(matched.map((m, i) => [m.row.id, centroids[i]]));

    const byField: Record<string, number> = {};
    const examples: string[] = [];
    let mismatchedRows = 0;
    let protectedDiffs = 0;

    for (const row of rows) {
      const key = `${row.osm_type}:${row.osm_id}`;
      const candidate = byKey.get(key);
      const rowMismatches: string[] = [];
      const frozen = lastEdits.get(row.id) ?? {};
      const isProtected = (field: string): boolean => {
        const src: EditSource | undefined = frozen[field];
        return src !== undefined && SOURCE_PRIORITY[src] > SOURCE_PRIORITY.osm;
      };

      if (!candidate) {
        byField['missing_from_extract'] = (byField['missing_from_extract'] ?? 0) + 1;
        rowMismatches.push('missing_from_extract');
      } else {
        const expected: Record<string, JsonValue> = {
          name: candidate.name,
          sport_types: candidate.sportTypes,
          surface: candidate.surface,
          lighting: candidate.lighting,
          covered: candidate.covered,
          access: candidate.access,
          attrs: candidateAttrs(candidate),
        };
        const actual: Record<string, JsonValue> = {
          name: row.name,
          sport_types: row.sport_types,
          surface: row.surface,
          lighting: row.lighting,
          covered: row.covered,
          access: row.access,
          attrs: row.attrs,
        };
        for (const field of Object.keys(expected)) {
          if (jsonEquals(expected[field] ?? null, actual[field] ?? null)) continue;
          if (isProtected(field)) {
            protectedDiffs += 1;
            continue;
          }
          byField[field] = (byField[field] ?? 0) + 1;
          rowMismatches.push(field);
        }

        const centroid = centroidByFacility.get(row.id);
        if (centroid && !isProtected('geom')) {
          if (
            Math.abs(centroid.lon - Number(row.lon)) > GEOM_TOLERANCE_DEG ||
            Math.abs(centroid.lat - Number(row.lat)) > GEOM_TOLERANCE_DEG
          ) {
            byField['geom'] = (byField['geom'] ?? 0) + 1;
            rowMismatches.push('geom');
          }
        }
      }

      // Derived-cache freshness: stored municipality vs ST_Contains right now.
      if (row.municipality_id !== row.expected_municipality_id) {
        byField['municipality_id'] = (byField['municipality_id'] ?? 0) + 1;
        rowMismatches.push('municipality_id');
      }

      if (rowMismatches.length > 0) {
        mismatchedRows += 1;
        if (examples.length < 5) {
          examples.push(`${key} (${row.name ?? 'без име'}): ${rowMismatches.join(', ')}`);
        }
      }
    }

    const mismatchPct = (mismatchedRows / rows.length) * 100;
    const passed = mismatchPct <= thresholdPct;

    const fieldTable =
      Object.keys(byField).length === 0
        ? '_No field mismatches._\n'
        : [
            '| Field | Mismatches | % of sample |',
            '|---|---|---|',
            ...Object.entries(byField)
              .sort((a, b) => b[1] - a[1])
              .map(
                ([f, n]) => `| ${f} | ${String(n)} | ${((n / rows.length) * 100).toFixed(1)}% |`,
              ),
            '',
          ].join('\n');

    const report = `# OSM data audit — ${new Date().toISOString().slice(0, 10)}

- Extract md5: \`${extract.md5}\`
- Sample: ${String(rows.length)} of requested ${String(sampleSize)} (source='osm')
- Rows with ≥1 mismatch: ${String(mismatchedRows)} → **${mismatchPct.toFixed(2)}%** (threshold ${String(thresholdPct)}%)
- Merge-policy-protected diffs (intentional, not counted): ${String(protectedDiffs)}
- Verdict: **${passed ? 'PASS' : 'FAIL'}**

## Mismatches by field

${fieldTable}
${examples.length > 0 ? `## Examples\n\n${examples.map((e) => `- ${e}`).join('\n')}\n` : ''}`;

    return {
      sampled: rows.length,
      mismatchedRows,
      mismatchPct,
      passed,
      thresholdPct,
      byField,
      protectedDiffs,
      examples,
      report,
    };
  } finally {
    await client.end();
  }
}
