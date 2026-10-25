'use server';

import { getDb } from '@sportkarta/db';
import { CLUB_IMPORT_FIELDS } from '@sportkarta/lib/clubs';
import { revalidatePath } from 'next/cache';

import { readColumnMapping } from '@/lib/admin-csv';
import { requireClubStaff } from '@/lib/clubs/club-session';
import {
  ClubImportFileError,
  commitClubImport,
  guessClubMapping,
  parseClubCsv,
  previewClubImport,
  rowsFromClubCsv,
  type ClubImportMapping,
  type ClubImportResult,
  type ClubImportRowView,
} from '@/lib/clubs/import';

/**
 * The member import wizard — one action, dispatched by `do`, re-gated with
 * requireClubStaff(data.import) on every step. Each step re-derives from the
 * CSV the form carries; the commit re-classifies from scratch, so a posted
 * preview never authorises anything (the /admin/obshtini rule).
 */

export interface ClubImportState {
  step: 'input' | 'map' | 'preview' | 'done';
  /** Key under ClubMembers.import.error_*, or null. */
  error: string | null;
  csv?: string;
  headers?: string[];
  sample?: string[][];
  mapping?: ClubImportMapping;
  rows?: ClubImportRowView[];
  counts?: { new: number; match: number; conflict: number; invalid: number };
  result?: ClubImportResult;
}

async function readCsv(formData: FormData): Promise<string> {
  const file = formData.get('file');
  if (file instanceof File && file.size > 0) {
    // 2 MB is far beyond 2000 members and keeps a stray upload out of memory.
    if (file.size > 2_000_000) throw new ClubImportFileError('too_many_rows');
    return file.text();
  }
  return String(formData.get('csv') ?? '');
}

export async function clubImportAction(
  _prev: ClubImportState,
  formData: FormData,
): Promise<ClubImportState> {
  const slug = String(formData.get('slug') ?? '');
  const { actor } = await requireClubStaff(slug, 'data.import');
  const step = String(formData.get('do') ?? 'parse');
  let csv = '';
  try {
    csv = step === 'parse' ? await readCsv(formData) : String(formData.get('csv') ?? '');
    if (csv.trim() === '') return { step: 'input', error: 'no_rows' };
    if (step === 'parse' || step === 'map') {
      const { headers, rows } = parseClubCsv(csv);
      return {
        step: 'map',
        error: null,
        csv,
        headers,
        sample: rows.slice(0, 3),
        mapping:
          step === 'map'
            ? readColumnMapping(formData, CLUB_IMPORT_FIELDS)
            : guessClubMapping(headers),
      };
    }
    const mapping = readColumnMapping(formData, CLUB_IMPORT_FIELDS);
    const normalized = rowsFromClubCsv(csv, mapping);
    if (step === 'preview') {
      const preview = await previewClubImport(actor, normalized);
      return { step: 'preview', error: null, csv, mapping, ...preview };
    }
    if (step === 'commit') {
      const asNew = new Set(
        formData
          .getAll('asNew')
          .map((value) => Number(value))
          .filter((line) => Number.isInteger(line) && line > 1),
      );
      const outcome = await commitClubImport(getDb(), actor, normalized, asNew);
      if (!outcome.ok) {
        const preview = await previewClubImport(actor, normalized);
        return { step: 'preview', error: outcome.error, csv, mapping, ...preview };
      }
      revalidatePath(`/klub/${slug}/chlenove`);
      return { step: 'done', error: null, result: outcome.result };
    }
    return { step: 'input', error: null };
  } catch (error) {
    if (error instanceof ClubImportFileError) {
      return error.code === 'name_unmapped'
        ? { step: 'map', error: error.code, csv, ...headersOf(csv), mapping: {} }
        : { step: 'input', error: error.code, csv };
    }
    throw error;
  }
}

function headersOf(csv: string): { headers: string[]; sample: string[][] } {
  try {
    const { headers, rows } = parseClubCsv(csv);
    return { headers, sample: rows.slice(0, 3) };
  } catch {
    return { headers: [], sample: [] };
  }
}
