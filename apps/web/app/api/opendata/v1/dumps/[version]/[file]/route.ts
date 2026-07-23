import { dumpEntry, getDb } from '@sportkarta/db';
import { licenseText, OPEN_DATA_LICENSE } from '@sportkarta/lib/opendata';

import { corsHeaders, licenseHeaders, openDataOptions } from '@/lib/opendata/response';
import { getStorage } from '@/lib/storage';

/**
 * Serving one published dump artifact (Stage 6.1).
 *
 * THE ROW DECIDES, NOT THE PATH. The requested version and filename are looked
 * up in opendata_dumps, and the storage key served is the one the ROW holds —
 * never a path assembled from the URL. Two consequences, both deliberate:
 * traversal is not merely blocked but unexpressible (no user input reaches the
 * storage key at all), and a file that exists on the volume but was never
 * recorded — a leftover, a half-written artifact from an interrupted run — is
 * not reachable. Only what we published is downloadable.
 *
 * A ROW WITHOUT ITS FILE IS A 404, NOT A 500 AND NOT A TRUNCATED BODY. Migration
 * 0015 names this case: restore the database without the volume and the index
 * outlives the artifacts. A clean 404 is the honest answer.
 *
 * NOT RATE LIMITED, like the manifest. Handing over the whole dataset is what
 * the API's soft limit points people towards; metering it would close the exit.
 *
 * `Content-Disposition: attachment` on every artifact: these are files, and a
 * 2 MB CSV rendered inline in a browser tab helps nobody.
 */

export const dynamic = 'force-dynamic';

/** Filenames the version directory serves that are not catalogue datasets. */
const LICENSE_FILE = 'LICENSE.txt';

const CONTENT_TYPES: Record<string, string> = {
  csv: 'text/csv; charset=utf-8',
  geojson: 'application/geo+json; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/** `YYYY-MM-DD`, matching the civil Sofia version in opendata_dumps. */
const VERSION_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `<dataset>.<format>`; the dataset itself is checked against the table. */
const FILE_RE = /^([a-z][a-z0-9-]*)\.([a-z]+)$/;

export function OPTIONS() {
  return openDataOptions();
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { ...corsHeaders(), 'Cache-Control': 'no-store' },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ version: string; file: string }> },
) {
  const { version, file } = await params;
  if (!VERSION_RE.test(version)) return notFound();

  // The licence text is generated, not stored: it is the same for every
  // version but for the version line, so writing it to the volume would be one
  // more artifact to keep in step with lib/src/opendata/serialize.ts.
  if (file === LICENSE_FILE) {
    return new Response(licenseText(version), {
      headers: {
        ...corsHeaders(),
        ...licenseHeaders(),
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  }

  const match = FILE_RE.exec(file);
  if (!match) return notFound();
  const [, dataset, format] = match;
  if (!dataset || !format) return notFound();

  const entry = await dumpEntry(getDb(), version, dataset, format);
  if (!entry) return notFound();

  let bytes: Uint8Array;
  try {
    // The key comes from the ROW. Nothing from the URL reaches this call.
    bytes = await getStorage().get(entry.storagePath);
  } catch {
    // Indexed but absent — the database outlived the volume. 404 rather than
    // a 500: nothing is broken here, the artifact is simply gone.
    return notFound();
  }

  return new Response(new Uint8Array(bytes), {
    headers: {
      ...corsHeaders(),
      ...licenseHeaders(),
      'Content-Type': CONTENT_TYPES[format] ?? 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'Content-Disposition': `attachment; filename="${dataset}-${version}.${format}"`,
      // A published version is immutable: same URL, same bytes, forever (or
      // until retention removes it). Nothing else in this app can say that,
      // which is why this is the one place with a year-long max-age.
      'Cache-Control': 'public, max-age=31536000, immutable',
      // The checksum travels with the file, so a consumer can verify what they
      // downloaded without a second request to the manifest.
      'X-Checksum-Sha256': entry.sha256,
      'X-License': OPEN_DATA_LICENSE.id,
    },
  });
}
