import { getTranslations } from 'next-intl/server';

import type { PassportStreakView } from '@/lib/passport';

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
 */
export async function StreakPanel({ streaks }: { streaks: PassportStreakView }) {
  const t = await getTranslations('Passport');

  const stats = [
    { key: 'currentDays', value: streaks.currentDays },
    { key: 'longestDays', value: streaks.longestDays },
    { key: 'currentWeeks', value: streaks.currentWeeks },
    { key: 'longestWeeks', value: streaks.longestWeeks },
  ] as const;

  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.key} className="rounded-card border border-line bg-surface p-3 shadow-sm">
          <dt className="text-caption text-text-muted">{t(`streak_${stat.key}`)}</dt>
          <dd className="mt-1 font-mono text-h3 font-bold text-ink tabular-nums">{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}
