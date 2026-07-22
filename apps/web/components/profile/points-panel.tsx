import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { PointsSummary } from '@/lib/points';

/**
 * A member's own score and recent contributions.
 *
 * Deliberately not a ranking of any kind: minors must never appear on
 * individual public leaderboards (CLAUDE.md), and the safest way to honour that
 * is for no leaderboard to exist. Points are also earn-only — there is nothing
 * to spend them on, by design.
 */
export async function PointsPanel({ summary }: { summary: PointsSummary }) {
  const [t, locale] = await Promise.all([getTranslations('Points'), getLocale()]);
  // pg returns a full timestamp string; slicing it would print "Tue Jul 22" in
  // both locales, which is neither Bulgarian nor the format the rest of the
  // site uses (see the facility page).
  const formatDate = (value: string): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));

  return (
    <section aria-labelledby="points-h" className="space-y-3">
      <h2 id="points-h" className="text-lg font-semibold">
        {t('title')}
      </h2>
      <p className="text-2xl font-bold tracking-tight">{t('total', { points: summary.total })}</p>

      {summary.entries.length === 0 ? (
        <p className="text-sm text-neutral-600">{t('empty')}</p>
      ) : (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-neutral-500">{t('recent')}</h3>
          <ul className="space-y-1 text-sm">
            {summary.entries.map((entry) => (
              <li key={`${entry.event}-${entry.createdAt}`} className="flex gap-2">
                <span className="text-neutral-500">{formatDate(entry.createdAt)}</span>
                <span>
                  {entry.facilitySlug ? (
                    <Link href={`/obekt/${entry.facilitySlug}`} className="underline">
                      {entry.facilityName ?? t(`event_${entry.event}`)}
                    </Link>
                  ) : (
                    t(`event_${entry.event}`)
                  )}
                </span>
                <span className="ml-auto font-medium">+{entry.points}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Link href="/dobavi" className="inline-block text-sm underline">
        {t('addFacilityLink')}
      </Link>
    </section>
  );
}
