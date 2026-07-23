import { sql, type SQL } from '@sportkarta/db';
import { guessColumn, parseCsv, type CsvDelimiter } from '@sportkarta/lib/csv';

// Header aliases are DATA (input matching), not translatable UI copy — kept in
// JSON like the city overrides, where the hardcoded-Cyrillic guard expects
// Bulgarian text to live.
import csvColumns from './csv-columns.json';

/**
 * Per-occurrence results v1 (docs/ROADMAP.md §6, Stage 4.6).
 *
 * One row per participant or side: a pickup football game is two rows with a
 * team and a score, a 5 km run is one row per runner with a position and a
 * typed time. One shape covers every canonical sport.
 *
 * NO TIMING HARDWARE, and this is the boundary rather than a gap: `score` is
 * text that a person typed, there is no device integration, no chip/gun/net
 * time and no import endpoint for a timing system. The migration header and the
 * column comment say the same thing, so nobody adds one by accident.
 *
 * Results live under /admin for now because Stage 4.1 shipped no public
 * occurrence page; these functions are written so the organiser screens can
 * call them unchanged when there is somewhere to put them.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export const LABEL_MAX = 80;
export const TEAM_MAX = 80;
export const SCORE_MAX = 40;
export const NOTE_MAX = 300;

export type ResultErrorCode =
  | 'participant_required'
  | 'participant_too_long'
  | 'team_too_long'
  | 'score_too_long'
  | 'note_too_long'
  | 'invalid_position'
  | 'empty_result'
  | 'unknown_member'
  | 'duplicate_member'
  | 'occurrence_not_found'
  | 'occurrence_not_started'
  | 'csv_truncated'
  | 'too_many_rows';

export class ResultError extends Error {
  constructor(readonly code: ResultErrorCode) {
    super(code);
    this.name = 'ResultError';
  }
}

export interface ResultRowInput {
  /** A member's email, or a free-text label for a guest or a side. */
  participant: string;
  team?: string;
  position?: string | number | null;
  score?: string;
  note?: string;
}

