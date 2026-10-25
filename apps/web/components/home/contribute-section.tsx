import { ArrowRight, BadgeCheck, MapPinPlus, Megaphone, Trophy, UserRound } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { CampaignSponsor } from '@/components/campaigns/campaign-sponsor';
import { Link } from '@/i18n/navigation';
import { localizedText } from '@/lib/campaigns';
import { badgeArt } from '@/lib/design/badge-art';
import type { ContributionPulse } from '@/lib/home/sections';
import type { CampaignRow } from '@sportkarta/db';
import { daysRemaining } from '@sportkarta/lib/campaigns';
import { LAUNCH_BADGES } from '@sportkarta/lib/badges';

import { BadgeCoins, type Coin } from './badge-coins';
import { SectionHead } from './section-head';

function Action({
  href,
  icon,
  title,
  body,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="group flex items-center gap-4 rounded-card border border-line bg-paper p-4 transition-[border-color,box-shadow] duration-150 ease-standard hover:border-brand-border hover:shadow-sm focus-visible:shadow-[var(--ring)]"
      >
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-brand-subtle text-brand">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body font-bold text-ink">{title}</span>
          <span className="mt-0.5 block text-body-sm text-ink-soft">{body}</span>
        </span>
        <ArrowRight
          size={20}
          aria-hidden="true"
          className="shrink-0 text-text-muted transition-transform duration-150 ease-standard group-hover:translate-x-0.5 group-hover:text-brand"
        />
      </Link>
    </li>
  );
}

/**
 * «Картата се прави от хора като вас» — how a visitor becomes a contributor:
 * the three acts that write to the map, the badges they earn, and where the
 * ranking lives. Counts only: the leaderboards publish names on a NOINDEX page,
 * so this indexed page links to them and never lists them (lib/home/sections.ts).
 */
export async function ContributeSection({
  pulse,
  campaign,
  locale,
}: {
  pulse: ContributionPulse | null;
  campaign: CampaignRow | null;
  locale: string;
}) {
  const [t, tBadge] = await Promise.all([
    getTranslations('Home.contribute'),
    getTranslations('Badge'),
  ]);

  const coins: Coin[] = LAUNCH_BADGES.flatMap((badge) => {
    const art = badgeArt(badge.slug);
    return art
      ? [
          {
            slug: badge.slug,
            art,
            name: tBadge(`${badge.slug}.name`),
            description: tBadge(`${badge.slug}.description`),
          },
        ]
      : [];
  });
  const awaiting = pulse?.awaitingVerification ?? 0;

  return (
    <section aria-labelledby="home-contribute" className="border-y border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-x-14 gap-y-12 px-4 py-14 sm:px-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:px-8 lg:py-20">
        <div>
          <SectionHead
            id="home-contribute"
            overline={t('overline')}
            title={t('title')}
            lead={t('lead')}
          />
          <ul className="mt-8 flex flex-col gap-3">
            <Action
              href="/dobavi"
              icon={<MapPinPlus size={22} aria-hidden="true" />}
              title={t('addTitle')}
              body={t('addBody')}
            />
            <Action
              href="/karta"
              icon={<BadgeCheck size={22} aria-hidden="true" />}
              title={t('verifyTitle')}
              body={awaiting > 0 ? t('verifyBody', { count: awaiting }) : t('verifyBodyNone')}
            />
            <Action
              href="/karta"
              icon={<Megaphone size={22} aria-hidden="true" />}
              title={t('reportTitle')}
              body={t('reportBody')}
            />
          </ul>
          <p className="mt-4 text-caption text-text-muted">{t('howTo')}</p>
          {pulse && (
            <p className="mt-6 inline-flex items-center gap-2 rounded-pill bg-brand-subtle px-3.5 py-1.5 font-mono text-caption font-medium tabular-nums text-brand">
              <span aria-hidden="true" className="sk-live-dot" />
              {t('recent', { count: pulse.last30Days })}
            </p>
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-8">
          <div>
            <h3 className="text-h3 font-extrabold tracking-tight text-ink">
              {t('badgesTitle', { count: coins.length })}
            </h3>
            <p className="mt-1 text-body-sm text-ink-soft">{t('badgesHint')}</p>
            <div className="mt-5">
              <BadgeCoins coins={coins} flipLabel={t.raw('flip') as string} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Link
              href="/klasirane"
              className="group flex flex-col gap-2 rounded-card border border-line bg-paper p-5 transition-[border-color,box-shadow] duration-150 ease-standard hover:border-brand-border hover:shadow-sm focus-visible:shadow-[var(--ring)]"
            >
              <Trophy size={22} aria-hidden="true" className="text-accent-active" />
              <span className="text-body font-bold text-ink group-hover:text-brand">
                {t('leaderboardTitle')}
              </span>
              <span className="text-body-sm text-ink-soft">{t('leaderboardBody')}</span>
            </Link>

            {campaign ? (
              <div className="flex flex-col gap-2 rounded-card border border-accent-border bg-accent-subtle p-5">
                <p className="flex items-center justify-between gap-2">
                  <span className="sk-overline">{t('campaign')}</span>
                  <span className="font-mono text-caption font-medium text-accent-active">
                    {t('campaignLeft', { count: daysRemaining(campaign.window) })}
                  </span>
                </p>
                <Link
                  href={`/kampanii/${campaign.slug}`}
                  className="text-body font-bold text-ink hover:text-brand"
                >
                  {localizedText(campaign.titleBg, campaign.titleEn, locale)}
                </Link>
                <CampaignSponsor partnerId={campaign.partnerId} />
                <Link
                  href={`/kampanii/${campaign.slug}`}
                  className="mt-auto inline-flex items-center gap-1 text-body-sm font-semibold text-link hover:text-link-hover"
                >
                  {t('campaignCta')}
                  <ArrowRight size={16} aria-hidden="true" />
                </Link>
              </div>
            ) : (
              <Link
                href="/pasport"
                className="group flex flex-col gap-2 rounded-card border border-line bg-paper p-5 transition-[border-color,box-shadow] duration-150 ease-standard hover:border-brand-border hover:shadow-sm focus-visible:shadow-[var(--ring)]"
              >
                <UserRound size={22} aria-hidden="true" className="text-brand" />
                <span className="text-body font-bold text-ink group-hover:text-brand">
                  {t('passportTitle')}
                </span>
                <span className="text-body-sm text-ink-soft">{t('passportBody')}</span>
              </Link>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
