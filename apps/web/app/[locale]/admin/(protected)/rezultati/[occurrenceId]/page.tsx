import { getDb, sql } from '@sportkarta/db';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Link } from '@/i18n/navigation';
import { requireRole } from '@/lib/auth-session';
import { resultsFor } from '@/lib/results';

import { ResultsEditor } from './results-form';

/** Result entry for one occurrence (docs/ROADMAP.md §6, Stage 4.6). */

interface OccurrenceRow {
  id: string;
  starts_at_local: string;
  title: string;
  sport: string;
  facility_name: string | null;
}

export default async function ResultsEditorPage({
  params,
}: {
  params: Promise<{ locale: string; occurrenceId: string }>;
}) {
  const { locale, occurrenceId } = await params;
  setRequestLocale(locale);
  await requireRole('admin');

  const [t, tSport] = await Promise.all([
    getTranslations('AdminResults'),
    getTranslations('Sport'),
  ]);

  const found = await getDb().execute(sql`
    SELECT o.id,
           to_char(o.starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
           s.title, s.sport, f.name AS facility_name
      FROM play_session_occurrences o
      JOIN play_sessions s ON s.id = o.session_id
      JOIN facilities f    ON f.id = s.facility_id
     WHERE o.id = ${occurrenceId}::uuid
  `);
  const occurrence = (found.rows as unknown as OccurrenceRow[])[0];
  if (!occurrence) notFound();

  const stored = await resultsFor(getDb(), occurrenceId);
  // A row with neither a member nor a label is an ERASED participant. It cannot
  // be re-expressed in the form, so it is not offered for editing and
  // replaceResults never deletes it — the count is shown instead, so the
  // operator knows the set is bigger than what they can see.
  const anonymised = stored.filter(
    (row) => row.participantUserId === null && row.participantLabel === null,
  ).length;
  const existing = stored
    .filter((row) => row.participantUserId !== null || row.participantLabel !== null)
    .map((row) => ({
      // The EMAIL, not the display name: the form recognises a member only by
      // address, so pre-filling a name would re-save the row as free text
      // carrying that person's real name — which erasure could never clear.
      participant: row.email ?? row.participantLabel ?? '',
      team: row.team ?? '',
      position: row.position === null ? '' : String(row.position),
      score: row.score ?? '',
      note: row.note ?? '',
    }));

  const labelKeys = [
    'participant',
    'participantHint',
    'team',
    'position',
    'score',
    'scoreHint',
    'note',
    'noteHint',
    'addRow',
    'save',
    'saved',
    'csvImport',
    'noResults',
    'error_participant_required',
    'error_participant_too_long',
    'error_team_too_long',
    'error_score_too_long',
    'error_note_too_long',
    'error_invalid_position',
    'error_empty_result',
    'error_unknown_member',
    'error_duplicate_member',
    'error_occurrence_not_found',
    'error_occurrence_not_started',
    'error_no_rows',
    'error_csv_truncated',
    'error_too_many_rows',
  ];
  // t.raw for the same reason as /admin/sesii: the client component owns
  // interpolation, so it needs the template rather than a formatted string.
  const labels = Object.fromEntries(labelKeys.map((key) => [key, String(t.raw(key))]));

  return (
    <main className="space-y-6">
      <Link href="/admin/rezultati" className="text-body-sm font-medium text-link hover:text-link-hover">
        {t('backToList')}
      </Link>
      <header className="space-y-1">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{occurrence.title}</h1>
        <p className="text-body-sm text-ink-soft">
          {occurrence.starts_at_local.replace('T', ' ').slice(0, 16)} · {tSport(occurrence.sport)}
          {occurrence.facility_name ? ` · ${occurrence.facility_name}` : ''}
        </p>
      </header>
      <p className="max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>

      {anonymised > 0 && (
        <p className="rounded bg-paper-sunk px-3 py-2 text-body-sm text-ink-soft">
          {t('anonymisedPreserved', { count: anonymised })}
        </p>
      )}

      <ResultsEditor occurrenceId={occurrenceId} existing={existing} labels={labels} />
    </main>
  );
}
