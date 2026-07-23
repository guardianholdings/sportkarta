'use server';

import type { Resolution } from '@sportkarta/db';
import { detectDelimiter, parseCsv } from '@sportkarta/lib/csv';
import type { MunicipalField } from '@sportkarta/lib';
import { revalidatePath } from 'next/cache';

import { requireRole } from '@/lib/auth-session';
import {
  commitMunicipal,
  guessMunicipalMapping,
  MunicipalFileError,
  previewMunicipal,
  rowsFromCsv,
  type MunicipalMapping,
  type MunicipalRowView,
} from '@/lib/import/municipal';

/**
 * Municipal CSV inbox actions (docs/ROADMAP.md §8, Stage 6.3).
 *
 * `requireRole('admin')` on EVERY action, not `requireAdmin()`: a registry
 * import rewrites the canonical facility dataset nationally, exactly like the
 * OSM import, so it is admin-only. An ambassador's authority is
 * municipality-scoped moderation, not overwriting the map.
 *
 * A multi-step state machine mirroring the bulk-create flow: upload → map →
 * preview (with per-conflict resolution) → done. Each action re-derives from the
 * carried CSV rather than trusting the browser, and the commit re-runs the whole
 * classification, because a posted preview is a rendering, never an
 * authorisation.
 */

export interface MunicipalState {
  step: 'input' | 'map' | 'preview' | 'done';
  /** i18n slug under AdminMunicipalImport.error.*, or null. */
  error: string | null;
  csv?: string;
  registryLabel?: string;
  headers?: string[];
  sampleRows?: string[][];
  mapping?: MunicipalMapping;
  rows?: MunicipalRowView[];
  counts?: { new: number; match: number; conflict: number; invalid: number };
  committed?: {
    inserted: number;
    updated: number;
    unchanged: number;
    skipped: number;
    invalid: number;
  };
}

async function readCsv(formData: FormData): Promise<string> {
  const file = formData.get('file');
  if (file instanceof File && file.size > 0) return file.text();
  return String(formData.get('csv') ?? '');
}

function readMapping(formData: FormData): MunicipalMapping {
  const mapping: MunicipalMapping = {};
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith('map.')) continue;
    const value = String(raw);
    // The "ignore" option submits an empty string, and Number('') is 0 — so
    // without this guard every unmapped column would silently point at the
    // first cell. That mislabelled a name as a lighting value, caught driving
    // the real form.
    if (value === '') continue;
    const index = Number(value);
    if (Number.isInteger(index) && index >= 0) {
      mapping[key.slice(4) as MunicipalField] = index;
    }
  }
  return mapping;
}

/**
 * Per-row resolutions, from `resolve.<rowNumber>` fields. `link:<facilityId>`
 * carries which facility the operator chose; `new` and `skip` stand alone. An
 * unresolved conflict has no field and defaults to skip in the importer.
 */
function readResolutions(formData: FormData): Record<number, Resolution> {
  const resolutions: Record<number, Resolution> = {};
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith('resolve.')) continue;
    const rowNumber = Number(key.slice('resolve.'.length));
    if (!Number.isInteger(rowNumber)) continue;
    const choice = String(value);
    if (choice === 'new') resolutions[rowNumber] = { action: 'new' };
    else if (choice === 'skip') resolutions[rowNumber] = { action: 'skip' };
    else if (choice.startsWith('link:')) {
      resolutions[rowNumber] = { action: 'link', facilityId: choice.slice('link:'.length) };
    }
  }
  return resolutions;
}

const REGISTRY_LABEL_MAX = 120;

function readRegistryLabel(formData: FormData): string {
  return String(formData.get('registryLabel') ?? '')
    .trim()
    .slice(0, REGISTRY_LABEL_MAX);
}

/** Parse the uploaded/pasted file and guess the column mapping. */
export async function parseCsvAction(
  _prev: MunicipalState,
  formData: FormData,
): Promise<MunicipalState> {
  await requireRole('admin');
  const csv = await readCsv(formData);
  const registryLabel = readRegistryLabel(formData);
  if (csv.trim() === '') return { step: 'input', error: 'no_rows', registryLabel };
  if (registryLabel === '') return { step: 'input', error: 'registry_required', csv };

  const parsed = parseCsv(csv, detectDelimiter(csv));
  // Refused here too, so the operator learns at the first step rather than
  // after mapping nine columns.
  if (parsed.truncated) return { step: 'input', error: 'csv_truncated', csv, registryLabel };
  if (parsed.rows.length === 0) return { step: 'input', error: 'no_rows', csv, registryLabel };

  return {
    step: 'map',
    error: null,
    csv,
    registryLabel,
    headers: parsed.headers,
    sampleRows: parsed.rows.slice(0, 3),
    mapping: guessMunicipalMapping(parsed.headers),
  };
}

/** Normalise + dedupe every row for the preview. Writes nothing. */
export async function previewCsvAction(
  _prev: MunicipalState,
  formData: FormData,
): Promise<MunicipalState> {
  await requireRole('admin');
  const csv = String(formData.get('csv') ?? '');
  const registryLabel = readRegistryLabel(formData);
  const mapping = readMapping(formData);

  try {
    const rows = rowsFromCsv(csv, mapping);
    const preview = await previewMunicipal(rows);
    return {
      step: 'preview',
      error: null,
      csv,
      registryLabel,
      mapping,
      rows: preview.rows,
      counts: preview.counts,
    };
  } catch (error) {
    if (error instanceof MunicipalFileError) {
      return { step: 'input', error: error.code, csv, registryLabel };
    }
    throw error;
  }
}

/** Commit the import, applying the operator's per-conflict resolutions. */
export async function commitCsvAction(
  _prev: MunicipalState,
  formData: FormData,
): Promise<MunicipalState> {
  await requireRole('admin');
  const csv = String(formData.get('csv') ?? '');
  const registryLabel = readRegistryLabel(formData);
  const mapping = readMapping(formData);
  if (registryLabel === '') return { step: 'input', error: 'registry_required', csv };

  try {
    const rows = rowsFromCsv(csv, mapping);
    const resolutions = readResolutions(formData);
    const committed = await commitMunicipal(rows, resolutions, registryLabel);
    revalidatePath('/admin/obshtini');
    return { step: 'done', error: null, committed };
  } catch (error) {
    if (error instanceof MunicipalFileError) {
      return { step: 'input', error: error.code, csv, registryLabel };
    }
    throw error;
  }
}
