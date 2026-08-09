import type { LeaderboardEntry } from '@sportkarta/db';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

/**
 * The ranked table.
 *
 * Everyone here has opted their passport public, so the name links to that
 * passport — the leaderboard is a ranked index of passports people chose to
 * publish, not a separate exposure. Nobody appears whose own page a visitor
 * could not already open.
 *
 * Ties share a rank (the SQL uses `rank()`), so the rank column repeats rather
 * than inventing an order between two people on the same score.
 */
export async function LeaderboardTable({
  entries,
  highlightHandle,
}: {
  entries: LeaderboardEntry[];
  highlightHandle?: string | null;
}) {
  const t = await getTranslations('Leaderboard');

  if (entries.length === 0) {
    return <p className="text-body-sm text-ink-soft">{t('empty')}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-body-sm">
        <caption className="sr-only">{t('tableCaption')}</caption>
        <thead>
          <tr className="border-b border-line text-left text-caption text-text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('columnRank')}
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {t('columnMember')}
            </th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">
              {t('columnPoints')}
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              {t('columnContributions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.handle}
              className={
                entry.handle === highlightHandle
                  ? 'border-b border-line bg-paper-sunk'
                  : 'border-b border-line'
              }
            >
              <td className="py-2 pr-3 tabular-nums text-text-muted">{entry.rank}</td>
              <td className="py-2 pr-3">
                <Link
                  href={`/pasport/${entry.handle}`}
                  className="font-medium text-link hover:text-link-hover"
                >
                  {entry.displayName}
                </Link>
                {entry.homeCity && (
                  <span className="ml-2 text-caption text-text-muted">{entry.homeCity}</span>
                )}
              </td>
              <td className="py-2 pr-3 text-right font-medium tabular-nums">{entry.points}</td>
              <td className="py-2 text-right tabular-nums text-text-muted">
                {entry.contributions}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
