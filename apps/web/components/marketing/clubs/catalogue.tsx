import { getTranslations } from 'next-intl/server';

import { SectionHead } from '@/components/home/section-head';
import { Badge } from '@/components/ui/badge';
import { rowState } from '@/lib/clubs/landing';
import { cn } from '@/lib/utils';
import { CLUB_CATALOGUE } from '@sportkarta/lib/clubs';

import { DeviceFrame } from './device-frame';
import { SHOTS } from './shots';

/**
 * «Всички функции» — the whole catalogue (lib/src/clubs/catalogue.ts), area
 * by area, every row with its title and one line. A row above the free tier
 * carries its tier; a row behind a service the operator has not switched on
 * carries «скоро» (lib/clubs/landing.ts) — the page never sells what is not
 * there today. A jump list at the top takes an owner straight to an area.
 */
export async function Catalogue() {
  const [t, tClub] = await Promise.all([getTranslations('ClubsLanding'), getTranslations('Club')]);
  return (
    <section
      id="funktsii"
      aria-labelledby="clubs-catalogue"
      className="scroll-mt-16 border-t border-line bg-surface"
    >
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <SectionHead
          id="clubs-catalogue"
          overline={t('catalogue.overline')}
          title={t('catalogue.title')}
          lead={t('catalogue.lead')}
        />
        <nav aria-label={t('catalogue.jumpLabel')} className="mt-6 flex flex-wrap gap-2">
          {CLUB_CATALOGUE.map((area) => (
            <a
              key={area.key}
              href={`#f-${area.key}`}
              className="inline-flex min-h-9 items-center rounded-pill border border-line bg-paper px-3 text-body-sm font-medium text-ink-soft hover:border-brand-border hover:text-brand"
            >
              {t(`catalogue.${area.key}.title`)}
            </a>
          ))}
        </nav>
        <p className="mt-4 text-caption text-text-muted">{t('catalogue.legend')}</p>

        <div className="mt-10 flex flex-col gap-10">
          {CLUB_CATALOGUE.map((area) => {
            const shot = SHOTS[area.key];
            return (
              <article
                key={area.key}
                id={`f-${area.key}`}
                aria-labelledby={`f-${area.key}-title`}
                className="scroll-mt-16 rounded-card border border-line bg-paper p-5 sm:p-7"
              >
                <div
                  className={cn(
                    'grid gap-x-10 gap-y-6',
                    shot && 'lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]',
                  )}
                >
                  <div className="min-w-0">
                    <h3
                      id={`f-${area.key}-title`}
                      className="text-h3 font-extrabold tracking-tight text-ink"
                    >
                      {t(`catalogue.${area.key}.title`)}
                    </h3>
                    <p className="mt-1 text-body-sm text-ink-soft">
                      {t(`catalogue.${area.key}.lead`)}
                    </p>
                    <ul
                      className={cn(
                        'mt-5 grid gap-x-6 gap-y-4 sm:grid-cols-2',
                        !shot && 'lg:grid-cols-3',
                      )}
                    >
                      {area.rows.map((row) => {
                        const state = rowState(row);
                        return (
                          <li key={row.key} className="min-w-0">
                            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm font-bold text-ink">
                              {t(`catalogue.${area.key}.rows.${row.key}.title`)}
                              {state.tier && (
                                <Badge tone="brand" variant="outline">
                                  {tClub(`tier.${state.tier}`)}
                                </Badge>
                              )}
                              {state.soon && (
                                <Badge tone="info" variant="soft">
                                  {t('catalogue.soon')}
                                </Badge>
                              )}
                            </p>
                            <p className="mt-0.5 text-body-sm text-ink-soft">
                              {t(`catalogue.${area.key}.rows.${row.key}.body`)}
                            </p>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                  {shot && (
                    <DeviceFrame
                      shot={shot}
                      alt={t(`catalogue.${area.key}.shotAlt`)}
                      className="self-start"
                    />
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
