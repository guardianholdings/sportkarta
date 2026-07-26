import type { ParticipationEntry } from '@sportkarta/db';
import { getTranslations } from 'next-intl/server';

import { Link } from '@/i18n/navigation';

/**
 * The sport participation board (operator request 2026-07-26).
 *
 * THE BOARD `/klasirane?sport=…` ALWAYS LOOKED LIKE IT WAS. The existing filter
 * narrows CONTRIBUTIONS by the sport of the facility contributed to, so it
 * answers "who edited football pitches" — a real question, and not the one
 * anybody reads it as. This one counts trainings, so it answers "who plays
 * football". Both now exist side by side and each says what it means.
 *
 * RANKED BY SESSIONS, not minutes and not kilometres (operator decision
 * 2026-07-26). A climb and a swim are both one turn-out, so a count is the only
 * unit comparable across 29 sports — and a count cannot be inflated by
 * exaggerating one entry, which matters when most rows are self-reported.
 * Minutes and distance are shown because they make a row informative, and are
 * deliberately not what the order depends on.
 *
 * EVERY NAME HERE IS ALREADY PUBLIC: `sportParticipationBoard` inner-joins
 * `leaderboard_eligible_members`, so a row exists only for a member whose
 * passport a visitor could already open, and the name links to it.
 */
export async function ParticipationTable({
  entries,
  highlightHandle,
}: {
  entries: ParticipationEntry[];
  highlightHandle?: string | null;
}) {
  const t = await getTranslations('Participation');

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
              {t('columnSessions')}
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              {t('columnMinutes')}
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
              {/* The ranked column, emphasised; the rest is context. */}
              <td className="py-2 pr-3 text-right font-medium tabular-nums">{entry.sessions}</td>
              <td className="py-2 text-right tabular-nums text-text-muted">{entry.minutes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
