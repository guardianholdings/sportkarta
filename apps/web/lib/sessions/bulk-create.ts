import { sql, type SQL } from '@sportkarta/db';
import { guessColumn, parseCsv, type CsvDelimiter } from '@sportkarta/lib/csv';
import { formatRrule, parseRrule, RecurrenceError } from '@sportkarta/lib/recurrence';

// The alias vocabulary and the sample file are DATA (input matching and a
// downloadable template), not translatable UI copy — so they live in JSON,
// where apps/web/tests/i18n-hardcoded.test.ts expects Bulgarian text to be.
import csvColumns from '../csv-columns.json';

import { SessionError } from './errors';
import { normalizeSession, type NormalizedSession, type SessionInput } from './session-input';
import { firstInstantOf } from './sessions';

/**
 * Admin bulk-create for the сдружение's official weekly slots
 * (docs/ROADMAP.md §6, Stage 4.5).
 *
 * The real task is "the same slot at thirty playgrounds", so the grid path —
 * choose the slot once, tick facilities — is the primary one and the CSV path
 * is for when the slots genuinely differ. Both converge here, so validation,
 * the preview and the commit rule are identical whichever way a row arrived.
 *
 * COMMIT-VALID, SKIP-INVALID. A file with three bad rows out of two hundred
 * must not force a re-upload. Every skipped row is returned with the reason and
 * its 1-based row number, and the result screen lists them — a partial import
 * the operator can read beats an all-or-nothing rejection they cannot act on.
 * Each row is its own transaction, so a failure late in the file cannot
 * half-create the rows before it.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/** The fields a CSV column can be mapped to. `facility` accepts a slug or id. */
export const BULK_FIELDS = [
  'facility',
  'sport',
  'title',
  'description',
  'date',
  'time',
  'duration',
  'rrule',
  'capacity',
  'skillLevel',
  'visibility',
] as const;
export type BulkField = (typeof BULK_FIELDS)[number];

/**
 * Header aliases for the auto-guess, in both languages. Getting this right is
 * the difference between "map eleven columns by hand" and "press confirm".
 */
export const BULK_HEADER_ALIASES = csvColumns.bulk as Record<BulkField, readonly string[]>;

export type ColumnMapping = Partial<Record<BulkField, number>>;

/** Best-effort mapping from a header row, for the mapping step's defaults. */
export function guessMapping(headers: readonly string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  headers.forEach((header, index) => {
    const field = guessColumn(header, BULK_HEADER_ALIASES) as BulkField | undefined;
    if (field && mapping[field] === undefined) mapping[field] = index;
  });
  return mapping;
}

export interface BulkRowInput {
  /** 1-based, counting the header as row 1 — what the operator sees. */
  rowNumber: number;
  facility: string;
  sport: string;
  title: string;
  description?: string;
  date: string;
  time: string;
  duration: string;
  rrule?: string;
  capacity?: string;
  skillLevel?: string;
  visibility?: string;
}

export interface BulkRowPreview {
  rowNumber: number;
  /** Echoed back so the preview table can show what it read. */
  facility: string;
  title: string;
  ok: boolean;
  /** i18n slug under AdminBulkSessions/Sessions error keys. */
  error?: string;
  normalized?: NormalizedSession;
}

export interface BulkPreview {
  rows: BulkRowPreview[];
  validCount: number;
  skippedCount: number;
}

/**
 * Hard cap on a single import. Beyond this the preview payload and the
 * one-transaction-per-row commit stop being reasonable, and an operator has
 * almost certainly pasted the wrong thing.
 */
export const MAX_IMPORT_ROWS = 2000;

/** Thrown for a file that must not be imported at all, rather than partially. */
export class CsvFileError extends Error {
  constructor(readonly code: 'csv_truncated' | 'too_many_rows') {
    super(code);
    this.name = 'CsvFileError';
  }
}

