import { getLocale, getTranslations } from 'next-intl/server';

import type { MonthlyActivity, PassportHistoryEntry } from '@sportkarta/db';

import { Link } from '@/i18n/navigation';

/**
 * The member's OWN history: what they did, where, and when.
 *
 * This component is only ever rendered on `/pasport`, behind requireUser. It is
 * the specific counterpart to PublicActivityList below, and the difference
 * between the two is the whole privacy design: a person may see their own
 * movements; a public page may not publish somebody's.
 */
export async function HistoryList({ entries }: { entries: PassportHistoryEntry[] }) {
  const [t, locale] = await Promise.all([getTranslations('Passport'), getLocale()]);

  if (entries.length === 0) {
    return <p className="text-body-sm text-ink-soft">{t('historyEmpty')}</p>;
  }

  const formatDate = (value: string): string =>
    new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));

  return (
    <ul className="space-y-1 text-body-sm">
      {entries.map((entry) => (
        <li key={`${entry.kind}-${entry.at}`} className="flex flex-wrap gap-2">
          <span className="text-text-muted">{formatDate(entry.at)}</span>
          <span>
            {entry.facilitySlug ? (
              <Link
                href={`/obekt/${entry.facilitySlug}`}
                className="font-medium text-link hover:text-link-hover"
              >
                {entry.facilityName ?? t(`event_${entry.kind}`)}
              </Link>
            ) : (
              (entry.facilityName ?? t(`event_${entry.kind}`))
            )}
          </span>
          <span className="text-text-muted">{t(`event_${entry.kind}`)}</span>
          {entry.points > 0 && (
            <span className="ml-auto font-mono font-medium tabular-nums text-brand">
              +{entry.points}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * The public activity view — monthly counts, and nothing else.
 *
 * No place, no day, no time. A public page that says a named person was at a
 * particular pitch at 18:04 last Tuesday publishes where they reliably are and
 * when; a month bucket says "this person has been active" without telling
 * anybody where to find them. The aggregation happens in SQL
 * (db/src/passport.ts), so there is no facility id in this component's props to
 * leak by accident in a later change.
 */
export async function PublicActivityList({ months }: { months: MonthlyActivity[] }) {
  const t = await getTranslations('Passport');

  if (months.length === 0) {
    return <p className="text-body-sm text-ink-soft">{t('historyEmpty')}</p>;
  }

  return (
    <ul className="space-y-1 text-body-sm">
      {months.map((month) => (
        <li key={month.month} className="flex gap-3">
          <span className="tabular-nums text-text-muted">{month.month}</span>
          <span>{t('monthlyContributions', { count: month.contributions })}</span>
          <span className="text-text-muted">{t('monthlyCheckins', { count: month.checkins })}</span>
        </li>
      ))}
    </ul>
  );
}
