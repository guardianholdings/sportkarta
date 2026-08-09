import { getLocale, getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import type { PointsSummary } from '@/lib/points';

/**
 * A member's own score and recent contributions.
 *
 * Deliberately not a ranking of any kind: a public ranking publishes a name
 * next to an activity level and needs the member's opt-in, which the public
 * boards get by joining `leaderboard_eligible_members`. This panel is the
 * member's own history, so it needs no such gate. Points are also earn-only —
 * there is nothing to spend them on, by design.
 */
export async function PointsPanel({ summary }: { summary: PointsSummary }) {
  const [t, locale] = await Promise.all([getTranslations('Points'), getLocale()]);
  // pg returns a full timestamp string; slicing it would print "Tue Jul 22" in
  // both locales, which is neither Bulgarian nor the format the rest of the
  // site uses (see the facility page).
  const formatDate = (value: string): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));

  return (
    <section
      aria-labelledby="points-h"
      className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm"
    >
      <h2 id="points-h" className="t-overline">
        {t('title')}
      </h2>
      <p className="font-mono text-h2 font-bold tracking-tight text-ink tabular-nums">
        {t('total', { points: summary.total })}
      </p>

      {summary.entries.length === 0 ? (
        <p className="text-body-sm text-ink-soft">{t('empty')}</p>
      ) : (
        <div className="space-y-2">
          <h3 className="text-caption font-medium text-text-muted">{t('recent')}</h3>
          <ul className="divide-y divide-line text-body-sm">
            {summary.entries.map((entry) => (
              <li key={`${entry.event}-${entry.createdAt}`} className="flex gap-2 py-1.5">
                <span className="font-mono text-caption text-text-muted tabular-nums">
                  {formatDate(entry.createdAt)}
                </span>
                <span className="min-w-0 truncate">
                  {entry.facilitySlug ? (
                    <Link
                      href={`/obekt/${entry.facilitySlug}`}
                      className="font-medium text-link hover:text-link-hover"
                    >
                      {entry.facilityName ?? t(`event_${entry.event}`)}
                    </Link>
                  ) : (
                    t(`event_${entry.event}`)
                  )}
                </span>
                <span className="ml-auto font-mono font-semibold text-brand tabular-nums">
                  +{entry.points}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Link
        href="/dobavi"
        className="inline-block text-body-sm font-medium text-link hover:text-link-hover"
      >
        {t('addFacilityLink')}
      </Link>
    </section>
  );
}
