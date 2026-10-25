import { CLUB_IMPORT_FIELDS } from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import columns from '@/lib/csv-columns.json';

import { ClubImportWizard } from './import-wizard';

export const dynamic = 'force-dynamic';

const LABEL_KEYS = [
  'upload',
  'paste',
  'templateHint',
  'next',
  'mapHint',
  'ignoreColumn',
  'preview',
  'previewHint',
  'line',
  'name',
  'status',
  'plan',
  'planUnknown',
  'count_new',
  'count_match',
  'count_conflict',
  'count_invalid',
  'status_new',
  'status_match',
  'status_conflict',
  'status_invalid',
  'conflict_several_records',
  'conflict_email_phone_disagree',
  'conflict_duplicate_in_file',
  'createAnyway',
  'commit',
  'backToMapping',
  'doneTitle',
  'doneCreated',
  'doneUpdated',
  'doneMemberships',
  'doneSkipped',
  'importAnother',
  'error_no_rows',
  'error_csv_truncated',
  'error_too_many_rows',
  'error_name_unmapped',
  'error_member_cap_reached',
  'error_not_allowed',
  'rowError_name_required',
  'rowError_name_too_long',
  'rowError_email_invalid',
  'rowError_phone_invalid',
  'rowError_guardian_invalid',
  'rowError_guardian_only_for_minors',
  'rowError_date_invalid',
  'rowError_dates_reversed',
  'rowError_plan_required',
  'rowError_visits_invalid',
  'rowError_price_invalid',
] as const;

/**
 * Bring a member list over from another system (1club's "migration"): a CSV
 * from vedro, 1club, a spreadsheet — mapped, previewed and committed by the
 * club's owner or manager. Copy goes to the client as raw ICU templates.
 */
export default async function ClubImportPage({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  await requireClubStaff(slug, 'data.import');
  const [t, tCard] = await Promise.all([
    getTranslations('ClubMembers.import'),
    getTranslations('ClubMembers.card'),
  ]);
  const labels = Object.fromEntries(LABEL_KEYS.map((key) => [key, String(t.raw(key))]));
  const fieldLabels = Object.fromEntries(
    CLUB_IMPORT_FIELDS.map((field) => [field, t(`field.${field}`)]),
  );
  const sampleCsv = (columns as { clubMembersSample: string[] }).clubMembersSample.join('\n');
  return (
    <main className="mx-auto max-w-4xl space-y-4">
      <Link
        href={`/klub/${slug}/chlenove`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {tCard('back')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
      <p className="max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      <section className="rounded-card border border-line bg-surface p-4 shadow-sm">
        <ClubImportWizard
          slug={slug}
          labels={labels}
          fieldLabels={fieldLabels}
          sampleCsv={sampleCsv}
        />
      </section>
    </main>
  );
}
