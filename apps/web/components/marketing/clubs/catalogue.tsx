import { getTranslations } from 'next-intl/server';

import { SectionHead } from '@/components/home/section-head';
import { Reveal } from '@/components/motion/reveal';
import { rowState } from '@/lib/clubs/landing';
import { CLUB_CATALOGUE } from '@sportkarta/lib/clubs';

import { OfficeExplorer, type ExplorerArea } from './office-explorer';
import { SHOTS } from './shots';

/**
 * «Всички функции» — the whole catalogue (lib/src/clubs/catalogue.ts) as
 * the office explorer: every area with its real screen and every function
 * with its title and one line, searchable. A row above the entry tier
 * carries its tier; a row behind a service the operator has not switched on
 * carries «скоро» (lib/clubs/landing.ts) — the page never sells what is not
 * there today. The words are resolved here, on the server; the explorer
 * reads no catalogue of its own.
 */
export async function Catalogue() {
  const [t, tClub] = await Promise.all([getTranslations('ClubsLanding'), getTranslations('Club')]);
  const areas: ExplorerArea[] = CLUB_CATALOGUE.map((area) => ({
    key: area.key,
    title: t(`catalogue.${area.key}.title`),
    lead: t(`catalogue.${area.key}.lead`),
    shot: SHOTS[area.key] ?? null,
    shotAlt: t(`catalogue.${area.key}.shotAlt`),
    rows: area.rows.map((row) => {
      const state = rowState(row);
      return {
        key: row.key,
        title: t(`catalogue.${area.key}.rows.${row.key}.title`),
        body: t(`catalogue.${area.key}.rows.${row.key}.body`),
        tier: state.tier ? tClub(`tier.${state.tier}`) : null,
        soon: state.soon,
      };
    }),
  }));
  const total = areas.reduce((n, area) => n + area.rows.length, 0);

  return (
    <section
      id="funktsii"
      aria-labelledby="clubs-catalogue"
      className="scroll-mt-16 border-t border-line bg-surface"
    >
      <Reveal className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <div data-reveal>
          <SectionHead
            id="clubs-catalogue"
            overline={t('catalogue.overline')}
            title={t('catalogue.title')}
            lead={t('catalogue.lead')}
          />
          <p className="mt-4 text-caption text-text-muted">{t('catalogue.legend')}</p>
        </div>
        <div className="mt-8" data-reveal>
          <OfficeExplorer
            areas={areas}
            labels={{
              areas: t('explorer.areas'),
              searchLabel: t('explorer.searchLabel'),
              searchPlaceholder: t('explorer.searchPlaceholder'),
              noResults: t('explorer.noResults'),
              // Templates the explorer fills on the client, so the raw strings.
              matchesOne: t.raw('explorer.matchesOne') as string,
              matchesOther: t.raw('explorer.matchesOther') as string,
              total: t('explorer.total', { count: total, areas: areas.length }),
              soon: t('catalogue.soon'),
              pause: t('explorer.pause'),
              resume: t('explorer.resume'),
              clear: t('explorer.clear'),
            }}
          />
        </div>
      </Reveal>
    </section>
  );
}
