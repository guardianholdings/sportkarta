import { MUNICIPAL_FIELDS } from '@sportkarta/lib';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { MunicipalImport } from './import-form';

import { requireRole } from '@/lib/auth-session';
import { sampleCsv } from '@/lib/import/municipal';

/**
 * Municipal CSV inbox (docs/ROADMAP.md §8, Stage 6.3).
 *
 * `requireRole('admin')`, not `requireAdmin()`: a registry import rewrites the
 * canonical facility dataset nationally, exactly like the OSM import — an
 * ambassador's authority is municipality-scoped moderation, not overwriting the
 * map. The page owns i18n and hands the client component a flat label bag; the
 * client owns interaction.
 */

export default async function AdminMunicipalImportPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');

  const t = await getTranslations('AdminMunicipalImport');
  const tField = await getTranslations('AdminMunicipalImport.field');

  // Flat label bags: every string the client renders, resolved here.
  const labelKeys = [
    'registryLabel',
    'registryPlaceholder',
    'registryHint',
    'upload',
    'paste',
    'templateHint',
    'next',
    'mapHint',
    'ignoreColumn',
    'preview',
    'previewHint',
    'rowNumber',
    'name',
    'status',
    'resolution',
    'countNew',
    'countMatch',
    'countConflict',
    'countInvalid',
    'status_new',
    'status_match',
    'status_conflict',
    'status_invalid',
    'conflict_same_spot_different_name',
    'conflict_name_match_farther',
    'conflict_ambiguous',
    'resolveSkip',
    'resolveNew',
    'resolveLink',
    'willCommit',
    'willSkip',
    'confirmImport',
    'doneTitle',
    'doneInserted',
    'doneUpdated',
    'doneUnchanged',
    'doneSkipped',
    'importAnother',
    'error_no_rows',
    'error_csv_truncated',
    'error_too_many_rows',
    'error_registry_required',
    'rowError_name_too_long',
    'rowError_quarter_too_long',
    'rowError_invalid_sport',
    'rowError_access_required',
    'rowError_invalid_access',
    'rowError_invalid_surface',
    'rowError_invalid_lighting',
    'rowError_invalid_covered',
    'rowError_coordinates_required',
    'rowError_outside_bulgaria',
  ] as const;

  const labels = Object.fromEntries(labelKeys.map((key) => [key, t(key)]));
  const fieldLabels = Object.fromEntries(MUNICIPAL_FIELDS.map((field) => [field, tField(field)]));

  return (
    <main className="space-y-6">
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
      <p className="max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      <MunicipalImport labels={labels} fieldLabels={fieldLabels} sampleCsv={sampleCsv()} />
    </main>
  );
}
