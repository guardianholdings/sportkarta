import { createHash } from 'node:crypto';

import {
  dumpGeneratedAt,
  dumpStoragePath,
  dumpVersionFor,
  getDb,
  pruneDumps,
  recordDump,
  runExport,
} from '@sportkarta/db';
import {
  dumpArtifacts,
  extensionFor,
  licenseText,
  serializeCsv,
  serializeGeoJSON,
  serializeJson,
  type ExportDataset,
  type ExportFormat,
} from '@sportkarta/lib/opendata';
import { LocalVolumeStorage, type StorageAdapter } from '@sportkarta/lib/storage';

/**
 * The nightly versioned bulk dump (docs/ROADMAP.md §8, Stage 6.1).
 *
 * VERSIONED BY PATH, NEVER OVERWRITTEN IN PLACE. Every artifact is written to
 * `opendata/<civil Sofia date>/<dataset>.<ext>`, so yesterday's download keeps
 * working after tonight's run and a report that cites a version can still be
 * checked against it. "Latest" is a query, not a file that gets rewritten under
 * whoever is mid-download.
 *
 * DETERMINISTIC PER VERSION, AND THAT IS LOAD-BEARING RATHER THAN TIDY. Every
 * dataset's ORDER BY is total (a uuid primary key, an EKATTE code, a sport
 * slug), so two runs over an unchanged corpus produce byte-identical files.
 *
 * The catch, found by re-running the job and diffing: GeoJSON and JSON embed a
 * `generated_at`, so with a wall-clock timestamp the CSVs matched across runs
 * and those two did not. That is not cosmetic. A dump URL is served
 * `Cache-Control: immutable` with a year-long max-age, on the promise that a
 * published version's bytes never change — and a same-day re-run that rewrote
 * the file would leave caches serving bytes whose checksum no longer matched
 * the manifest, with no way for a consumer to tell. So the dump stamps
 * `generated_at` with THE VERSION, not the moment the job happened to run:
 * the version is the meaningful date for a nightly artifact anyway, and it
 * makes the immutability promise true instead of nearly true.
 *
 * Re-running the job on the same day is therefore safe and boring, which is
 * what you want of the thing you reach for when something looks wrong.
 *
 * THE ROW GOES IN AFTER THE FILE IS WRITTEN AND HASHED — never before. The
 * manifest is read from the table, so a row is a promise that the artifact
 * exists and has that checksum. Writing the row first would advertise a file
 * that a crash could leave half-written, and the checksum would be a lie about
 * bytes nobody could verify.
 *
 * ONE DATASET'S FAILURE DOES NOT SINK THE VERSION. Each artifact is written
 * independently and failures are counted and reported; a version with three of
 * four datasets is a partial publication somebody can see and fix, while an
 * all-or-nothing job that aborts on the first error publishes nothing at all
 * for a week before anybody notices.
 *
 * NOTHING IN THIS JOB TOUCHES A PERSON. It reads only what the catalogue
 * declares, and the catalogue can only name allowlisted aggregate relations and
 * the facility corpus (lib/src/opendata/pii.test.ts). The job has no more
 * privilege to publish than a request to /api/opendata does.
 */

/**
 * Versions kept on the volume. Generous, because pruning a version destroys the
 * ability to verify a figure somebody cited from it — /danni says so, and the
 * checksum is what lets a reuser keep their own copy and prove it is ours.
 */
const DEFAULT_RETENTION = 30;

export interface DumpReport {
  version: string;
  written: number;
  failed: number;
  bytes: number;
  prunedVersions: number;
}

function storage(): StorageAdapter {
  const rootDir = process.env.STORAGE_DIR;
  if (!rootDir) {
    // The worker writes to the same volume the web app reads (deploy/
    // compose.prod.yml mounts `uploads` into both). Without it the job would
    // write into the container's ephemeral filesystem and every dump would
    // vanish on the next deploy, silently.
    throw new Error('STORAGE_DIR is required for the open-data dump job (see .env.example)');
  }
  return new LocalVolumeStorage({ rootDir });
}

function serialize(
  dataset: ExportDataset,
  format: ExportFormat,
  rows: Record<string, unknown>[],
  generatedAt: Date,
): string {
  if (format === 'csv') return serializeCsv(dataset, rows);
  if (format === 'geojson') {
    return JSON.stringify(serializeGeoJSON(dataset, rows, generatedAt));
  }
  return JSON.stringify(serializeJson(dataset, rows, generatedAt));
}

export async function runOpenDataDump(options: { now?: Date } = {}): Promise<DumpReport> {
  const now = options.now ?? new Date();
  const version = dumpVersionFor(now);
  // The stamp embedded in every artifact IS the version — see the header. A
  // wall-clock `now` here would make two runs of the same version disagree on
  // their bytes while both claiming to be that version.
  const generatedAt = dumpGeneratedAt(version);
  const db = getDb();
  const files = storage();

  let written = 0;
  let failed = 0;
  let bytes = 0;

  for (const { dataset, format } of dumpArtifacts()) {
    const key = dumpStoragePath(version, dataset.id, extensionFor(format));
    try {
      const rows = await runExport(db, dataset);
      const body = Buffer.from(serialize(dataset, format, rows, generatedAt), 'utf8');
      const sha256 = createHash('sha256').update(body).digest('hex');

      await files.put(key, body, {
        contentType: format === 'csv' ? 'text/csv' : 'application/json',
      });
      // Only now: the artifact is on the volume and hashed.
      await recordDump(db, {
        version,
        dataset: dataset.id,
        format,
        storagePath: key,
        bytes: body.byteLength,
        rowCount: rows.length,
        sha256,
      });

      written += 1;
      bytes += body.byteLength;
    } catch (error) {
      failed += 1;
      // The dataset id and format are catalogue constants, not user text, so
      // they are safe to log; the underlying message is not repeated, since a
      // database error can embed a row's contents.
      console.error(
        `[worker] opendata.dump ${version} ${dataset.id}.${format} failed: ${
          error instanceof Error ? error.name : 'unknown'
        }`,
      );
    }
  }

  // The licence beside the files, because a CSV cannot carry one in-band
  // without ceasing to be a CSV (lib/src/opendata/serialize.ts).
  try {
    await files.put(`opendata/${version}/LICENSE.txt`, Buffer.from(licenseText(version), 'utf8'), {
      contentType: 'text/plain',
    });
  } catch {
    failed += 1;
  }

  // Retention runs only after a successful write of at least one artifact:
  // pruning on a night when everything failed would delete good old versions
  // and leave nothing in their place.
  let prunedVersions = 0;
  if (written > 0) {
    const retention = Number(process.env.OPENDATA_DUMP_RETENTION ?? DEFAULT_RETENTION);
    const keep =
      Number.isFinite(retention) && retention > 0 ? Math.floor(retention) : DEFAULT_RETENTION;
    // The row goes first and the file second — a file with no row is invisible
    // and harmless, a row with no file is a broken download.
    const removed = await pruneDumps(db, keep);
    const versions = new Set(removed.map((entry) => entry.version));
    for (const entry of removed) {
      try {
        await files.delete(entry.storagePath);
      } catch {
        // Already gone, or the volume is read-only. The row is what the
        // manifest reads, and it is gone either way.
      }
    }
    for (const pruned of versions) {
      try {
        await files.delete(`opendata/${pruned}/LICENSE.txt`);
      } catch {
        /* as above */
      }
    }
    prunedVersions = versions.size;
  }

  return { version, written, failed, bytes, prunedVersions };
}
