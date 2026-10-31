import { ArrowRight, LocateFixed, Search } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { buttonVariants } from '@/components/ui/button';
import { getPathname, Link } from '@/i18n/navigation';
import { cn } from '@/lib/utils';

/**
 * The two ways into the map — a search and «Близо до мен» — plus «Отворете
 * картата». The hero's controls, and on a signed-in member's home the search
 * that stands in for the whole hero (UX audit N4).
 *
 * Plain links and a GET form to /karta, so they work before — and without —
 * any JavaScript; the map reads `?q=` and `?blizo=1` once and drops them
 * (map-explorer.tsx). «Близо до мен» deliberately does NOT locate here: the
 * map asks for the position itself, so the hand-off carries a flag, never a
 * coordinate.
 */
export async function PlaceSearch({ locale }: { locale: string }) {
  const t = await getTranslations('Home');
  const searchAction = getPathname({ href: '/karta', locale });

  return (
    <div className="flex flex-col gap-4">
      <form action={searchAction} method="get" role="search" className="flex flex-col gap-2">
        <label htmlFor="home-q" className="text-body-sm font-semibold text-ink">
          {t('hero.searchLabel')}
        </label>
        <div className="sk-home-search flex items-center gap-2 rounded-pill border border-line-strong bg-surface p-1.5 pl-4 shadow-sm">
          <Search size={20} aria-hidden="true" className="shrink-0 text-text-muted" />
          <input
            id="home-q"
            name="q"
            type="search"
            autoComplete="off"
            enterKeyHint="search"
            placeholder={t('hero.searchPlaceholder')}
            className="h-11 min-w-0 flex-1 bg-transparent text-body text-ink placeholder:text-text-faint focus:outline-none"
          />
          <button type="submit" className={buttonVariants({ variant: 'primary' })}>
            {t('hero.searchSubmit')}
          </button>
        </div>
      </form>

      <div className="flex flex-wrap gap-2">
        <Link href="/karta?blizo=1" className={buttonVariants({ variant: 'secondary' })}>
          <LocateFixed size={18} aria-hidden="true" />
          {t('hero.nearMe')}
        </Link>
        <Link href="/karta" className={cn(buttonVariants({ variant: 'ghost' }), 'max-sm:px-1.5')}>
          {t('hero.openMap')}
          <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