/** Read a CSV into rows using a column mapping. Pure — no database. */
export function rowsFromCsv(
  text: string,
  mapping: ColumnMapping,
  delimiter?: CsvDelimiter,
): BulkRowInput[] {
  const parsed = parseCsv(text, delimiter);
  // A stray quote swallows every following row into one field, so the rows we
  // can see are not the rows in the file. Importing them would silently drop
  // the rest — refuse the whole file instead.
  if (parsed.truncated) throw new CsvFileError('csv_truncated');
  if (parsed.rows.length > MAX_IMPORT_ROWS) throw new CsvFileError('too_many_rows');
  const at = (row: string[], field: BulkField): string => {
    const index = mapping[field];
    return index === undefined ? '' : (row[index] ?? '').trim();
  };
  return parsed.rows.map((row, i) => ({
    // +2: the header is row 1 and the operator counts from 1.
    rowNumber: i + 2,
    facility: at(row, 'facility'),
    sport: at(row, 'sport'),
    title: at(row, 'title'),
    description: at(row, 'description'),
    date: at(row, 'date'),
    time: at(row, 'time'),
    duration: at(row, 'duration'),
    rrule: at(row, 'rrule'),
    capacity: at(row, 'capacity'),
    skillLevel: at(row, 'skillLevel'),
    visibility: at(row, 'visibility'),
  }));
}

/**
 * The grid path: one slot, many facilities. Expands to the same row shape the
 * CSV path produces, so there is exactly one validation and one commit.
 */
export interface GridInput {
  facilityIds: readonly string[];
  sport: string;
  title: string;
  description?: string;
  /** First date, `YYYY-MM-DD`. */
  date: string;
  /** `HH:MM`. */
  time: string;
  durationMinutes: number;
  /** ISO weekdays 1–7; empty = a one-off on `date`. */
  weekdays: readonly number[];
  capacity?: number | null;
  skillLevel?: string;
  visibility?: string;
}

