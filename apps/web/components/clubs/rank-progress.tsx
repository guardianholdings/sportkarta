import { sofiaToday } from '@sportkarta/lib/clubs';
import { getTranslations } from 'next-intl/server';

import type { RankProgress } from '@/lib/clubs/ranks';
import { formatDate } from '@/lib/format';

/**
 * How far a client is from their next rank (0056) — the office and the
 * portal say it the same way: check-ins against what the next rank asks, and
 * the day its months are met. Figures only; readiness is the database's.
 */
export async function RankProgressText({
  progress,
  locale,
  className,
}: {
  progress: RankProgress;
  locale: string;
  className?: string;
}) {
  const t = await getTranslations('ClubRanks.progress');
  const parts: string[] = [];
  if (!progress.next) {
    parts.push(t('top'));
  } else {
    if (progress.minAttendances !== null) {
      parts.push(t('attendances', { done: progress.attended, need: progress.minAttendances }));
    } else {
      parts.push(
        t('attended', {
          count: progress.attended,
          date: formatDate(progress.awardedOn, locale, 'medium'),
        }),
      );
    }
    if (progress.monthsMetOn !== null) {
      parts.push(
        progress.monthsMetOn <= sofiaToday()
          ? t('monthsMet')
          : t('monthsFrom', { date: formatDate(progress.monthsMetOn, locale, 'medium') }),
      );
    }
    if (progress.minAttendances === null && progress.minMonths === null) {
      parts.push(t('noAsks'));
    }
  }
  return <span className={className}>{parts.join(' · ')}</span>;
}
