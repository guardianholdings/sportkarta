import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import {
  normalizeFeature,
  preferCandidate,
  type FacilityCandidate,
  type OsmFeature,
} from './normalize.js';

const execFileAsync = promisify(execFile);

/** Stream RFC 8142 geojsonseq (RS + JSON + LF records) as parsed features. */
export async function* readFeatures(featuresPath: string): AsyncGenerator<OsmFeature> {
  const rl = createInterface({
    input: createReadStream(featuresPath),
    crlfDelay: Infinity,
  });
  for await (const rawLine of rl) {
    const line = (rawLine.charCodeAt(0) === 0x1e ? rawLine.slice(1) : rawLine).trim();
    if (!line) continue;
    yield JSON.parse(line) as OsmFeature;
  }
}

export interface CandidateCollection {
  byKey: Map<string, FacilityCandidate>;
  featuresTotal: number;
  geometryTwins: number;
  skips: Record<string, number>;
  unmappedSports: Record<string, number>;
  unmappedSurfaces: Record<string, number>;
  unusualLit: Record<string, number>;
  noSportBuckets: Record<string, number>;
}

function bump(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

/** Normalize + dedupe the exported facility features (shared by run and audit). */
export async function collectCandidates(featuresPath: string): Promise<CandidateCollection> {
  const c: CandidateCollection = {
    byKey: new Map(),
    featuresTotal: 0,
    geometryTwins: 0,
    skips: {},
    unmappedSports: {},
    unmappedSurfaces: {},
    unusualLit: {},
    noSportBuckets: {},
  };

  for await (const feature of readFeatures(featuresPath)) {
    c.featuresTotal += 1;
    const result = normalizeFeature(feature);
    if (result.kind === 'skip') {
      bump(c.skips, result.reason);
      continue;
    }
    const cand = result.candidate;
    const key = `${cand.osmType}:${String(cand.osmId)}`;
    const twin = c.byKey.get(key);
    if (twin) {
      // Closed ways export twice (area + perimeter ring) — count, prefer polygon.
      c.geometryTwins += 1;
      c.byKey.set(key, preferCandidate(twin, cand));
      continue;
    }
    c.byKey.set(key, cand);
    for (const token of cand.unmappedSports) bump(c.unmappedSports, token);
    if (cand.unmappedSurface !== undefined) bump(c.unmappedSurfaces, cand.unmappedSurface);
    if (cand.unusualLit !== undefined) bump(c.unusualLit, cand.unusualLit);
    if (cand.noSportBucket !== undefined) bump(c.noSportBuckets, cand.noSportBucket);
  }
  return c;
}

/**
 * osmium two-step: tags-filter narrows the country extract to candidate
 * objects, export assembles geometries (ways/relations → polygons or lines)
 * as line-delimited GeoJSON (RFC 8142) with `-u type_id` original-object ids.
 *
 * Install: `brew install osmium-tool` (macOS dev) / `apk add osmium-tool`
 * (worker image — see Dockerfile).
 */
export async function runOsmium(pbfPath: string, workDir: string): Promise<string> {
  try {
    await execFileAsync('osmium', ['--version']);
  } catch {
    throw new Error(
      'osmium not found — install with `brew install osmium-tool` (macOS) or `apk add osmium-tool` (alpine)',
    );
  }

  const filteredPath = path.join(workDir, 'filtered.osm.pbf');
  const featuresPath = path.join(workDir, 'features.geojsonseq');

  await execFileAsync('osmium', [
    'tags-filter',
    pbfPath,
    'nwr/leisure=pitch,fitness_station,sports_centre,track',
    'nwr/sport',
    '-O',
    '-o',
    filteredPath,
  ]);

  await execFileAsync('osmium', [
    'export',
    filteredPath,
    '-f',
    'geojsonseq',
    '-u',
    'type_id',
    '-O',
    '-o',
    featuresPath,
  ]);

  return featuresPath;
}

/**
 * Municipality boundaries: two-pass AND filter (osmium expressions OR by
 * default) — boundary=administrative, then admin_level=5. In Bulgarian OSM,
 * общини are admin_level=5 (verified: exactly 265 relations); level 8 is
 * землища (settlement land boundaries, ~2,000).
 */
export async function runOsmiumBoundaries(pbfPath: string, workDir: string): Promise<string> {
  const adminPath = path.join(workDir, 'admin.osm.pbf');
  const level5Path = path.join(workDir, 'admin5.osm.pbf');
  const featuresPath = path.join(workDir, 'municipalities.geojsonseq');

  await execFileAsync('osmium', [
    'tags-filter',
    pbfPath,
    'r/boundary=administrative',
    '-O',
    '-o',
    adminPath,
  ]);
  await execFileAsync('osmium', [
    'tags-filter',
    adminPath,
    'r/admin_level=5',
    '-O',
    '-o',
    level5Path,
  ]);
  await execFileAsync('osmium', [
    'export',
    level5Path,
    '-f',
    'geojsonseq',
    '-u',
    'type_id',
    '-O',
    '-o',
    featuresPath,
  ]);

  return featuresPath;
}
