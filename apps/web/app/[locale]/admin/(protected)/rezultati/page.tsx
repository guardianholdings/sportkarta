import { getDb } from '@sportkarta/db';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { requireRole } from '@/lib/auth-session';
import { occurrencesAwaitingResults } from '@/lib/results';

/**
 * The results worklist (docs/ROADMAP.md §6, Stage 4.6): finished occurrences,
 * newest first, with the ones still missing results called out.
 */

export default async function AdminResultsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requireRole('admin');

  const [t, tSport, occurrences] = await Promise.all([
    getTranslations('AdminResults'),
    getTranslations('Sport'),
    occurrencesAwaitingResults(getDb()),
  ]);

  const pending = occurrences.filter((o) => o.resultCount === 0);
  const recorded = occurrences.filter((o) => o.resultCount > 0);

  return (
    <main className="space-y-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      {/* The no-timing-hardware boundary, said where an operator will read it. */}
      <p className="max-w-prose text-sm text-neutral-600">{t('intro')}</p>

      {occurrences.length === 0 && <p className="text-sm text-neutral-500">{t('noOccurrences')}</p>}

      {[
        { heading: t('pending'), rows: pending },
        { heading: t('recorded'), rows: recorded },
      ]
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <section key={group.heading} className="space-y-2">
            <h2 className="text-lg font-semibold">{group.heading}</h2>
            <div className="overflow-x-auto rounded border border-neutral-200">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t('when')}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('occurrence')}</th>
                    <th className="px-3 py-2 text-left font-medium">{t('facility')}</th>
                    <th className="px-3 py-2 text-right font-medium">{t('title')}</th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((occurrence) => (
                    <tr key={occurrence.occurrenceId} className="border-t border-neutral-100">
                      <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                        {occurrence.startsAtLocal.replace('T', ' ').slice(0, 16)}
                      </td>
                      <td className="px-3 py-2">
                        {occurrence.title}
                        <span className="text-neutral-500"> · {tSport(occurrence.sport)}</span>
                      </td>
                      <td className="px-3 py-2 text-neutral-600">{occurrence.facilityName}</td>
                      <td className="px-3 py-2 text-right">
                        <Link
                          href={`/admin/rezultati/${occurrence.occurrenceId}`}
                          className="underline"
                        >
                          {occurrence.resultCount === 0
                            ? t('save')
                            : `${String(occurrence.resultCount)}`}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
    </main>
  );
}
