import os from 'node:os';
import path from 'node:path';

// os.tmpdir() is world-writable, so the download cache works for any user — in
// particular the prod worker container's unprivileged `node`, which cannot write
// under the root-owned /app. The extract is a re-downloadable, md5-gated public
// file, so a non-persistent tmp cache is fine; set OSM_CACHE_DIR to a writable
// mounted volume to persist it across container restarts.
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'sportkarta-osm-cache');

/**
 * Resolve the OSM download-cache directory used by both import and audit.
 * Precedence: explicit option → OSM_CACHE_DIR env → tmpdir default. A blank or
 * whitespace-only env value falls back to the default rather than resolving to
 * an empty path.
 */
export function resolveCacheDir(explicit?: string): string {
  return explicit ?? (process.env.OSM_CACHE_DIR?.trim() || DEFAULT_CACHE_DIR);
}
