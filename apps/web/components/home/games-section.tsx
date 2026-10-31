import { ArrowRight, CalendarDays, MapPin } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { CSSProperties } from 'react';

import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';
import { SPORT_VISUALS } from '@/lib/design/sport-visuals';
import { dayWord, whenParts } from '@/lib/home/when';
import type { SessionSummary } from '@/lib/sessions/occurrence';
import type { CanonicalSport } from '@sportkarta/lib/sports';

import { GamesRail } from './games-rail';
import { SectionHead } from './section-head';

/**
 * «Включете се в игра» — the next public sessions, the list /sesii opens with,
 * as a rail of cards. A session names its title, place, time and how full it
 * is; never who is going (the roster is the organiser's, not the public's).
 */
export async function GamesSection({ games, locale }: { games: SessionSummary[]; locale: string }) {
  const t = await getTranslations('Home.games');

  return (
    <section
      aria-labelledby="home-games"
      className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20"
    >
      <SectionHead id="home-games" overline={t('overline')} title={t('title')} lead={t('lead')}>
        <div className="flex flex-wrap gap-2">
          <Link href="/sesii" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            {t('all')}
          </Link>
          <Link
            href="/sedmitsata"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'max-sm:px-1.5')}
          >
            {t('weekly')}
            <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </div>
      </SectionHead>

      <div className="mt-8">
        <GamesList games={games} locale={locale} />
      </div>
    </section>
  );
}

/**
 * The rail itself, or its honest empty state — also shown inside the front
 * page's «Тренирайте» chapter, under the recording of how to join one.
 */
export async function GamesList({ games, locale }: { games: SessionSummary[]; locale: string }) {
  const [t, tSport] = await Promise.all([getTranslations('Home.games'), getTranslations('Sport')]);

  return (
    <>
      {games.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-card border border-dashed border-line-strong bg-surface/60 p-6 sm:flex-row sm:items-center">
          <span className="grid size-12 shrink-0 place-items-center rounded-full bg-accent-subtle text-accent-active">
            <CalendarDays size={22} aria-hidden="true" />
          </span>
          <div className="flex-1">
            <p className="text-body font-bold text-ink">{t('emptyTitle')}</p>
            <p className="mt-1 text-body-sm text-ink-soft">{t('emptyBody')}</p>
          </div>
          <Link href="/sedmitsata" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
            {t('weekly')}
          </Link>
        </div>
      ) : (
        <GamesRail labels={{ prev: t('prev'), next: t('next') }}>
          {games.map((game) => {
            const visual =
              game.sport in SPORT_VISUALS
                ? SPORT_VISUALS[game.sport as CanonicalSport]
                : SPORT_VISUALS.multi;
            const Icon = visual.Icon;
            const [date, time] = whenParts(game.startsAtLocal, locale);
            const word = dayWord(game.startsAtLocal);
            const full = game.capacity !== null && game.going >= game.capacity;
            const fill =
              game.capacity && game.capacity > 0
                ? Math.min(100, Math.round((game.going / game.capacity) * 100))
                : null;
            return (
              <li key={game.occurrenceId} className="w-72 shrink-0 snap-start">
                <Link
                  href={`/sesiya/${game.occurrenceId}`}
                  className="group flex h-full flex-col rounded-card border border-line bg-surface p-4 shadow-sm transition-[box-shadow,transform,border-color] duration-200 ease-standard hover:-translate-y-0.5 hover:border-brand-border hover:shadow-md focus-visible:shadow-[var(--ring)]"
                >
                  <span className="flex items-start justify-between gap-3">
                    <span
                      className="grid size-12 shrink-0 place-items-center rounded-md"
                      style={
                        {
                          background: `color-mix(in srgb, ${visual.color} 16%, var(--surface))`,
                          color: visual.color,
                        } as CSSProperties
                      }
                    >
                      <Icon size={22} aria-hidden="true" />
                    </span>
                    <span className="text-right font-mono">
                      <span
                        className={`block text-caption font-medium uppercase ${
                          word ? 'text-accent-active' : 'text-ink-soft'
                        }`}
                      >
                        {word ? t(word) : date}
                      </span>
                      <span className="block text-h4 font-semibold tabular-nums text-ink">
                        {time}
                      </span>
                    </span>
                  </span>
                  <span className="mt-4 line-clamp-2 text-body font-bold text-ink group-hover:text-brand">
                    {game.title}
                  </span>
                  <span className="mt-1 flex items-center gap-1 truncate text-caption text-text-muted">
                    <MapPin size={13} aria-hidden="true" className="shrink-0" />
                    <span className="truncate">{game.facilityName ?? tSport(game.sport)}</span>
                  </span>
                  <span className="mt-auto block pt-5">
                    {fill !== null && (
                      <span className="block h-1.5 overflow-hidden rounded-pill bg-paper-sunk">
                        <span
                          className={`block h-full rounded-pill ${full ? 'bg-accent' : 'bg-brand'}`}
                          style={{ width: `${fill}%` }}
                        />
                      </span>
                    )}
                    <span className="mt-1.5 block font-mono text-caption tabular-nums text-ink-soft">
                      {full
                        ? t('full')
                        : game.capacity
                          ? t('spots', { going: game.going, capacity: game.capacity })
                          : t('going', { count: game.going })}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </GamesRail>
      )}
    </>
  );
}
