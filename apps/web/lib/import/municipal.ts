import {
  commitMunicipalImport,
  getPool,
  previewMunicipalRows,
  type CommitCounts,
  type Resolution,
  type RowPreview,
} from '@sportkarta/db';
import { guessColumn, parseCsv, type CsvDelimiter } from '@sportkarta/lib/csv';
import {
  MUNICIPAL_FIELDS,
  normalizeRow,
  type MunicipalField,
  type NormalizedRow,
  type RawRow,
  type RowError,
} from '@sportkarta/lib';

// The alias vocabulary and the sample file are DATA (header matching and a
// downloadable template), not translatable UI, so they live in JSON where
// apps/web/tests/i18n-hardcoded.test.ts expects Bulgarian text.
import csvColumns from '../csv-columns.json';

/**
 * The web adapter for the municipal CSV inbox (docs/ROADMAP.md §8, Stage 6.3).
 *
 * The importer itself lives in @sportkarta/db (dedupe + merge + write), taking a
 * pg client so a rolled-back test and this adapter share one implementation.
 * This file does the web-only work: parse the upload, guess the mapping, turn
 * mapped rows into normalised ones, and run the preview/commit over a pooled
 * connection with a real transaction — because a partial import must roll back
 * as a whole if anything unexpected throws.
 */

export const MUNICIPAL_ALIASES = csvColumns.municipal as Record<MunicipalField, readonly string[]>;

export type MunicipalMapping = Partial<Record<MunicipalField, number>>;

/** Best-effort header → field mapping for the mapping step's defaults. */
export function guessMunicipalMapping(headers: readonly string[]): MunicipalMapping {
  const mapping: MunicipalMapping = {};
  headers.forEach((header, index) => {
    const field = guessColumn(header, MUNICIPAL_ALIASES) as MunicipalField | undefined;
    if (field && mapping[field] === undefined) mapping[field] = index;
  });
  return mapping;
}

/**
 * Hard cap on one import. A municipal registry is a town's facilities, not a
 * country's; beyond this the operator has almost certainly pasted the wrong
 * file, and the per-row preview stops being something a person can read.
 */
export const MAX_MUNICIPAL_ROWS = 5000;

export class MunicipalFileError extends Error {
  constructor(readonly code: 'csv_truncated' | 'too_many_rows' | 'no_rows') {
    super(code);
    this.name = 'MunicipalFileError';
  }
}

/** Raw mapped rows from a CSV — pure, no normalisation yet. */
export function rowsFromCsv(
  text: string,
  mapping: MunicipalMapping,
  delimiter?: CsvDelimiter,
): RawRow[] {
  const parsed = parseCsv(text, delimiter);
  // A stray quote swallows every following row into one field, so the rows we
  // can see are not the rows in the file — refuse it rather than import a
  // silently truncated version.
  if (parsed.truncated) throw new MunicipalFileError('csv_truncated');
  if (parsed.rows.length === 0) throw new MunicipalFileError('no_rows');
  if (parsed.rows.length > MAX_MUNICIPAL_ROWS) throw new MunicipalFileError('too_many_rows');

  const at = (row: string[], field: MunicipalField): string => {
    const index = mapping[field];
    return index === undefined ? '' : (row[index] ?? '').trim();
  };
  return parsed.rows.map((row, i) => {
    const raw: RawRow = { rowNumber: i + 2 }; // header is row 1; operators count from 1
    for (const field of MUNICIPAL_FIELDS) raw[field] = at(row, field);
    return raw;
  });
}

export interface MunicipalRowView {
  rowNumber: number;
  name: string | null;
  /** 'new' | 'match' | 'conflict' | 'invalid'. */
  status: RowPreview['outcome']['kind'] | 'invalid';
  /** Set for invalid rows — an i18n slug under AdminMunicipalImport.rowError.*. */
  error?: string;
  /** Set for conflicts: the reason slug and the facilities it collides with. */
  conflictReason?: string;
  candidates?: {
    facilityId: string;
    name: string | null;
    slug: string | null;
    distanceM: number;
  }[];
  /** For a match, the facility it will update. */
  matchFacilityId?: string;
}

export interface MunicipalPreview {
  rows: MunicipalRowView[];
  counts: { new: number; match: number; conflict: number; invalid: number };
}

/**
 * Normalise + classify every row for the preview screen. Writes nothing.
 * Invalid rows never reach the database — they are filtered before the dedupe
 * query, so a malformed coordinate cannot become a PostGIS error.
 */
export async function previewMunicipal(rows: readonly RawRow[]): Promise<MunicipalPreview> {
  const normalized: NormalizedRow[] = [];
  const errors = new Map<number, RowError>();
  for (const raw of rows) {
    const outcome = normalizeRow(raw);
    if (outcome.ok) normalized.push(outcome.row);
    else errors.set(outcome.error.rowNumber, outcome.error);
  }

  // A pooled connection for the read-only preview; each query auto-checks-out.
  const previews = await previewMunicipalRows(getPool(), normalized);
  const previewByRow = new Map(previews.map((p) => [p.rowNumber, p]));

  const views: MunicipalRowView[] = rows.map((raw): MunicipalRowView => {
    const error = errors.get(raw.rowNumber);
    if (error) {
      return {
        rowNumber: raw.rowNumber,
        name: (raw.name ?? '').trim() || null,
        status: 'invalid',
        error: error.code,
      };
    }
    const preview = previewByRow.get(raw.rowNumber);
    if (!preview) {
      // Unreachable — a non-invalid row is always previewed — but never assume.
      return {
        rowNumber: raw.rowNumber,
        name: null,
        status: 'invalid',
        error: 'coordinates_required',
      };
    }
    const view: MunicipalRowView = {
      rowNumber: preview.rowNumber,
      name: preview.name,
      status: preview.outcome.kind,
    };
    if (preview.outcome.kind === 'match')
      view.matchFacilityId = preview.outcome.candidate.facilityId;
    if (preview.outcome.kind === 'conflict') {
      view.conflictReason = preview.outcome.reason;
      view.candidates = preview.outcome.candidates.map((c) => ({
        facilityId: c.facilityId,
        name: c.name,
        slug: c.slug,
        distanceM: Math.round(c.distanceM),
      }));
    }
    return view;
  });

  return {
    rows: views,
    counts: {
      new: views.filter((v) => v.status === 'new').length,
      match: views.filter((v) => v.status === 'match').length,
      conflict: views.filter((v) => v.status === 'conflict').length,
      invalid: views.filter((v) => v.status === 'invalid').length,
    },
  };
}

/**
 * Commit an import inside one transaction over a pooled client. Re-normalises
 * and re-classifies every row (the db core does the latter) — the posted
 * preview is a rendering, never an authorisation.
 */
export async function commitMunicipal(
  rows: readonly RawRow[],
  resolutions: Record<number, Resolution>,
  registryLabel: string,
): Promise<CommitCounts & { invalid: number }> {
  const normalized: NormalizedRow[] = [];
  let invalid = 0;
  for (const raw of rows) {
    const outcome = normalizeRow(raw);
    if (outcome.ok) normalized.push(outcome.row);
    else invalid += 1;
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const counts = await commitMunicipalImport(
      client,
      { rows: normalized, resolutions, registryLabel },
      new Date(),
    );
    await client.query('COMMIT');
    return { ...counts, invalid };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function sampleCsv(): string {
  return (csvColumns.municipalSample as string[]).join('\r\n') + '\r\n';
}
