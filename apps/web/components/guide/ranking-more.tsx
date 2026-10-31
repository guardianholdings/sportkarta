import { Activity, ArrowRight, Crown, Flag, MapPinned } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { buttonVariants } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
import { localizedText } from '@/lib/campaigns';
import { DIVISION_TIERS } from '@sportkarta/lib/divisions';
import { daysRemaining } from '@sportkarta/lib/campaigns';
import type { CampaignRow } from '@sportkarta/db';

import { GuideCard } from './chapter';
import { DivisionLadder } from './division-ladder';

/** The summits the tiers are named for (lib/src/divisions: ordered by height). */
const SUMMIT_METRES: Record<(typeof DIVISION_TIERS)[number], number> = {
  rodopi: 2191,
  vitosha: 2290,
  stara_planina: 2376,
  pirin: 2914,
  rila: 2925,
};

const BOARDS = [
  { key: 'participation', icon: Activity },
  { key: 'contributions', icon: MapPinned },
] as const;

/**
 * «Класиране»: the two boards (/klasirane), the weekly divisions, the master of the
 * court and the campaigns. Rules and counts only — the boards publish names on
 * a NOINDEX page, so this indexed page never lists a row of one.
 */
export async function RankingMore({
  campaign,
  locale,
}: {
  campaign: CampaignRow | null;
  locale: string;
}) {
  const [t, tTier, tHome] = await Promise.all([
    getTranslations('Home.guide.ranking'),
    getTranslations('Division.tier'),
    getTranslations('Home.contribute'),
  ]);
  const d = (key: string) => t(`divisions.${key}`);

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-h3 font-extrabold tracking-tight text-ink">{t('boards.title')}</h3>
      <ul className="grid gap-3 md:grid-cols-2">
        {BOARDS.map(({ key, icon: Icon }) => (
          <li key={key} className="rounded-card border border-line bg-surface p-5 shadow-xs">
            <span className="grid size-10 place-items-center rounded-full bg-accent-subtle text-accent-active">
              <Icon size={19} aria-hidden="true" />
            </span>
            <span className="mt-3 block text-body font-bold text-ink">
              {t(`boards.${key}.title`)}
            </span>
            <span className="mt-1 block text-body-sm text-ink-soft">{t(`boards.${key}.body`)}</span>
          </li>
        ))}
      </ul>
      <p className="-mt-1 text-body-sm text-ink-soft">{t('boards.filters')}</p>

      <DivisionLadder
        tiers={DIVISION_TIERS.map((tier) => ({
          name: tTier(tier),
          peak: t(`divisions.peaks.${tier}`),
          height: t('divisions.height', { height: SUMMIT_METRES[tier] }),
          metres: SUMMIT_METRES[tier],
        }))}
        labels={{
          title: d('title'),
          lead: d('lead'),
          rules: [d('up'), d('stay'), d('down'), d('week'), d('start')],
          order: d('order'),
          ladder: d('ladderLabel'),
          group: d('groupLabel'),
          up: d('upShort'),
          stay: d('stayShort'),
          down: d('downShort'),
        }}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <GuideCard title={t('legend.title')} icon={<Crown size={18} aria-hidden="true" />}>
          <p className="text-body-sm text-ink-soft">{t('legend.body')}</p>
        </GuideCard>
        <GuideCard title={t('campaigns.title')} icon={<Flag size={18} aria-hidden="true" />}>
          <p className="text-body-sm text-ink-soft">{t('campaigns.body')}</p>
          {campaign && (
            <Link
              href={`/kampanii/${campaign.slug}`}
              className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-accent-border bg-accent-subtle px-4 py-3 text-body-sm"
            >
              <span className="min-w-0">
                <span className="block truncate font-bold text-ink">
                  {localizedText(campaign.titleBg, campaign.titleEn, locale)}
                </span>
                <span className="block font-mono text-caption text-accent-active">
                  {tHome('campaignLeft', { count: daysRemaining(campaign.window) })}
                </span>
              </span>
              <ArrowRight size={18} aria-hidden="true" className="shrink-0 text-accent-active" />
            </Link>
          )}
          <Link
            href="/kampanii"
            className="mt-3 inline-flex items-center gap-1 text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {t('campaigns.link')}
            <ArrowRight size={15} aria-hidden="true" />
          </Link>
        </GuideCard>
      </div>

      <div>
        <Link href="/klasirane" className={buttonVariants({ variant: 'primary' })}>
          {t('cta')}
          <ArrowRight size={18} aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