export function rowsFromGrid(input: GridInput): BulkRowInput[] {
  // Weekly on the chosen days, forever — the сдружение's slots are standing
  // fixtures, and an organiser cancels the series when it ends.
  const rrule =
    input.weekdays.length > 0
      ? formatRrule({
          freq: 'WEEKLY',
          interval: 1,
          byDay: [...input.weekdays].sort((a, b) => a - b),
        })
      : '';
  return input.facilityIds.map((facilityId, i) => ({
    rowNumber: i + 1,
    facility: facilityId,
    sport: input.sport,
    title: input.title,
    description: input.description ?? '',
    date: input.date,
    time: input.time,
    duration: String(input.durationMinutes),
    rrule,
    capacity: input.capacity === null || input.capacity === undefined ? '' : String(input.capacity),
    skillLevel: input.skillLevel ?? 'any',
    visibility: input.visibility ?? 'public',
  }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve facility references (slug OR id) in ONE query rather than per row —
 * a 200-row file must not be 200 round trips. Returns only usable facilities;
 * `gone` ones are deliberately excluded so the row fails with a reason.
 */
async function resolveFacilities(
  db: SqlRunner,
  references: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(references.filter((r) => r !== ''))];
  if (wanted.length === 0) return new Map();
  const ids = wanted.filter((r) => UUID_RE.test(r));
  const slugs = wanted.filter((r) => !UUID_RE.test(r));
  const result = await db.execute(sql`
    SELECT id, slug FROM facilities
     WHERE status <> 'gone'
       AND (id = ANY(${sql.param(ids)}::uuid[]) OR slug = ANY(${sql.param(slugs)}::text[]))
  `);
  const found = new Map<string, string>();
  for (const row of result.rows) {
    const id = String(row.id);
    found.set(id, id);
    if (row.slug !== null) found.set(String(row.slug), id);
  }
  return found;
}

/**
 * Validate every row without writing anything. This is what the preview screen
 * renders, and — crucially — the same function the commit re-runs, so what the
 * operator approved is what gets created.
 */
export async function previewBulkRows(
  db: SqlRunner,
  rows: readonly BulkRowInput[],
): Promise<BulkPreview> {
  const facilities = await resolveFacilities(
    db,
    rows.map((row) => row.facility),
  );

  const previews = rows.map((row): BulkRowPreview => {
    const base = { rowNumber: row.rowNumber, facility: row.facility, title: row.title };
    const facilityId = facilities.get(row.facility);
    if (!facilityId) return { ...base, ok: false, error: 'facility_not_found' };

    const input: SessionInput = {
      facilityId,
      sport: row.sport,
      title: row.title,
      description: row.description ?? null,
      startsAtLocal: `${row.date}T${row.time}`,
      rrule: row.rrule ?? null,
      durationMinutes: Number(row.duration),
      capacity: row.capacity ? Number(row.capacity) : null,
      skillLevel: row.skillLevel || 'any',
      visibility: row.visibility || 'public',
    };
    try {
      const normalized = normalizeSession(input);
      // The same guard createSession applies: a series whose first occurrence
      // is already past materializes nothing and appears nowhere.
      if (firstInstantOf(normalized).getTime() <= Date.now()) {
        return { ...base, ok: false, error: 'start_in_past' };
      }
      return { ...base, ok: true, normalized };
    } catch (error: unknown) {
      if (error instanceof SessionError) return { ...base, ok: false, error: error.code };
      if (error instanceof RecurrenceError) return { ...base, ok: false, error: error.code };
      // Never the raw message: it can carry the operator's own text into a log.
      return { ...base, ok: false, error: 'invalid_row' };
    }
  });

  return {
    rows: previews,
    validCount: previews.filter((row) => row.ok).length,
    skippedCount: previews.filter((row) => !row.ok).length,
  };
}

export interface BulkCreateResult {
  createdIds: string[];
  created: number;
  skipped: BulkRowPreview[];
}

/**
 * Create the valid rows. Re-validates rather than trusting a preview posted
 * back from the browser — the preview is a rendering, never an authorisation.
 */
export async function bulkCreateSessions(
  db: TransactionalDb,
  organizerId: string,
  rows: readonly BulkRowInput[],
): Promise<BulkCreateResult> {
  const preview = await previewBulkRows(db, rows);
  const createdIds: string[] = [];
  const skipped = preview.rows.filter((row) => !row.ok);

  for (const row of preview.rows) {
    if (!row.ok || !row.normalized) continue;
    const normalized = row.normalized;
    try {
      // One transaction per row: a failure at row 190 must not undo 189 good
      // ones the operator has already been told about.
      const id = await db.transaction(async (tx) => {
        const inserted = await tx.execute(sql`
          INSERT INTO play_sessions (
            facility_id, sport, organizer_id, title, description,
            starts_at_local, timezone, rrule, duration_minutes, capacity,
            skill_level, visibility
          ) VALUES (
            ${normalized.facilityId}::uuid, ${normalized.sport}, ${organizerId},
            ${normalized.title}, ${normalized.description},
            ${normalized.startsAtLocal}::timestamp, ${normalized.timezone},
            ${normalized.rrule}, ${normalized.durationMinutes}, ${normalized.capacity},
            ${normalized.skillLevel}::play_session_skill,
            ${normalized.visibility}::play_session_visibility
          )
          RETURNING id
        `);
        return String(inserted.rows[0]?.id);
      });
      createdIds.push(id);
    } catch {
      skipped.push({ ...row, ok: false, error: 'insert_failed', normalized: undefined });
    }
  }

  return { createdIds, created: createdIds.length, skipped };
}

/** A sample file for the operator to start from — headers in Bulgarian. */
export function sampleCsv(): string {
  return csvColumns.bulkSample.join('\r\n');
}

/** Parse a rule for the preview without committing to it. */
export function validateRrule(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  return formatRrule(parseRrule(trimmed));
}
