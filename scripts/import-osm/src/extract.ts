import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
