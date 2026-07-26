import { getTranslations } from 'next-intl/server';

import type { PublicStreakView } from '@/lib/passport';

/**
 * Streaks: days of any activity, and weeks with a game.
 *
 * Both current and longest are shown. A member whose streak just broke should
 * see what they achieved rather than a zero that erases it — and the longest
 * run is what the streak badges actually score, so showing only the current one
 * would make the badge look wrong.
 *
 * Every number here is a COUNT of civil periods, not a date, which is also what
 * makes this panel safe to render on a public passport.
 *
 * Takes the PUBLIC shape, so the same component serves both pages and cannot
 * accidentally render owner-only state on /pasport/[handle]. `atRisk` is passed
 * separately and only by the owner's page: "has not played yet this week" is a
 * statement about what a named person is doing right now, and a public page
 * must not make it.
 */
export async function StreakPanel({
  streaks,
  atRisk = false,
}: {
  streaks: PublicStreakView;
  atRisk?: boolean;
}) {
  const t = await getTranslations('Passport');

  const stats = [
    { key: 'currentDays', value: streaks.currentDays },
    { key: 'longestDays', value: streaks.longestDays },
    { key: 'currentWeeks', value: streaks.currentWeeks },
    { key: 'longestWeeks', value: streaks.longestWeeks },
  ] as const;

  return (
    <>
      {atRisk && (
        // Amber, never --danger: the run is not broken yet, and red would say it
        // was. Words as well as colour, so the state does not depend on hue.
        <p
          role="status"
          className="mb-3 rounded-card border border-warning-border bg-warning-bg px-3 py-2 text-body-sm text-warning-ink"
        >
          {t('streak_atRisk')}
        </p>
      )}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.key} className="rounded-card border border-line bg-surface p-3 shadow-sm">
          <dt className="text-caption text-text-muted">{t(`streak_${stat.key}`)}</dt>
          <dd className="mt-1 font-mono text-h3 font-bold text-ink tabular-nums">{stat.value}</dd>
        </div>
      ))}
      </dl>
    </>
  );
}
