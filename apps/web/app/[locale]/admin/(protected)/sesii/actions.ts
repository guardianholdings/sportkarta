'use server';

import { getDb } from '@sportkarta/db';
import { detectDelimiter, parseCsv } from '@sportkarta/lib/csv';
import { revalidatePath } from 'next/cache';

import { MATERIALIZE_QUEUE } from '@/lib/sessions/sessions';
import { getBoss } from '@/lib/admin-boss';
import { requireRole } from '@/lib/auth-session';
import {
  bulkCreateSessions,
  CsvFileError,
  guessMapping,
  previewBulkRows,
  rowsFromCsv,
  rowsFromGrid,
  type BulkRowInput,
  type BulkRowPreview,
  type ColumnMapping,
} from '@/lib/sessions/bulk-create';

/**
 * Bulk-create actions (docs/ROADMAP.md §6, Stage 4.5).
 *
 * `requireRole('admin')` on every action, NOT `requireAdmin()` — since Stage 3.3
 * the latter also admits ambassadors, whose authority is municipality-scoped
 * moderation. These are the сдружение's official national slots.
 */

export interface BulkState {
  step: 'input' | 'map' | 'preview' | 'done';
  /** i18n key under AdminBulkSessions.error.*, or null. */
  error: string | null;
  csv?: string;
  headers?: string[];
  sampleRows?: string[][];
  mapping?: ColumnMapping;
  preview?: BulkRowPreview[];
  validCount?: number;
  skippedCount?: number;
  created?: number;
  skipped?: BulkRowPreview[];
}

/** Parse the pasted/uploaded file and guess the column mapping. */
export async function parseCsvAction(_prev: BulkState, formData: FormData): Promise<BulkState> {
  await requireRole('admin');
  const csv = await readCsv(formData);
  if (csv.trim() === '') return { step: 'input', error: 'no_rows' };

  const parsed = parseCsv(csv, detectDelimiter(csv));
  // Refused here too, so the operator learns at the first step rather than
  // after mapping eleven columns.
  if (parsed.truncated) return { step: 'input', error: 'csv_truncated', csv };
  if (parsed.rows.length === 0) return { step: 'input', error: 'no_rows', csv };

  return {
    step: 'map',
    error: null,
    csv,
    headers: parsed.headers,
    // A few rows so the operator can see what each column actually contains
    // while mapping it, instead of mapping blind by header name.
    sampleRows: parsed.rows.slice(0, 3),
    mapping: guessMapping(parsed.headers),
  };
}

/** Validate every row against the chosen mapping. Writes nothing. */
export async function previewCsvAction(_prev: BulkState, formData: FormData): Promise<BulkState> {
  await requireRole('admin');
  const csv = String(formData.get('csv') ?? '');
  const mapping = readMapping(formData);
  let rows: BulkRowInput[];
  try {
    rows = rowsFromCsv(csv, mapping);
  } catch (error: unknown) {
    if (error instanceof CsvFileError) return { step: 'input', error: error.code, csv };
    throw error;
  }
  if (rows.length === 0) return { step: 'input', error: 'no_rows' };

  const preview = await previewBulkRows(getDb(), rows);
  return {
    step: 'preview',
    error: null,
    csv,
    mapping,
    preview: preview.rows,
    validCount: preview.validCount,
    skippedCount: preview.skippedCount,
  };
}

/** Create the valid rows. Re-validates: a posted preview is not authorisation. */
export async function commitCsvAction(_prev: BulkState, formData: FormData): Promise<BulkState> {
  const user = await requireRole('admin');
  const csv = String(formData.get('csv') ?? '');
  const mapping = readMapping(formData);
  try {
    return await commit(rowsFromCsv(csv, mapping), user.id);
  } catch (error: unknown) {
    if (error instanceof CsvFileError) return { step: 'input', error: error.code, csv };
    throw error;
  }
}

export async function createGridAction(_prev: BulkState, formData: FormData): Promise<BulkState> {
  const user = await requireRole('admin');
  const facilityIds = formData.getAll('facilityId').map(String).filter(Boolean);
  if (facilityIds.length === 0) return { step: 'input', error: 'nothing_selected' };

  const rows = rowsFromGrid({
    facilityIds,
    sport: String(formData.get('sport') ?? ''),
    title: String(formData.get('title') ?? ''),
    description: String(formData.get('description') ?? ''),
    date: String(formData.get('date') ?? ''),
    time: String(formData.get('time') ?? ''),
    durationMinutes: Number(formData.get('duration') ?? 90),
    weekdays: formData.getAll('weekday').map(Number).filter(Number.isInteger),
    capacity: formData.get('capacity') ? Number(formData.get('capacity')) : null,
    skillLevel: String(formData.get('skillLevel') ?? 'any'),
    visibility: String(formData.get('visibility') ?? 'public'),
  });
  return commit(rows, user.id);
}

async function commit(rows: BulkRowInput[], organizerId: string): Promise<BulkState> {
  const result = await bulkCreateSessions(getDb(), organizerId, rows);

  // ONE enqueue for the whole batch, not one per row: the job materializes
  // every pending series, and 200 identical jobs would just be 200 scans.
  if (result.created > 0) {
    try {
      const boss = await getBoss();
      await boss.send(MATERIALIZE_QUEUE, {});
    } catch (error) {
      // The hourly schedule will pick them up regardless, so a queue hiccup
      // must not lose the sessions that were just created.
      console.error(
        '[admin] could not enqueue materialize:',
        error instanceof Error ? error.message : 'unknown error',
      );
    }
  }

  revalidatePath('/admin/sesii');
  return {
    step: 'done',
    error: null,
    created: result.created,
    skipped: result.skipped,
    skippedCount: result.skipped.length,
  };
}

async function readCsv(formData: FormData): Promise<string> {
  const file = formData.get('file');
  if (file instanceof File && file.size > 0) return file.text();
  return String(formData.get('csv') ?? '');
}

function readMapping(formData: FormData): ColumnMapping {
  const mapping: ColumnMapping = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('map.')) continue;
    const index = Number(value);
    if (Number.isInteger(index) && index >= 0) {
      mapping[key.slice(4) as keyof ColumnMapping] = index;
    }
  }
  return mapping;
}
