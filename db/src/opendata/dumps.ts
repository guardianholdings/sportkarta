import { OPEN_DATA_LICENSE, type ExportFormat } from '@sportkarta/lib/opendata';
import { instantToWall, SOFIA_TZ } from '@sportkarta/lib/recurrence';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The index of published bulk dumps (Stage 6.1).
 *
 * The table is the index and the file is the artifact (migration 0015): every
 * read here answers "what have we published?" from rows written after their
 * files were complete, never from a directory listing that would also show a
 * half-written file mid-dump.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface DumpEntry {
  version: string;
  dataset: string;
  format: ExportFormat;
  storagePath: string;
  bytes: number;
  rowCount: number;
  sha256: string;
  createdAt: string;
}

export interface DumpManifest {
  version: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  files: DumpEntry[];
}

/**
 * The version a dump produced at `now` belongs to: the CIVIL Sofia date.
 *
 * Uses the project's own zone primitive rather than `toLocaleDateString`,
 * because the same reasoning as Stage 4.1 applies for the same reason — the
 * nightly job runs at 03:40 Sofia, which is 00:40 UTC in summer, so a UTC date
 * would file four months of the year's dumps under the previous day. The
 * version is what a municipal report cites; it has to be the day a person in
 * Sofia would call it.
 */
export function dumpVersionFor(now: Date = new Date()): string {
  const wall = instantToWall(now.getTime(), SOFIA_TZ);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(wall.year)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/**
 * The `generated_at` a dump's artifacts carry: derived from the VERSION, never
 * from the wall clock.
 *
 * A dump URL is served `Cache-Control: immutable` with a year-long max-age, on
 * the promise that a published version's bytes never change. GeoJSON and JSON
 * embed `generated_at`, so stamping it with the moment the job ran would make a
 * same-day re-run rewrite those files — leaving caches serving bytes whose
 * checksum no longer matched the manifest, invisibly. Deriving it from the
 * version makes the immutability promise true rather than nearly true, and the
 * version is the meaningful date for a nightly artifact in any case.
 */
export function dumpGeneratedAt(version: string): Date {
  return new Date(`${version}T00:00:00Z`);
}

/** Storage key for one artifact. Versioned by path; never overwritten in place. */
export function dumpStoragePath(version: string, dataset: string, extension: string): string {
  return `opendata/${version}/${dataset}.${extension}`;
}

function toEntry(row: Record<string, unknown>): DumpEntry {
  return {
    // `date` comes back as a Date from node-postgres in some configurations and
    // a string in others; the version is an identifier, so it is normalised to
    // its civil-date text either way rather than left to the driver.
    version:
      row.version instanceof Date
        ? (row.version.toISOString().slice(0, 10) as string)
        : String(row.version),
    dataset: String(row.dataset),
    format: String(row.format) as ExportFormat,
    storagePath: String(row.storage_path),
    bytes: Number(row.bytes),
    rowCount: Number(row.row_count),
    sha256: String(row.sha256),
    createdAt: row.created_at ? new Date(String(row.created_at)).toISOString() : '',
  };
}

/**
 * Record one published artifact.
 *
 * ON CONFLICT DO UPDATE rather than DO NOTHING: a same-day re-run republishes
 * the same version, and because every dataset's ORDER BY is total the bytes are
 * identical anyway — but if the corpus changed between runs, the row must
 * describe the file that is actually on disk. A stale sha256 pointing at a
 * replaced file is worse than no checksum at all, because it silently fails
 * verification for somebody who did nothing wrong.
 */
export async function recordDump(
  db: SqlRunner,
  entry: Omit<DumpEntry, 'createdAt'>,
): Promise<void> {
  await db.execute(sql`
    INSERT INTO opendata_dumps (version, dataset, format, storage_path, bytes, row_count, sha256)
    VALUES (${entry.version}, ${entry.dataset}, ${entry.format}, ${entry.storagePath},
            ${entry.bytes}, ${entry.rowCount}, ${entry.sha256})
    ON CONFLICT (version, dataset, format) DO UPDATE
      SET storage_path = EXCLUDED.storage_path,
          bytes        = EXCLUDED.bytes,
          row_count    = EXCLUDED.row_count,
          sha256       = EXCLUDED.sha256,
          created_at   = now()
  `);
}

/** Published versions, newest first. */
export async function dumpVersions(db: SqlRunner, limit = 60): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT version FROM opendata_dumps ORDER BY version DESC LIMIT ${limit}
  `);
  return result.rows.map((row) =>
    row.version instanceof Date ? row.version.toISOString().slice(0, 10) : String(row.version),
  );
}

/** Every artifact in one version, or an empty manifest when it is unknown. */
export async function dumpManifest(db: SqlRunner, version: string): Promise<DumpManifest> {
  const result = await db.execute(sql`
    SELECT version, dataset, format, storage_path, bytes, row_count, sha256, created_at
    FROM opendata_dumps
    WHERE version = ${version}
    ORDER BY dataset, format
  `);
  return {
    version,
    license: OPEN_DATA_LICENSE.id,
    licenseUrl: OPEN_DATA_LICENSE.url,
    attribution: OPEN_DATA_LICENSE.attribution,
    files: result.rows.map(toEntry),
  };
}

/** The newest published version, or null before the first dump has run. */
export async function latestDumpVersion(db: SqlRunner): Promise<string | null> {
  const versions = await dumpVersions(db, 1);
  return versions[0] ?? null;
}

/** One artifact, for the download route. Null when it was never published. */
export async function dumpEntry(
  db: SqlRunner,
  version: string,
  dataset: string,
  format: string,
): Promise<DumpEntry | null> {
  const result = await db.execute(sql`
    SELECT version, dataset, format, storage_path, bytes, row_count, sha256, created_at
    FROM opendata_dumps
    WHERE version = ${version} AND dataset = ${dataset} AND format = ${format}
  `);
  const row = result.rows[0];
  return row ? toEntry(row) : null;
}

/**
 * Retention. Deleting old dumps is a deliberate policy, not housekeeping: a
 * version that disappears takes with it the ability to verify a figure somebody
 * cited from it. `keep` is therefore generous by default and stated on /danni,
 * so a reuser who needs a version indefinitely knows to keep their own copy —
 * which the checksum lets them prove is the one we published.
 *
 * Returns the rows it removed so the caller can delete their files. The row
 * goes first and the file second, which is the safe order: a file with no row
 * is invisible and harmless, while a row with no file is a broken download.
 */
export async function pruneDumps(db: SqlRunner, keep: number): Promise<DumpEntry[]> {
  const versions = await dumpVersions(db, keep + 1);
  if (versions.length <= keep) return [];
  const cutoff = versions[keep];
  if (!cutoff) return [];
  const result = await db.execute(sql`
    DELETE FROM opendata_dumps
    WHERE version <= ${cutoff}
    RETURNING version, dataset, format, storage_path, bytes, row_count, sha256, created_at
  `);
  return result.rows.map(toEntry);
}
