import { ArrowRight, CalendarDays, NotebookPen, Users } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { GamesList } from '@/components/home/games-section';
import { Link } from '@/i18n/navigation';
import type { SessionSummary } from '@/lib/sessions/occurrence';

const MORE = [
  { key: 'weekly', icon: CalendarDays, href: '/sedmitsata/sofia' },
  { key: 'log', icon: NotebookPen, href: '/trenirovki' },
  { key: 'organise', icon: Users, href: '/kontakt' },
] as const;

/** «Играйте», after the recording: what is on this week, and three more ways in. */
export async function PlayMore({ games, locale }: { games: SessionSummary[]; locale: string }) {
  const [t, tGames] = await Promise.all([
    getTranslations('Home.guide.play'),
    getTranslations('Home.games'),
  ]);
  return (
    <>
      <div className="mt-14">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="text-h3 font-extrabold tracking-tight text-ink">{t('upcoming')}</h3>
          <Link
            href="/igri"
            className="inline-flex items-center gap-1 text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {tGames('all')}
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </div>
        <div className="mt-5">
          <GamesList games={games} locale={locale} />
        </div>
      </div>
      <ul className="mt-10 grid gap-3 md:grid-cols-3">
        {MORE.map(({ key, icon: Icon, href }) => (
          <li key={key} className="flex flex-col rounded-card border border-line bg-surface p-5">
            <span className="grid size-10 place-items-center rounded-full bg-brand-subtle text-brand-active">
              <Icon size={19} aria-hidden="true" />
            </span>
            <span className="mt-3 text-body font-bold text-ink">{t(`${key}.title`)}</span>
            <span className="mt-1 flex-1 text-body-sm text-ink-soft">{t(`${key}.body`)}</span>
            <Link
              href={href}
              className="mt-3 inline-flex items-center gap-1 text-body-sm font-semibold text-link hover:text-link-hover"
            >
              {t(`${key}.link`)}
              <ArrowRight size={15} aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
