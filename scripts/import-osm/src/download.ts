import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

const EXTRACT_URL = 'https://download.geofabrik.de/europe/bulgaria-latest.osm.pbf';
const PBF_NAME = 'bulgaria-latest.osm.pbf';

export interface ExtractInfo {
  pbfPath: string;
  md5: string;
  downloaded: boolean;
}

async function fileMd5(filePath: string): Promise<string> {
  const hash = createHash('md5');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}

/**
 * Idempotent cached download: the extract is re-fetched only when Geofabrik's
 * published .md5 differs from the cached file's checksum. With
 * skipDownload=true a cached file is used as-is (offline/dev loop).
 */
export async function ensureExtract(
  cacheDir: string,
  options: { skipDownload?: boolean } = {},
): Promise<ExtractInfo> {
  await mkdir(cacheDir, { recursive: true });
  const pbfPath = path.join(cacheDir, PBF_NAME);
  const cached = existsSync(pbfPath);

  if (options.skipDownload) {
    if (!cached) {
      throw new Error(`--skip-download set but no cached extract at ${pbfPath}`);
    }
    return { pbfPath, md5: await fileMd5(pbfPath), downloaded: false };
  }

  const md5Response = await fetch(`${EXTRACT_URL}.md5`);
  if (!md5Response.ok) {
    throw new Error(`Geofabrik md5 fetch failed: HTTP ${String(md5Response.status)}`);
  }
  const remoteMd5 = (await md5Response.text()).trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{32}$/.test(remoteMd5)) {
    throw new Error(`Geofabrik md5 file looks wrong: "${remoteMd5}"`);
  }

  if (cached) {
    const localMd5 = await fileMd5(pbfPath);
    if (localMd5 === remoteMd5) {
      return { pbfPath, md5: localMd5, downloaded: false };
    }
  }

  const response = await fetch(EXTRACT_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Geofabrik download failed: HTTP ${String(response.status)}`);
  }
  const tmpPath = `${pbfPath}.download`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tmpPath));

  const downloadedMd5 = await fileMd5(tmpPath);
  if (downloadedMd5 !== remoteMd5) {
    throw new Error(
      `Checksum mismatch after download: expected ${remoteMd5}, got ${downloadedMd5}`,
    );
  }
  await rename(tmpPath, pbfPath);
  await writeFile(`${pbfPath}.md5`, `${remoteMd5}  ${PBF_NAME}\n`);
  return { pbfPath, md5: downloadedMd5, downloaded: true };
}

/** Best-effort read of the cached extract's Geofabrik timestamp (osmium later). */
export async function readCachedMd5(cacheDir: string): Promise<string | null> {
  try {
    const content = await readFile(path.join(cacheDir, `${PBF_NAME}.md5`), 'utf8');
    return content.trim().split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}
