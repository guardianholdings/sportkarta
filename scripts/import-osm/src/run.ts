import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

import { ensureExtract } from './download.js';
import { collectCandidates, runOsmium, runOsmiumBoundaries } from './extract.js';
import { importCandidates, queryDistributions } from './importer.js';
import {
  assignMunicipalities,
  importMunicipalities,
  loadOverrides,
  loadRegister,
  matchBoundaries,
  readBoundaries,
} from './municipalities.js';
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

/**
 * The one entry point: CLI and the pg-boss `import.osm` job both call this.
 * Stages: municipality boundaries (admin_level=5 ↔ EKATTE register) →
 * facilities (merge policy) → municipality assignment (derived ST_Contains).
 * Idempotent by construction — cached checksummed download, deterministic
 * normalization, change-detected upserts.
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

  // Stage 1 inputs: municipality boundaries matched against the register.
  const boundariesPath = await runOsmiumBoundaries(extract.pbfPath, workDir);
  const [boundaries, register, overrides] = await Promise.all([
    readBoundaries(boundariesPath),
    loadRegister(),
    loadOverrides(),
  ]);
  const matchResult = matchBoundaries(boundaries, register, overrides);

  // Stage 2 inputs: facility candidates.
  const featuresPath = await runOsmium(extract.pbfPath, workDir);
  const collection = await collectCandidates(featuresPath);
  const candidates = [...collection.byKey.values()];

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  let stats: ImportStats;
  try {
    await client.query('BEGIN');
    const municipalityCounts = await importMunicipalities(client, matchResult.matched);
    const counts = await importCandidates(client, candidates);
    const assignment = await assignMunicipalities(client);
    const distributions = await queryDistributions(client);
    stats = {
      mode: dryRun ? 'dry-run' : 'live',
      startedAt,
      extractMd5: extract.md5,
      extractDownloaded: extract.downloaded,
      municipalities: {
        boundariesFound: boundaries.length,
        counts: municipalityCounts,
        unmatched: matchResult.unmatched,
        missingFromOsm: matchResult.missingFromOsm,
      },
      assignment,
      featuresTotal: collection.featuresTotal,
      skips: collection.skips,
      geometryTwins: collection.geometryTwins,
      candidates: candidates.length,
      counts,
      unmappedSports: collection.unmappedSports,
      unmappedSurfaces: collection.unmappedSurfaces,
      unusualLit: collection.unusualLit,
      noSportBuckets: collection.noSportBuckets,
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
