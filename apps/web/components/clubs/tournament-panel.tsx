import { MATCH_SCORE_MAX, TOURNAMENT_FORMATS } from '@sportkarta/lib/clubs';
import { getTranslations } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { Match, Tournament } from '@/lib/clubs/tournaments';

/**
 * A tournament's draw, results and table (0054), for the office or the public
 * page. It shows the names the tournament carries: the office's read names
 * every entrant, the public read only the consented ones (decided in its
 * statement) — anybody else is «Участник N». Forms appear only where the
 * viewer may act (the actions and the statements behind them decide again).
 */
export async function TournamentPanel({
  slug,
  eventId,
  tournament,
  office,
  canDraw,
  canRecord,
  drawAction,
  recordAction,
}: {
  slug: string;
  eventId: string;
  tournament: Tournament;
  office: boolean;
  canDraw: boolean;
  canRecord: boolean;
  drawAction?: (formData: FormData) => Promise<void>;
  recordAction?: (formData: FormData) => Promise<void>;
}) {
  const t = await getTranslations('ClubEvents.tournament');
  const byId = new Map(tournament.entrants.map((e) => [e.registrationId, e]));
  const nameOf = (id: string | null) => {
    if (id === null) return t('tbd');
    const entrant = byId.get(id);
    if (!entrant) return t('withdrawn');
    const name = entrant.name ?? t('anonymous', { number: entrant.number });
    return entrant.withdrawn ? `${name} · ${t('withdrawn')}` : name;
  };
  const rounds = [...new Set(tournament.matches.map((m) => m.round))];
  const finalRound = rounds.length > 0 ? Math.max(...rounds) : 0;
  const recorded = tournament.matches.some((m) => m.status === 'played' || m.status === 'walkover');
  const roundName = (round: number) =>
    tournament.format === 'single_elimination' && round === finalRound
      ? t('final')
      : tournament.format === 'single_elimination' && round === finalRound - 1
        ? t('semifinal')
        : t('round', { round });
  const small = 'block text-caption text-ink-soft';

  const result = (match: Match) =>
    match.status === 'played'
      ? `${String(match.scoreA)} : ${String(match.scoreB)}`
      : match.status === 'walkover'
        ? t('walkover')
        : match.status === 'bye'
          ? t('bye')
          : '—';

  return (
    <section
      className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm"
      aria-labelledby="tournament-h"
    >
      <h2 id="tournament-h" className="text-h4 font-bold text-ink">
        {t('title')}
      </h2>
      {tournament.format === null ? (
        <p className="text-body-sm text-text-muted">
          {office ? t('notDrawn', { count: tournament.entrants.length }) : t('notDrawnPublic')}
        </p>
      ) : (
        <p className="text-caption text-text-muted">{t(`formats.${tournament.format}`)}</p>
      )}

      {office && canDraw && drawAction && !recorded && (
        <form action={drawAction} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="eventId" value={eventId} />
          <label className={small}>
            {t('format')}
            <Select name="format" size="sm" className="mt-1" defaultValue="single_elimination">
              {TOURNAMENT_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {t(`formats.${format}`)}
                </option>
              ))}
            </Select>
          </label>
          <label className={small}>
            {t('seeding')}
            <Select name="seeding" size="sm" className="mt-1" defaultValue="arrival">
              <option value="arrival">{t('seedings.arrival')}</option>
              {!tournament.teamEvent && tournament.sport && (
                <option value="rating">{t('seedings.rating')}</option>
              )}
            </Select>
          </label>
          <Button type="submit" size="sm">
            {tournament.format === null ? t('draw') : t('redraw')}
          </Button>
        </form>
      )}

      {rounds.map((round) => (
        <div key={round} className="space-y-1">
          <h3 className="text-body-sm font-bold text-ink">{roundName(round)}</h3>
          <ul className="divide-y divide-line">
            {tournament.matches
              .filter((m) => m.round === round)
              .map((match) => (
                <li key={match.id} className="space-y-1 py-2 text-body-sm">
                  <p className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="min-w-0 text-ink">
                      <span className={match.winner === match.a && match.a ? 'font-bold' : ''}>
                        {nameOf(match.a)}
                      </span>
                      {match.status !== 'bye' && (
                        <>
                          {' – '}
                          <span className={match.winner === match.b && match.b ? 'font-bold' : ''}>
                            {nameOf(match.b)}
                          </span>
                        </>
                      )}
                    </span>
                    <span className="font-mono tabular-nums text-ink-soft">{result(match)}</span>
                  </p>
                  {office &&
                    canRecord &&
                    recordAction &&
                    match.a !== null &&
                    match.b !== null &&
                    match.status !== 'bye' && (
                      <details className="rounded-md border border-line p-2">
                        <summary className="cursor-pointer text-caption font-semibold text-link">
                          {match.status === 'pending' ? t('enter') : t('correct')}
                        </summary>
                        <form action={recordAction} className="mt-2 flex flex-wrap items-end gap-2">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="eventId" value={eventId} />
                          <input type="hidden" name="matchId" value={match.id} />
                          <label className={small}>
                            {nameOf(match.a)}
                            <Input
                              name="scoreA"
                              type="number"
                              min={0}
                              max={MATCH_SCORE_MAX}
                              size="sm"
                              className="mt-1 block w-24"
                              defaultValue={match.scoreA ?? ''}
                            />
                          </label>
                          <label className={small}>
                            {nameOf(match.b)}
                            <Input
                              name="scoreB"
                              type="number"
                              min={0}
                              max={MATCH_SCORE_MAX}
                              size="sm"
                              className="mt-1 block w-24"
                              defaultValue={match.scoreB ?? ''}
                            />
                          </label>
                          <label className={small}>
                            {t('walkoverLabel')}
                            <Select name="walkover" size="sm" className="mt-1" defaultValue="">
                              <option value="">{t('walkoverNone')}</option>
                              <option value="a">{nameOf(match.a)}</option>
                              <option value="b">{nameOf(match.b)}</option>
                            </Select>
                          </label>
                          <Button type="submit" size="sm">
                            {t('save')}
                          </Button>
                        </form>
                      </details>
                    )}
                </li>
              ))}
          </ul>
        </div>
      ))}

      {tournament.standings && tournament.standings.length > 0 && (
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[20rem] text-body-sm">
            <caption className="pb-1 text-left text-body-sm font-bold text-ink">
              {t('table')}
            </caption>
            <thead>
              <tr className="text-left text-caption text-text-muted">
                <th scope="col" className="py-1 pr-2">
                  #
                </th>
                <th scope="col" className="py-1 pr-2">
                  {t('entrant')}
                </th>
                <th scope="col" className="py-1 pr-2 text-right">
                  {t('playedShort')}
                </th>
                <th scope="col" className="py-1 pr-2 text-right">
                  {t('wdl')}
                </th>
                <th scope="col" className="py-1 pr-2 text-right">
                  {t('diff')}
                </th>
                <th scope="col" className="py-1 text-right">
                  {t('points')}
                </th>
              </tr>
            </thead>
            <tbody>
              {tournament.standings.map((row, i) => (
                <tr key={row.entrant} className="border-t border-line">
                  <td className="py-1 pr-2 tabular-nums">{i + 1}</td>
                  <td className="py-1 pr-2 text-ink">{nameOf(row.entrant)}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{row.played}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {row.won}-{row.drawn}-{row.lost}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {row.scoreFor - row.scoreAgainst}
                  </td>
                  <td className="py-1 text-right font-semibold tabular-nums">{row.points}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!office && tournament.format !== null && (
        <p className="text-caption text-text-muted">{t('privacy')}</p>
      )}
      {office && tournament.format !== null && <Badge tone="neutral">{t('derived')}</Badge>}
    </section>
  );
}
