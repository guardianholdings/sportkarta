import { ArrowRight } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { Odometer } from '@/components/home/odometer';
import { SectionHead } from '@/components/home/section-head';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import type { NationalStats } from '@/lib/stats-data';
import { cn } from '@/lib/utils';

/**
 * «Живата карта в числа» — the figures the platform already publishes on
 * /statistika (mv_national_stats) and the two pulses the hero computes, as
 * four rolling counters. Nothing here is person-derived: places, municipalities
 * with data, public тренировки in the next seven days, awarded contributions
 * in the last thirty days. A figure that failed to load is left out rather
 * than shown as zero.
 */
export async function NumbersBand({
  places,
  numbers,
  gamesThisWeek,
  contributions,
  locale,
}: {
  /** The free places the hero counts (the dot map's figure), so one number is told once. */
  places: number | null;
  numbers: NationalStats | null;
  gamesThisWeek: number | null;
  contributions: number | null;
  locale: string;
}) {
  const t = await getTranslations('Home.numbers');
  const figures: { key: string; value: number }[] = [];
  if (places !== null) figures.push({ key: 'places', value: places });
  if (numbers) figures.push({ key: 'municipalities', value: numbers.municipalitiesCovered });
  if (gamesThisWeek !== null) figures.push({ key: 'games', value: gamesThisWeek });
  if (contributions !== null) figures.push({ key: 'contributions', value: contributions });
  if (figures.length === 0) return null;

  return (
    <section aria-labelledby="home-numbers" className="bg-ink text-paper">
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-16">
        <SectionHead
          id="home-numbers"
          overline={t('overline')}
          title={t('title')}
          lead={t('lead')}
          tone="dark"
        >
          <div className="flex flex-wrap gap-2">
            <Link
              href="/statistika"
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'sm' }),
                'text-paper hover:bg-paper/10 active:bg-paper/15',
              )}
            >
              {t('stats')}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
            <Link
              href="/danni"
              className={cn(
                buttonVariants({ variant: 'ghost', size: 'sm' }),
                'text-paper hover:bg-paper/10 active:bg-paper/15',
              )}
            >
              {t('openData')}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        </SectionHead>
        {/* dt before dd, as the dl content model asks; the CSS order flips the visual. */}
        <dl className="mt-10 grid grid-cols-2 gap-x-6 gap-y-8 lg:grid-cols-4">
          {figures.map((figure) => (
            <div key={figure.key} className="flex flex-col gap-1">
              <dt className="order-2 text-body-sm text-paper/75">{t(figure.key)}</dt>
              <dd className="order-1 font-mono text-display-lg font-bold tabular-nums leading-none text-paper">
                <Odometer value={figure.value} locale={locale} />
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
