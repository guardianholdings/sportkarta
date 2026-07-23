'use server';

import { getDb } from '@sportkarta/db';
import { detectDelimiter, parseCsv } from '@sportkarta/lib/csv';
import { revalidatePath } from 'next/cache';

import { requireRole } from '@/lib/auth-session';
import {
  guessResultMapping,
  previewResults,
  replaceResults,
  ResultError,
  resultRowsFromCsv,
  type ResultMapping,
  type ResultRowInput,
  type ResultRowPreview,
} from '@/lib/results';

/**
 * Results actions (docs/ROADMAP.md §6, Stage 4.6). Admin-only, same reasoning
 * as bulk-create. The CSV path shares the parser, the mapping step and the
 * commit-valid-skip-invalid rule with /admin/sesii.
 */

export interface ResultsState {
  step: 'input' | 'map' | 'preview' | 'done';
  error: string | null;
  csv?: string;
  headers?: string[];
  sampleRows?: string[][];
  mapping?: ResultMapping;
  preview?: ResultRowPreview[];
  validCount?: number;
  skippedCount?: number;
  saved?: number;
  skipped?: ResultRowPreview[];
}

/** Save the manual form: replaces the occurrence's results in one transaction. */
export async function saveResultsAction(
  _prev: ResultsState,
  formData: FormData,
): Promise<ResultsState> {
  const user = await requireRole('admin');
  const occurrenceId = String(formData.get('occurrenceId') ?? '');
  const rows = rowsFromForm(formData);
  if (rows.length === 0) return { step: 'input', error: 'no_rows' };

  try {
    const outcome = await replaceResults(getDb(), occurrenceId, user.id, rows);
    revalidatePath(`/admin/rezultati/${occurrenceId}`);
    return {
      step: 'done',
      error: null,
      saved: outcome.saved,
      skipped: outcome.skipped,
      skippedCount: outcome.skipped.length,
    };
  } catch (error: unknown) {
    if (error instanceof ResultError) return { step: 'input', error: error.code };
    throw error;
  }
}

export async function parseResultsCsvAction(
  _prev: ResultsState,
  formData: FormData,
): Promise<ResultsState> {
  await requireRole('admin');
  const csv = await readCsv(formData);
  if (csv.trim() === '') return { step: 'input', error: 'no_rows' };

  const parsed = parseCsv(csv, detectDelimiter(csv));
  if (parsed.truncated) return { step: 'input', error: 'csv_truncated', csv };
  if (parsed.rows.length === 0) return { step: 'input', error: 'no_rows', csv };

  return {
    step: 'map',
    error: null,
    csv,
    headers: parsed.headers,
    sampleRows: parsed.rows.slice(0, 3),
    mapping: guessResultMapping(parsed.headers),
  };
}

export async function previewResultsCsvAction(
  _prev: ResultsState,
  formData: FormData,
): Promise<ResultsState> {
  await requireRole('admin');
  const csv = String(formData.get('csv') ?? '');
  const mapping = readMapping(formData);
  let rows: (ResultRowInput & { rowNumber: number })[];
  try {
    rows = resultRowsFromCsv(csv, mapping);
  } catch (error: unknown) {
    if (error instanceof ResultError) return { step: 'input', error: error.code, csv };
    throw error;
  }
  if (rows.length === 0) return { step: 'input', error: 'no_rows' };

  const preview = await previewResults(getDb(), rows);
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

export async function commitResultsCsvAction(
  _prev: ResultsState,
  formData: FormData,
): Promise<ResultsState> {
  const user = await requireRole('admin');
  const occurrenceId = String(formData.get('occurrenceId') ?? '');
  const csv = String(formData.get('csv') ?? '');

  try {
    const rows = resultRowsFromCsv(csv, readMapping(formData));
    // Re-validated inside replaceResults: a posted preview is a rendering, not
    // an authorisation.
    const outcome = await replaceResults(getDb(), occurrenceId, user.id, rows);
    revalidatePath(`/admin/rezultati/${occurrenceId}`);
    return {
      step: 'done',
      error: null,
      saved: outcome.saved,
      skipped: outcome.skipped,
      skippedCount: outcome.skipped.length,
    };
  } catch (error: unknown) {
    if (error instanceof ResultError) return { step: 'input', error: error.code, csv };
    throw error;
  }
}

/** Repeating-row form → result rows, dropping the rows left blank. */
function rowsFromForm(formData: FormData): (ResultRowInput & { rowNumber: number })[] {
  const participants = formData.getAll('participant').map(String);
  const teams = formData.getAll('team').map(String);
  const positions = formData.getAll('position').map(String);
  const scores = formData.getAll('score').map(String);
  const notes = formData.getAll('note').map(String);

  return participants
    .map((participant, i) => ({
      rowNumber: i + 1,
      participant,
      team: teams[i] ?? '',
      position: positions[i] ?? '',
      score: scores[i] ?? '',
      note: notes[i] ?? '',
    }))
    .filter((row) => row.participant.trim() !== '');
}

async function readCsv(formData: FormData): Promise<string> {
  const file = formData.get('file');
  if (file instanceof File && file.size > 0) return file.text();
  return String(formData.get('csv') ?? '');
}

function readMapping(formData: FormData): ResultMapping {
  const mapping: ResultMapping = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('map.')) continue;
    const index = Number(value);
    if (Number.isInteger(index) && index >= 0) {
      mapping[key.slice(4) as keyof ResultMapping] = index;
    }
  }
  return mapping;
}
