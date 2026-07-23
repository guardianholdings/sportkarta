import { dumpManifest, dumpVersions, getDb } from '@sportkarta/db';
import { OPEN_DATA_LICENSE } from '@sportkarta/lib/opendata';

import { openDataJson, openDataOptions, siteAbsolute, UNMETERED } from '@/lib/opendata/response';

/**
 * The dump index (Stage 6.1): every published version, newest first, with the
 * newest one's files inline so a consumer needs one request rather than two.
 *
 * NOT RATE LIMITED, and neither are the files themselves. That is the whole
 * point of a soft limit: the correct response to somebody hammering the API is
 * to hand them the complete dataset in one file, and throttling the file too
 * would leave a determined consumer no legitimate path at all.
 *
 * Reads opendata_dumps rather than listing the storage volume — the table is
 * the index and the file is the artifact (migration 0015). A directory listing
 * would also show a half-written file during the nightly run.
 */

export const dynamic = 'force-dynamic';

export function OPTIONS() {
  return openDataOptions();
}

export async function GET() {
  const db = getDb();
  const versions = await dumpVersions(db);
  const latest = versions[0] ? await dumpManifest(db, versions[0]) : null;

  return openDataJson(
    {
      license: OPEN_DATA_LICENSE.id,
      license_url: OPEN_DATA_LICENSE.url,
      attribution: OPEN_DATA_LICENSE.attribution,
      documentation: siteAbsolute('/danni'),
      latest_version: versions[0] ?? null,
      versions,
      files: (latest?.files ?? []).map((file) => ({
        dataset: file.dataset,
        format: file.format,
        bytes: file.bytes,
        row_count: file.rowCount,
        sha256: file.sha256,
        url: siteAbsolute(`/api/opendata/v1/dumps/${file.version}/${file.dataset}.${file.format}`),
      })),
    },
    UNMETERED,
  );
}
