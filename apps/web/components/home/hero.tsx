import { ArrowRight, LocateFixed, Search } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { PopsMark } from '@/components/shell/pops-mark';
import { buttonVariants } from '@/components/ui/button';
import { getPathname, Link } from '@/i18n/navigation';
import { takesVav } from '@/lib/grammar';
import { cn } from '@/lib/utils';
import { cellKey, dotPosition } from '@/lib/home/dot-grid';
import type { DotLayer, GamePulses, MaskCell } from '@/lib/home/dots';
import type { NamedPlace, TopPlace } from '@/lib/home/places';
import { MIN_LISTING_FACILITIES } from '@/lib/places';
import type { SportCount } from '@/lib/home/sections';
import type { NationalStats } from '@/lib/stats-data';

import type { DotMapData } from './dot-map';
import { HeroMap, type HeroChip } from './hero-map';

export interface HeroDots {
  mask: MaskCell[];
  layer: DotLayer;
  pulses: GamePulses;
  places: Map<number, NamedPlace>;
  top: TopPlace[];
}

/**
 * The map's data in the compact form the client draws from (dot-map.tsx). A
 * lit cell is filed under the municipality most of its places belong to; one
 * the query could not attribute falls back to the polygon under its centre.
 */
function dotMapData(dots: HeroDots, cityLabel: (city: string) => string): DotMapData {
  const lit = new Set(dots.layer.cells.map((cell) => cellKey(cell.i, cell.j)));
  const maskMunicipality = new Map(dots.mask.map((cell) => [cellKey(cell.i, cell.j), cell.m]));
  return {
    land: dots.mask
      .filter((cell) => !lit.has(cellKey(cell.i, cell.j)))
      .map((cell) => {
        const { x, y } = dotPosition(cell.i, cell.j);
        return `M${x} ${y}h0`;
      })
      .join(''),
    cells: dots.layer.cells.flatMap((cell) => [
      cell.i,
      cell.j,
      cell.n,
      cell.m ?? maskMunicipality.get(cellKey(cell.i, cell.j)) ?? -1,
    ]),
    municipalities: dots.layer.municipalities.flat(),
    places: [...dots.places].map(([m, place]) => [
      m,
      place.name,
      place.slug,
      place.slug ? cityLabel(place.name) : null,
    ]),
    pulses: dots.pulses.cells.flatMap((cell) => [cell.i, cell.j]),
  };
}

/**
 * The first screen: what POPS is, the two ways in (a search, «Близо до мен»)
 * and the country itself as live data.
 *
 * Both ways in are plain links and a GET form to /karta, so they work before —
 * and without — any JavaScript; the map reads `?q=` and `?blizo=1` once and
 * drops them (map-explorer.tsx). «Близо до мен» deliberately does NOT locate
 * here: the map asks for the position itself, so the hand-off carries a flag,
 * never a coordinate. (Once located, the map writes the camera it flies to into
 * its own address bar, as its «Около мен» always has.)
 */
export async function Hero({
  locale,
  dots,
  sports,
  numbers,
}: {
  locale: string;
  dots: HeroDots | null;
  sports: SportCount[];
  /** The national figures for the trust line; null leaves the line out. */
  numbers: NationalStats | null;
}) {
  const [t, tSport] = await Promise.all([getTranslations('Home'), getTranslations('Sport')]);
  const searchAction = getPathname({ href: '/karta', locale });

  const chips: HeroChip[] = dots
    ? [
        {
          sport: null,
          label: t('dots.all'),
          count: dots.layer.total,
          stat: t('dots.statAll', { count: dots.layer.total }),
        },
        ...sports.map((item) => ({
          sport: item.sport,
          label: tSport(item.sport),
          count: item.count,
          stat: t('dots.statSport', { count: item.count, sport: tSport(item.sport) }),
        })),
      ]
    : [];

  return (
    <section aria-labelledby="home-title" className="sk-home-hero">
      <div className="mx-auto grid max-w-6xl items-center gap-x-14 gap-y-10 px-4 pb-14 pt-8 sm:px-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:px-8 lg:pb-20 lg:pt-16">
        <div className="flex min-w-0 flex-col gap-6">
          <p className="flex items-center gap-2 text-body-sm font-semibold text-ink-soft">
            <PopsMark size={22} className="text-accent" />
            {t('hero.overline')}
          </p>
          <h1
            id="home-title"
            className="text-h1 font-extrabold leading-tight tracking-tight text-ink sm:text-display-lg"
          >
            {t('hero.title')}
          </h1>
          <p className="max-w-xl text-body-lg text-ink-soft">{t('hero.lead')}</p>

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
            <Link
              href="/karta"
              className={cn(buttonVariants({ variant: 'ghost' }), 'max-sm:px-1.5')}
            >
              {t('hero.openMap')}
              <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>

          {numbers && (
            <p className="text-body-sm text-ink-soft">
              {t('hero.trust', {
                // The dot map's own count when it loaded, so the first screen tells one number once.
                places: dots?.layer.total ?? numbers.free,
                municipalities: numbers.municipalitiesCovered,
                sports: numbers.sportsCount,
              })}{' '}
              <Link href="/statistika" className="font-semibold text-link hover:text-link-hover">
                {t('hero.trustLink')}
              </Link>
            </p>
          )}
        </div>

        {dots && (
          <HeroMap
            locale={locale}
            data={dotMapData(dots, (city) => t('dots.openCity', { city, cityVav: takesVav(city) }))}
            title={t('dots.mapTitle', { count: dots.layer.total })}
            chips={chips}
            initialTop={dots.top}
            cityPageMin={MIN_LISTING_FACILITIES}
            labels={{
              filter: t('dots.filterLabel'),
              showOnMap: t('dots.showOnMap'),
              topLabel: t('dots.topLabel'),
              placesOne: t('dots.placesOne'),
              placesOther: t('dots.placesOther'),
              openHere: t('dots.openHere'),
              close: t('dots.close'),
              hint: t('dots.hint'),
              loadError: t('dots.loadError'),
              attribution: t('dots.attribution'),
            }}
            legend={
              // Keyed: an element built as a PROP arrives in the client
              // unvalidated, and HeroMap renders it beside a sibling.
              <ul key="legend" className="flex flex-col gap-1.5 text-caption text-ink-soft">
                <li key="places" className="flex items-center gap-2">
                  <span aria-hidden="true" className="sk-legend-dot" />
                  {t('dots.placesLegend')}
                </li>
                {dots.pulses.total > 0 && (
                  <li key="games" className="flex items-center gap-2">
                    <span aria-hidden="true" className="sk-legend-dot sk-legend-dot--game" />
                    {t('dots.gamesLegend', { count: dots.pulses.total })}
                  </li>
                )}
              </ul>
            }
          />
        )}
      </div>
    </section>
  );
}
