import { getDb, sql } from '@sportkarta/db';
import { cityDisplayName } from '@sportkarta/lib/cities';
import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { requireRole } from '@/lib/auth-session';

import { BulkCreateTabs, type FacilityOption } from './bulk-forms';

/**
 * Admin bulk-create (docs/ROADMAP.md §6, Stage 4.5).
 *
 * `requireRole('admin')`, not `requireAdmin()`: since Stage 3.3 the latter also
 * admits ambassadors, whose authority is municipality-scoped moderation. These
 * are the сдружение's official national slots.
 */

const FACILITY_LIMIT = 2000;

interface FacilityRow {
  id: string;
  name: string | null;
  sport_types: string[] | null;
  name_bg: string | null;
  name_en: string | null;
  total: number;
}

export default async function AdminBulkSessionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');

  const [t, tSport] = await Promise.all([
    getTranslations('AdminBulkSessions'),
    getTranslations('Sport'),
  ]);

  // Everything selectable in one read: the point of this screen is that the
  // operator filters and ticks without a round trip per keystroke. Only NAMED
  // facilities are pickable (an unnamed OSM point is not a session venue an
  // operator can recognise), and that predicate must live HERE: fetching all
  // rows and dropping unnamed ones client-side let the LIMIT swallow named
  // facilities in municipalities past the cap while the list looked complete
  // (AUDIT-F1 — an operator in Шумен could not find their own pitch). The
  // window count rides along so the rare over-cap day is VISIBLE in the UI
  // instead of silently truncated.
  const result = await getDb().execute(sql`
    SELECT f.id, f.name, f.sport_types, m.name_bg, m.name_en,
           count(*) OVER ()::int AS total
      FROM facilities f
      LEFT JOIN municipalities m ON m.id = f.municipality_id
     WHERE f.status <> 'gone' AND f.name IS NOT NULL
     ORDER BY m.name_bg NULLS LAST, f.name
     LIMIT ${FACILITY_LIMIT}
  `);

  const rows = result.rows as unknown as FacilityRow[];
  const facilityTotal = rows[0]?.total ?? 0;
  const facilities: FacilityOption[] = rows.map((row) => ({
    id: row.id,
    name: row.name ?? '',
    cityName: row.name_bg ? cityDisplayName(row.name_bg, row.name_en ?? '', locale) : '',
    sports: row.sport_types ?? [],
  }));

  // Flat label bags: the page owns i18n, the client component owns interaction.
  const labelKeys = [
    'gridTab',
    'csvTab',
    'sport',
    'sessionTitle',
    'description',
    'weekdays',
    'startTime',
    'startDate',
    'duration',
    'capacity',
    'skillLevel',
    'visibility',
    'filterCity',
    'filterSport',
    'filterName',
    'facilities',
    'facilityListTruncated',
    'selectedCount',
    'selectAll',
    'clearAll',
    'create',
    'csvPaste',
    'csvUpload',
    'csvParse',
    'mapColumns',
    'mapHint',
    'ignoreColumn',
    'preview',
    'previewHint',
    'rowNumber',
    'status',
    'reason',
    'rowOk',
    'rowError',
    'confirmImport',
    'createdCount',
    'skippedCount',
    'templateHint',
    'facility',
    'rrule',
    'date',
    'time',
    'error_no_rows',
    'error_csv_truncated',
    'error_too_many_rows',
    'error_nothing_selected',
    'error_facility_not_found',
    'error_invalid_row',
    'error_insert_failed',
    'error_title_required',
    'error_title_too_long',
    'error_invalid_sport',
    'error_invalid_duration',
    'error_invalid_capacity',
    'error_invalid_start',
    'error_start_in_past',
    'error_facility_gone',
    'error_description_too_long',
    'error_invalid_skill_level',
    'error_invalid_visibility',
    'error_rrule_syntax',
    'error_rrule_unsupported_freq',
    'error_rrule_byday_requires_weekly',
    'error_rrule_byday_invalid',
    'error_rrule_count_and_until',
    'error_rrule_unsupported_part',
    'error_rrule_duplicate_part',
    'error_rrule_interval_range',
    'error_rrule_count_range',
    'error_rrule_until_invalid',
    'error_rrule_wkst_unsupported',
    'error_rrule_empty',
    'error_rrule_too_many_occurrences',
  ];
  // t.raw, NOT t: several of these carry a {count} placeholder that the client
  // component fills in itself, and next-intl's t() throws FORMATTING_ERROR when
  // a placeholder has no value. Raw templates in, interpolation at the point of
  // use — which is also why the client has its own tiny replace().
  const labels = Object.fromEntries(labelKeys.map((key) => [key, String(t.raw(key))]));

  const fieldKeys = [
    'weekday1',
    'weekday2',
    'weekday3',
    'weekday4',
    'weekday5',
    'weekday6',
    'weekday7',
    'any',
    'beginner',
    'intermediate',
    'advanced',
    'public',
    'unlisted',
  ];
  const fieldLabels: Record<string, string> = Object.fromEntries(
    fieldKeys.map((key) => [key, String(t.raw(key))]),
  );
  for (const sport of CANONICAL_SPORTS) fieldLabels[sport] = tSport(sport);

  return (
    <main className="space-y-6">
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
      <p className="max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      <BulkCreateTabs
        facilities={facilities}
        facilityTotal={facilityTotal}
        sports={[...CANONICAL_SPORTS]}
        labels={labels}
        fieldLabels={fieldLabels}
      />
    </main>
  );
}
