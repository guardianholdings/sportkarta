import { LayoutList, MapPinned, Pin } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Odometer } from '@/components/home/odometer';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { audienceFigures } from '@/lib/clubs/landing';
import type { NationalStats } from '@/lib/stats-data';
import { cn } from '@/lib/utils';

const SURFACES = [
  { key: 'directory', icon: LayoutList },
  { key: 'facility', icon: MapPinned },
  { key: 'map', icon: Pin },
] as const;

/**
 * «Клубът Ви застава пред хората, които вече търсят къде да спортуват» — the
 * audience a club gets by being on the national map, in the platform's own
 * figures (nothing person-derived), and the three surfaces it appears on.
 */
export async function AudienceBand({
  places,
  numbers,
  gamesThisWeek,
  locale,
}: {
  /** The free places the front page counts (the dot map's figure), told the same way here. */
  places: number | null;
  numbers: NationalStats | null;
  /** Shown only while above 0 (audienceFigures). */
  gamesThisWeek: number | null;
  locale: string;
}) {
  const t = await getTranslations('ClubsLanding.audience');
  const figures = audienceFigures(places, numbers?.municipalitiesCovered ?? null, gamesThisWeek);

  return (
    <section aria-labelledby="clubs-audience" className="bg-ink text-paper">
      <div className="mx-auto grid max-w-6xl gap-x-14 gap-y-10 px-4 py-14 sm:px-6 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] lg:px-8 lg:py-20">
        <div className="min-w-0">
          <p className="sk-overline sk-overline--dark">{t('overline')}</p>
          <h2
            id="clubs-audience"
            className="mt-3 text-h2 font-extrabold leading-tight tracking-tight text-paper sm:text-h1"
          >
            {t('title')}
          </h2>
          <p className="mt-3 max-w-2xl text-body text-paper/75">{t('lead')}</p>
          {figures.length > 0 && (
            <dl
              className={cn(
                'mt-8 grid gap-x-6 gap-y-6',
                figures.length === 3 ? 'grid-cols-3' : 'grid-cols-2',
              )}
            >
              {figures.map((figure) => (
                <div key={figure.key} className="flex flex-col gap-1">
                  <dt className="order-2 text-body-sm text-paper/75">{t(figure.key)}</dt>
                  <dd className="order-1 font-mono text-h1 font-bold tabular-nums leading-none text-paper sm:text-display-lg">
                    <Odometer value={figure.value} locale={locale} />
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <ul className="flex flex-col gap-3">
            {SURFACES.map((surface) => (
              <li
                key={surface.key}
                className="flex items-start gap-3 rounded-card border border-paper/15 bg-paper/5 p-4"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent text-on-accent">
                  <surface.icon size={20} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block text-body font-bold text-paper">
                    {t(`surfaces.${surface.key}.title`)}
                  </span>
                  <span className="mt-0.5 block text-body-sm text-paper/75">
                    {t(`surfaces.${surface.key}.body`)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <Link
            href="/klubove"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'self-start text-paper hover:bg-paper/10 active:bg-paper/15',
            )}
          >
            {t('directoryCta')}
          </Link>
        </div>
      </div>
    </section>
  );
}
