import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

import { ensureExtract } from './download.js';
import { runOsmium } from './extract.js';
import { importCandidates, queryDistributions } from './importer.js';
import {
  normalizeFeature,
  preferCandidate,
  type FacilityCandidate,
  type OsmFeature,
} from './normalize.js';
import { buildReport, type ImportStats } from './report.js';

export interface RunOptions {
  /** Dry-run (default) executes the full pipeline and rolls the tx back. */
  dryRun?: boolean;
  /** Reuse the cached extract without asking Geofabrik for its md5. */
  skipDownload?: boolean;
  cacheDir?: string;
  databaseUrl?: string;
}

export interface RunResult {
  report: string;
  stats: ImportStats;
}

/** src/ and dist/ sit at the same depth, so ../../.. is the repo root either way. */
const DEFAULT_CACHE_DIR = new URL('../../../var/cache/osm', import.meta.url).pathname;

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

async function* readFeatures(featuresPath: string): AsyncGenerator<OsmFeature> {
  const rl = createInterface({
    input: createReadStream(featuresPath),
    crlfDelay: Infinity,
  });
  for await (const rawLine of rl) {
    // RFC 8142: each record is RS (0x1e) + JSON + LF.
    const line = (rawLine.charCodeAt(0) === 0x1e ? rawLine.slice(1) : rawLine).trim();
    if (!line) continue;
    yield JSON.parse(line) as OsmFeature;
  }
}

/**
 * The one entry point: CLI and the pg-boss `import.osm` job both call this.
 * Idempotent by construction — cached checksummed download, deterministic
 * normalization, merge policy that no-ops on equal values.
 */
export async function runImport(options: RunOptions = {}): Promise<RunResult> {
  const dryRun = options.dryRun ?? true;
  const cacheDir = options.cacheDir ?? DEFAULT_CACHE_DIR;
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required (see .env.example)');
  }

  const startedAt = new Date();
  const extract = await ensureExtract(cacheDir, { skipDownload: options.skipDownload ?? false });
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'sportkarta-osm-'));
  const featuresPath = await runOsmium(extract.pbfPath, workDir);

  const skips: Record<string, number> = {};
  const unmappedSports: Record<string, number> = {};
  const unmappedSurfaces: Record<string, number> = {};
  const unusualLit: Record<string, number> = {};
  const noSportBuckets: Record<string, number> = {};
  const byKey = new Map<string, FacilityCandidate>();
  let featuresTotal = 0;
  let geometryTwins = 0;

  for await (const feature of readFeatures(featuresPath)) {
    featuresTotal += 1;
    const result = normalizeFeature(feature);
    if (result.kind === 'skip') {
      bump(skips, result.reason);
      continue;
    }
    const c = result.candidate;
    const key = `${c.osmType}:${String(c.osmId)}`;
    const twin = byKey.get(key);
    if (twin) {
      // Closed ways export twice (area + perimeter ring) — count, prefer polygon.
      geometryTwins += 1;
      byKey.set(key, preferCandidate(twin, c));
      continue;
    }
    byKey.set(key, c);
    for (const token of c.unmappedSports) bump(unmappedSports, token);
    if (c.unmappedSurface !== undefined) bump(unmappedSurfaces, c.unmappedSurface);
    if (c.unusualLit !== undefined) bump(unusualLit, c.unusualLit);
    if (c.noSportBucket !== undefined) bump(noSportBuckets, c.noSportBucket);
  }
  const candidates = [...byKey.values()];

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let stats: ImportStats;
  try {
    await client.query('BEGIN');
    const counts = await importCandidates(client, candidates);
    const distributions = await queryDistributions(client);
    stats = {
      mode: dryRun ? 'dry-run' : 'live',
      startedAt,
      extractMd5: extract.md5,
      extractDownloaded: extract.downloaded,
      featuresTotal,
      skips,
      geometryTwins,
      candidates: candidates.length,
      counts,
      unmappedSports,
      unmappedSurfaces,
      unusualLit,
      noSportBuckets,
      bySport: distributions.bySport,
      byMunicipality: distributions.byMunicipality,
      totalOsm: distributions.totalOsm,
    };
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  return { report: buildReport(stats), stats };
}
