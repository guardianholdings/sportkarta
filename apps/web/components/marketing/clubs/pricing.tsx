import { Check, CircleDashed, Minus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { SectionHead } from '@/components/home/section-head';
import { Reveal } from '@/components/motion/reveal';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { type GridMark, PRICING_INCLUDED, gridMark, rowState } from '@/lib/clubs/landing';
import { cn } from '@/lib/utils';
import {
  CLUB_CONTRACT_MONTHS,
  CLUB_FEATURES,
  CLUB_TIER_PRICE_CENTS,
  CLUB_TIERS,
  CLUB_TRIAL_DAYS,
  COMMUNITY_MEMBER_CAP,
  formatEuro,
} from '@sportkarta/lib/clubs';

/** `Club.feature.*` labels are written for the middle of a sentence; a grid row starts one. */
function sentenceCase(label: string, locale: string): string {
  return label.charAt(0).toLocaleUpperCase(locale === 'en' ? 'en-GB' : 'bg-BG') + label.slice(1);
}

/**
 * One cell of the grid. The included tick is drawn in exactly one place, and
 * only for `gridMark === 'included'` — a «скоро» row prints «скоро» in every
 * tier's cell instead (DR-02), the dash stays for a tier without the feature.
 */
function GridCell({
  mark,
  words,
}: {
  mark: GridMark;
  words: { yes: string; no: string; soon: string };
}) {
  if (mark === 'included') {
    return (
      <td className="px-3 py-2.5 text-center text-brand">
        <Check size={18} aria-hidden="true" className="inline" />
        <span className="sr-only">{words.yes}</span>
      </td>
    );
  }
  if (mark === 'soon') {
    return (
      <td className="px-3 py-2.5 text-center">
        {/* A phone shows the hollow mark alone (the row's own «скоро» chip says
            the word); from `sm` the word stands beside it. */}
        <span className="inline-flex items-center gap-1 text-caption font-medium text-text-muted">
          <CircleDashed size={14} aria-hidden="true" />
          <span className="max-sm:sr-only">{words.soon}</span>
        </span>
      </td>
    );
  }
  return (
    <td className="px-3 py-2.5 text-center text-text-faint">
      <Minus size={18} aria-hidden="true" className="inline" />
      <span className="sr-only">{words.no}</span>
    </td>
  );
}

/**
 * «Цени» — three cards from ONE price table (lib/src/clubs/pricing-public.ts)
 * and a grid whose marks come from the tier matrix itself through gridMark
 * (lib/clubs/landing.ts), so the page cannot promise a tier something the
 * matrix does not give it. A feature behind a switched-off service reads
 * «скоро» here as in the catalogue — in the row's name AND in its cells.
 *
 * The section carries `data-sticky-cta-hide`: the floating «Започнете
 * безплатно» (StickyCta) steps aside for the whole of it (DR-01), so it never
 * covers a card's own button or the «Про» column — and on a phone, where the
 * cards stack, it does not flicker on and off between them.
 */
export async function Pricing({ locale }: { locale: string }) {
  const [t, tClub] = await Promise.all([getTranslations('ClubsLanding'), getTranslations('Club')]);
  const words = { yes: t('pricing.yes'), no: t('pricing.no'), soon: t('catalogue.soon') };
  return (
    <section
      id="ceni"
      aria-labelledby="clubs-pricing"
      className="scroll-mt-16 border-t border-line bg-surface"
      data-sticky-cta-hide
    >
      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <SectionHead
          id="clubs-pricing"
          overline={t('pricing.overline')}
          title={t('pricing.title')}
          lead={t('pricing.lead')}
        />
        <Reveal stagger={0.12}>
          <ul className="mt-8 grid gap-4 lg:grid-cols-3">
            {CLUB_TIERS.map((tier) => {
              const featured = tier === 'standard';
              return (
                <li
                  key={tier}
                  data-reveal
                  className={cn(
                    'flex flex-col gap-4 rounded-card border bg-paper p-6',
                    featured ? 'border-accent-border shadow-md' : 'border-line',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-h3 font-extrabold tracking-tight text-ink">
                      {tClub(`tier.${tier}`)}
                    </h3>
                    {featured && <Badge tone="accent">{t('pricing.popular')}</Badge>}
                  </div>
                  {/* Two lines on desktop, so the three prices sit on one line. */}
                  <p className="text-body-sm text-ink-soft lg:min-h-[2lh]">
                    {t(`pricing.tiers.${tier}.for`)}
                  </p>
                  <p className="flex items-baseline gap-2">
                    <span className="font-mono text-display-lg font-bold tabular-nums leading-none text-ink">
                      {formatEuro(CLUB_TIER_PRICE_CENTS[tier], locale)}
                    </span>
                    <span className="text-body-sm text-text-muted">{t('pricing.perMonth')}</span>
                  </p>
                  <p className="text-body-sm font-medium text-ink-soft">
                    {t('pricing.trialNote', {
                      days: CLUB_TRIAL_DAYS,
                      months: CLUB_CONTRACT_MONTHS,
                    })}
                  </p>
                  {tier === 'community' && (
                    <p className="text-body-sm text-ink-soft">
                      {t('pricing.tiers.community.note', { cap: COMMUNITY_MEMBER_CAP })}
                    </p>
                  )}
                  <Link
                    href="/klubove/zayavka"
                    className={cn(
                      buttonVariants({ variant: featured ? 'accent' : 'secondary' }),
                      'mt-auto',
                    )}
                  >
                    {t('cta')}
                  </Link>
                </li>
              );
            })}
          </ul>
        </Reveal>
        <p className="mt-4 text-caption text-text-muted">
          {t('pricing.vatNote', { days: CLUB_TRIAL_DAYS, months: CLUB_CONTRACT_MONTHS })}
        </p>

        <div
          className="mt-10 overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-labelledby="clubs-pricing"
        >
          <table className="w-full border-collapse text-body-sm">
            <caption className="sr-only">{t('pricing.gridTitle')}</caption>
            <thead>
              <tr className="border-b border-line-strong text-left">
                <th scope="col" className="w-1/2 py-3 pr-4 font-semibold text-ink sm:w-auto">
                  {t('pricing.gridTitle')}
                </th>
                {CLUB_TIERS.map((tier) => (
                  <th
                    key={tier}
                    scope="col"
                    className="px-3 py-3 text-center font-semibold text-ink"
                  >
                    {tClub(`tier.${tier}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {PRICING_INCLUDED.map((row) => (
                <tr key={row.key} className="border-b border-line">
                  <th scope="row" className="py-2.5 pr-4 text-left font-medium text-ink">
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {t(`pricing.included.${row.key}`)}
                      {rowState(row).soon && (
                        <Badge tone="info" variant="soft">
                          {t('catalogue.soon')}
                        </Badge>
                      )}
                    </span>
                  </th>
                  {CLUB_TIERS.map((tier) => (
                    <GridCell key={tier} mark={gridMark(row, tier)} words={words} />
                  ))}
                </tr>
              ))}
              {CLUB_FEATURES.map((feature) => {
                const row = { feature };
                const soon = rowState(row).soon;
                return (
                  <tr key={feature} className="border-b border-line">
                    <th scope="row" className="py-2.5 pr-4 text-left font-medium text-ink">
                      <span className="inline-flex flex-wrap items-center gap-2">
                        {sentenceCase(tClub(`feature.${feature}`), locale)}
                        {soon && (
                          <Badge tone="info" variant="soft">
                            {t('catalogue.soon')}
                          </Badge>
                        )}
                      </span>
                    </th>
                    {CLUB_TIERS.map((tier) => (
                      <GridCell key={tier} mark={gridMark(row, tier)} words={words} />
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
