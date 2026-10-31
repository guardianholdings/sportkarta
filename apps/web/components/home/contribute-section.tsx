import { ArrowRight, BadgeCheck, MapPinPlus, Megaphone } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';

import { CampaignSponsor } from '@/components/campaigns/campaign-sponsor';
import { Reveal } from '@/components/motion/reveal';
import { Link } from '@/i18n/navigation';
import { localizedText } from '@/lib/campaigns';
import type { ContributionPulse } from '@/lib/home/sections';
import type { CampaignRow } from '@sportkarta/db';
import { daysRemaining } from '@sportkarta/lib/campaigns';

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
    <li data-reveal>
      <Link
        href={href}
        className="group flex h-full flex-col gap-3 rounded-card border border-line bg-paper p-5 transition-[border-color,box-shadow] duration-150 ease-standard hover:border-brand-border hover:shadow-sm focus-visible:shadow-[var(--ring)]"
      >
        <span className="grid size-12 shrink-0 place-items-center rounded-full bg-brand-subtle text-brand">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-body font-bold text-ink group-hover:text-brand">{title}</span>
          <span className="mt-0.5 block text-body-sm text-ink-soft">{body}</span>
        </span>
        <ArrowRight
          size={20}
          aria-hidden="true"
          className="shrink-0 self-end text-text-muted transition-transform duration-150 ease-standard group-hover:translate-x-0.5 group-hover:text-brand"
        />
      </Link>
    </li>
  );
}

/**
 * «Картата се прави от хора като вас» — how a visitor becomes a contributor:
 * the three acts that write to the map, the live count of recent ones, and
 * the running campaign if there is one. Counts only, never names: the
 * campaign standings and the boards publish names on NOINDEX pages, so this
 * indexed page links to them (lib/home/sections.ts).
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
  const t = await getTranslations('Home.contribute');
  const awaiting = pulse?.awaitingVerification ?? 0;

  return (
    <section aria-labelledby="home-contribute" className="border-y border-line bg-surface">
      <Reveal className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8 lg:py-20">
        <SectionHead
          id="home-contribute"
          overline={t('overline')}
          title={t('title')}
          lead={t('lead')}
        >
          {pulse && (
            <p className="inline-flex items-center gap-2 rounded-pill bg-brand-subtle px-3.5 py-1.5 font-mono text-caption font-medium tabular-nums text-brand">
              <span aria-hidden="true" className="sk-live-dot" />
              {t('recent', { count: pulse.last30Days })}
            </p>
          )}
        </SectionHead>
        <ul className="mt-8 grid gap-3 sm:grid-cols-3">
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

        {campaign && (
          <div className="mt-8 flex flex-col gap-3 rounded-card border border-accent-border bg-accent-subtle p-5 sm:flex-row sm:items-center sm:gap-6">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="sk-overline">{t('campaign')}</span>
                <span className="font-mono text-caption font-medium text-accent-active">
                  {t('campaignLeft', { count: daysRemaining(campaign.window) })}
                </span>
              </p>
              <Link
                href={`/kampanii/${campaign.slug}`}
                className="mt-1 block text-h4 font-bold text-ink hover:text-brand"
              >
                {localizedText(campaign.titleBg, campaign.titleEn, locale)}
              </Link>
              <CampaignSponsor partnerId={campaign.partnerId} />
            </div>
            <Link
              href={`/kampanii/${campaign.slug}`}
              className="inline-flex shrink-0 items-center gap-1 text-body-sm font-semibold text-link hover:text-link-hover"
            >
              {t('campaignCta')}
              <ArrowRight size={16} aria-hidden="true" />
            </Link>
          </div>
        )}
      </Reveal>
    </section>
  );
}