export interface NormalizedResultRow {
  /** Resolved later, from the email; null for a free-text participant. */
  participantEmail: string | null;
  participantLabel: string | null;
  team: string | null;
  position: number | null;
  score: string | null;
  note: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function trimmedOrNull(
  value: string | undefined,
  max: number,
  tooLong: ResultErrorCode,
): string | null {
  const trimmed = (value ?? '').trim().replace(/\s+/g, ' ');
  if (trimmed === '') return null;
  if (trimmed.length > max) throw new ResultError(tooLong);
  return trimmed;
}

/**
 * Pure validation, mirroring the CHECK constraints so an operator gets a
 * translatable slug instead of a Postgres constraint name.
 */
export function normalizeResultRow(input: ResultRowInput): NormalizedResultRow {
  const participant = (input.participant ?? '').trim().replace(/\s+/g, ' ');
  if (participant === '') throw new ResultError('participant_required');
  if (participant.length > LABEL_MAX) throw new ResultError('participant_too_long');

  // An email means "this is a member"; anything else is a label. Resolution
  // happens against the database later, so this stays pure.
  const isEmail = EMAIL_RE.test(participant);

  let position: number | null = null;
  if (
    input.position !== undefined &&
    input.position !== null &&
    String(input.position).trim() !== ''
  ) {
    position = Number(String(input.position).trim());
    if (!Number.isInteger(position) || position < 1) throw new ResultError('invalid_position');
  }

  const team = trimmedOrNull(input.team, TEAM_MAX, 'team_too_long');
  const score = trimmedOrNull(input.score, SCORE_MAX, 'score_too_long');
  const note = trimmedOrNull(input.note, NOTE_MAX, 'note_too_long');

  // Mirrors play_session_results_has_content: a row that says nothing happened
  // is not a result. `team` deliberately does not count as content.
  if (position === null && score === null && note === null) {
    throw new ResultError('empty_result');
  }

  return {
    participantEmail: isEmail ? participant.toLowerCase() : null,
    participantLabel: isEmail ? null : participant,
    team,
    position,
    score,
    note,
  };
}

export interface ResultRowPreview {
  rowNumber: number;
  participant: string;
  ok: boolean;
  error?: string;
  normalized?: NormalizedResultRow;
  /** Resolved member id, when the participant was an email. */
  userId?: string;
}

export interface ResultsPreview {
  rows: ResultRowPreview[];
  validCount: number;
  skippedCount: number;
}

export const RESULT_FIELDS = ['participant', 'team', 'position', 'score', 'note'] as const;
export type ResultField = (typeof RESULT_FIELDS)[number];

export const RESULT_HEADER_ALIASES = csvColumns.result as Record<ResultField, readonly string[]>;

export type ResultMapping = Partial<Record<ResultField, number>>;

export function guessResultMapping(headers: readonly string[]): ResultMapping {
  const mapping: ResultMapping = {};
  headers.forEach((header, index) => {
    const field = guessColumn(header, RESULT_HEADER_ALIASES) as ResultField | undefined;
    if (field && mapping[field] === undefined) mapping[field] = index;
  });
  return mapping;
}

/** Hard cap on one import — see bulk-create's MAX_IMPORT_ROWS. */
export const MAX_RESULT_ROWS = 2000;

export function resultRowsFromCsv(
  text: string,
  mapping: ResultMapping,
  delimiter?: CsvDelimiter,
): (ResultRowInput & { rowNumber: number })[] {
  const parsed = parseCsv(text, delimiter);
  // A truncated file must never reach replaceResults, which DELETEs first: it
  // would destroy the existing results and replace them with a fraction of the
  // file. Refuse it outright.
  if (parsed.truncated) throw new ResultError('csv_truncated');
  if (parsed.rows.length > MAX_RESULT_ROWS) throw new ResultError('too_many_rows');
  const at = (row: string[], field: ResultField): string => {
    const index = mapping[field];
    return index === undefined ? '' : (row[index] ?? '').trim();
  };
  return parsed.rows.map((row, i) => ({
    rowNumber: i + 2,
    participant: at(row, 'participant'),
    team: at(row, 'team'),
    position: at(row, 'position'),
    score: at(row, 'score'),
    note: at(row, 'note'),
  }));
}

/**
 * Validate and resolve members without writing. Members are resolved in ONE
 * query, and a duplicate member inside the same file is rejected here rather
 * than by the unique index — the operator gets a row number instead of a
 * constraint name.
 */
export async function previewResults(
  db: SqlRunner,
  rows: readonly (ResultRowInput & { rowNumber: number })[],
): Promise<ResultsPreview> {
  const normalized = rows.map((row) => {
    try {
      return { row, value: normalizeResultRow(row) as NormalizedResultRow, error: undefined };
    } catch (error: unknown) {
      return {
        row,
        value: undefined,
        error: error instanceof ResultError ? error.code : 'empty_result',
      };
    }
  });

  const emails = [
    ...new Set(
      normalized
        .map((entry) => entry.value?.participantEmail)
        .filter((email): email is string => Boolean(email)),
    ),
  ];
  const members = new Map<string, string>();
  if (emails.length > 0) {
    const found = await db.execute(
      sql`SELECT id, lower(email) AS email FROM users WHERE lower(email) = ANY(${sql.param(emails)}::text[])`,
    );
    for (const row of found.rows) members.set(String(row.email), String(row.id));
  }

  const seenMembers = new Set<string>();
  const previews = normalized.map((entry): ResultRowPreview => {
    const base = { rowNumber: entry.row.rowNumber, participant: entry.row.participant };
    if (!entry.value) return { ...base, ok: false, error: entry.error };

    if (entry.value.participantEmail) {
      const userId = members.get(entry.value.participantEmail);
      if (!userId) return { ...base, ok: false, error: 'unknown_member' };
      if (seenMembers.has(userId)) return { ...base, ok: false, error: 'duplicate_member' };
      seenMembers.add(userId);
      return { ...base, ok: true, normalized: entry.value, userId };
    }
    return { ...base, ok: true, normalized: entry.value };
  });

  return {
    rows: previews,
    validCount: previews.filter((row) => row.ok).length,
    skippedCount: previews.filter((row) => !row.ok).length,
  };
}

export interface SaveResultsOutcome {
  saved: number;
  skipped: ResultRowPreview[];
}

/**
 * Replace an occurrence's results wholesale, in one transaction.
 *
 * Replace rather than merge: the form and the CSV both express "here is the
 * result", and a merge would leave a deleted row behind with nothing in the UI
 * to explain it. Valid rows are written and invalid ones are reported, matching
 * the bulk-create rule.
 *
 * ANONYMISED ROWS ARE NEVER DELETED. A row with neither a member nor a label is
 * an erased participant (the INSERT trigger guarantees a guest always has a
 * label), and there is no way to re-express it in a form — so a re-save would
 * quietly destroy the other side's record of that game. The DELETE below skips
 * them, and the editor shows them as preserved rather than offering them for
 * editing.
 */
export async function replaceResults(
  db: TransactionalDb,
  occurrenceId: string,
  recordedBy: string,
  rows: readonly (ResultRowInput & { rowNumber: number })[],
): Promise<SaveResultsOutcome> {
  const preview = await previewResults(db, rows);
  const valid = preview.rows.filter((row) => row.ok && row.normalized);

  await db.transaction(async (tx) => {
    // FOR UPDATE: two concurrent saves would otherwise UNION rather than
    // replace — B's DELETE runs before A's INSERTs are visible.
    const occurrence = await tx.execute(sql`
      SELECT (starts_at <= now()) AS started
        FROM play_session_occurrences WHERE id = ${occurrenceId}::uuid
        FOR UPDATE
    `);
    const found = occurrence.rows[0];
    if (!found) throw new ResultError('occurrence_not_found');
    // A result for a session that has not happened is not a result.
    if (found.started !== true) throw new ResultError('occurrence_not_started');

    await tx.execute(sql`
      DELETE FROM play_session_results
       WHERE occurrence_id = ${occurrenceId}::uuid
         AND NOT (participant_user_id IS NULL AND participant_label IS NULL)
    `);
    for (const row of valid) {
      const value = row.normalized as NormalizedResultRow;
      await tx.execute(sql`
        INSERT INTO play_session_results (
          occurrence_id, participant_user_id, participant_label, team, position, score, note, recorded_by
        ) VALUES (
          ${occurrenceId}::uuid, ${row.userId ?? null}, ${value.participantLabel},
          ${value.team}, ${value.position}, ${value.score}, ${value.note}, ${recordedBy}
        )
      `);
    }
  });

  return { saved: valid.length, skipped: preview.rows.filter((row) => !row.ok) };
}

export interface StoredResult {
  id: string;
  participantUserId: string | null;
  participantLabel: string | null;
  displayName: string | null;
  /**
   * The member's address, which is what the editor must pre-fill: the form
   * classifies a participant as a member ONLY by email, so pre-filling a
   * display name would re-save every member row as a free-text label carrying
   * that person's real name — surviving erasure forever in a column no foreign
   * key can clear. See replaceResults.
   */
  email: string | null;
  team: string | null;
  position: number | null;
  score: string | null;
  note: string | null;
}

/**
 * One occurrence's results, ordered as the index stores them (position first,
 * unranked last). A row with neither a member nor a label is an erased
 * participant — the migration guarantees a guest always has one — and the UI
 * renders it under the "former user" label.
 */
export async function resultsFor(db: SqlRunner, occurrenceId: string): Promise<StoredResult[]> {
  const result = await db.execute(sql`
    SELECT r.id, r.participant_user_id, r.participant_label, u.display_name, u.email,
           r.team, r.position, r.score, r.note
      FROM play_session_results r
      LEFT JOIN users u ON u.id = r.participant_user_id
     WHERE r.occurrence_id = ${occurrenceId}::uuid
     ORDER BY r.position NULLS LAST, r.created_at
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    participantUserId: row.participant_user_id === null ? null : String(row.participant_user_id),
    participantLabel: row.participant_label === null ? null : String(row.participant_label),
    displayName: row.display_name === null ? null : String(row.display_name),
    email: row.email === null || row.email === undefined ? null : String(row.email),
    team: row.team === null ? null : String(row.team),
    position: row.position === null ? null : Number(row.position),
    score: row.score === null ? null : String(row.score),
    note: row.note === null ? null : String(row.note),
  }));
}

export interface OccurrenceForResults {
  occurrenceId: string;
  startsAtLocal: string;
  title: string;
  sport: string;
  facilityName: string | null;
  resultCount: number;
}

/** Finished occurrences, newest first — the admin worklist. */
export async function occurrencesAwaitingResults(
  db: SqlRunner,
  limit = 50,
): Promise<OccurrenceForResults[]> {
  const result = await db.execute(sql`
    SELECT o.id,
           to_char(o.starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
           s.title, s.sport, f.name AS facility_name,
           (SELECT count(*)::int FROM play_session_results r WHERE r.occurrence_id = o.id) AS result_count
      FROM play_session_occurrences o
      JOIN play_sessions s ON s.id = o.session_id
      JOIN facilities f    ON f.id = s.facility_id
     WHERE o.starts_at <= now() AND o.status = 'scheduled'
     ORDER BY o.starts_at DESC
     LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    occurrenceId: String(row.id),
    startsAtLocal: String(row.starts_at_local),
    title: String(row.title),
    sport: String(row.sport),
    facilityName: row.facility_name === null ? null : String(row.facility_name),
    resultCount: Number(row.result_count ?? 0),
  }));
}
