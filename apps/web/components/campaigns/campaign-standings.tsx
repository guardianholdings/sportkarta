import type { FrozenResultRow, StandingRow } from '@sportkarta/db';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

/**
 * Campaign standings, live or frozen.
 *
 * The two boards differ in what they can possibly show, not in styling:
 *
 *   individual  members who opted their passport public, at any age.
 *               Unpublished members are SCORED — they can win — but never
 *               named here.
 *   city        municipalities. Nobody is named, which is exactly why a city
 *               board can safely include everyone, and why small municipalities
 *               are suppressed upstream (a row backed by one person is that
 *               person's score wearing a city's name).
 */
export async function CampaignStandings({
  rows,
  leaderboardType,
  cityNames,
}: {
  rows: StandingRow[];
  leaderboardType: 'individual' | 'city';
  cityNames: Record<number, string>;
}) {
  const t = await getTranslations('Campaign');

  if (rows.length === 0) {
    return <p className="text-body-sm text-ink-soft">{t('noScoresYet')}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-body-sm">
        <thead>
          <tr className="border-b border-line text-left text-caption text-text-muted">
            <th scope="col" className="py-2 pr-3 font-medium">{t('columnRank')}</th>
            <th scope="col" className="py-2 pr-3 font-medium">
              {leaderboardType === 'city' ? t('columnCity') : t('columnMember')}
            </th>
            {leaderboardType === 'city' && (
              <th scope="col" className="py-2 pr-3 text-right font-medium">
                {t('columnMembers')}
              </th>
            )}
            <th scope="col" className="py-2 text-right font-medium">
              {t('columnScore')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.rank}-${row.handle ?? row.municipalityId ?? ''}`}
              className="border-b border-line"
            >
              <td className="py-2 pr-3 font-mono tabular-nums text-text-muted">{row.rank}</td>
              <td className="py-2 pr-3">
                {leaderboardType === 'city' ? (
                  (cityNames[row.municipalityId ?? -1] ?? '—')
                ) : row.handle ? (
                  <Link href={`/pasport/${row.handle}`} className="font-medium text-link hover:text-link-hover">
                    {row.displayName}
                  </Link>
                ) : (
                  t('withheld')
                )}
              </td>
              {leaderboardType === 'city' && (
                <td className="py-2 pr-3 text-right font-mono tabular-nums text-text-muted">
                  {row.memberCount}
                </td>
              )}
              <td className="py-2 text-right font-mono font-medium tabular-nums">{row.score}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The FROZEN close-out board.
 *
 * The numbers came from campaign_results and cannot move again. The names are
 * resolved live, so a member who has since been erased or made their passport
 * private keeps their placing and loses their name — rendered as "участник"
 * rather than a blank, so the ranking stays legible instead of looking broken.
 */
export async function FrozenStandings({
  rows,
  leaderboardType,
  cityNames,
}: {
  rows: FrozenResultRow[];
  leaderboardType: 'individual' | 'city';
  cityNames: Record<number, string>;
}) {
  const t = await getTranslations('Campaign');

  if (rows.length === 0) {
    return <p className="text-body-sm text-ink-soft">{t('noResults')}</p>;
  }

  return (
    <ol className="space-y-2">
      {rows.map((row) => (
        <li
          key={`${row.rank}-${row.handle ?? row.municipalityId ?? row.score}`}
          className={
            row.rank <= 3
              ? 'flex items-baseline gap-3 rounded-card border border-brand-border bg-brand-subtle p-3'
              : 'flex items-baseline gap-3 border-b border-line px-3 py-2'
          }
        >
          <span className="w-8 font-mono text-h4 font-bold text-ink tabular-nums">{row.rank}</span>
          <span className="flex-1">
            {leaderboardType === 'city'
              ? (cityNames[row.municipalityId ?? -1] ?? '—')
              : row.handle
                ? (
                    <Link href={`/pasport/${row.handle}`} className="font-medium text-link hover:text-link-hover">
                      {row.displayName}
                    </Link>
                  )
                : t('withheld')}
            {leaderboardType === 'city' && (
              <span className="ml-2 text-caption text-text-muted">
                {t('memberCount', { count: row.memberCount })}
              </span>
            )}
          </span>
          <span className="font-medium tabular-nums">{row.score}</span>
        </li>
      ))}
    </ol>
  );
}
