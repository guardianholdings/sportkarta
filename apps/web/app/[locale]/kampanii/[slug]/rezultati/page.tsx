import { campaignBySlug, frozenResults, getDb } from '@sportkarta/db';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { CampaignSponsor } from '@/components/campaigns/campaign-sponsor';
import { FrozenStandings } from '@/components/campaigns/campaign-standings';
import { Link } from '@/i18n/navigation';
import { localizedText } from '@/lib/campaigns';
import { cityDisplayName, loadCityCatalog } from '@/lib/places';
import { AppShell } from '@/components/shell/app-shell';
import { campaignWindowLabel } from '@/lib/campaign-window';

/**
 * The shareable close-out results page (docs/ROADMAP.md §7, Stage 5.3).
 *
 * THIS PAGE READS THE FROZEN SNAPSHOT AND NEVER RECOMPUTES. That is the whole
 * reason campaign_results exists: a results page built on a live query changes
 * after prizes are announced — a late moderation reversal, an erasure, a
 * corrected ledger row — and a winner who changes after the fact is the worst
 * failure this feature can have.
 *
 * Only a CLOSED campaign has a results page. Before that there is nothing
 * official to publish, so the URL 404s rather than showing provisional numbers
 * somebody might screenshot and circulate.
 *
 * Shareable ≠ indexed. OpenGraph tags are set so a link pasted into Facebook or
 * Viber previews properly — which is how a Bulgarian NGO campaign actually
 * spreads — while robots keeps the named members out of search results,
 * consistent with their passports being noindex.
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, slug } = await params;
  const campaign = await campaignBySlug(getDb(), slug);
  if (!campaign || campaign.status !== 'closed') {
    return { robots: { index: false, follow: false } };
  }
  const t = await getTranslations({ locale, namespace: 'Campaign' });
  const name = localizedText(campaign.titleBg, campaign.titleEn, locale) ?? campaign.slug;
  const title = t('resultsMetaTitle', { campaign: name });
  return {
    title,
    openGraph: { title, type: 'article' },
    robots: { index: false, follow: false },
  };
}

export default async function CampaignResultsPage({ params }: { params: PageParams }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Campaign');

  const campaign = await campaignBySlug(getDb(), slug);
  if (!campaign || campaign.status !== 'closed') notFound();

  const [rows, catalog] = await Promise.all([
    frozenResults(getDb(), campaign.id, 100),
    loadCityCatalog(),
  ]);

  const title = localizedText(campaign.titleBg, campaign.titleEn, locale) ?? campaign.slug;
  const prize = localizedText(campaign.prizeBg, campaign.prizeEn, locale);

  return (
    <AppShell>
      <main className="mx-auto max-w-2xl space-y-8 p-4">
      <header className="space-y-2 border-b border-line pb-4">
        <p className="text-caption uppercase tracking-wide text-text-muted">{t('resultsEyebrow')}</p>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{title}</h1>
        <p className="text-body-sm text-text-muted">
          {campaignWindowLabel(locale, campaign.window)}
        </p>
        {/* Says plainly that these numbers are final, so nobody wonders why
            their score kept rising afterwards and the page did not. */}
        <p className="text-caption text-text-muted">{t('resultsFrozenNote')}</p>
      </header>

      {prize && (
        <section className="rounded-card border border-brand-border bg-brand-subtle p-4">
          <h2 className="text-body-sm font-semibold uppercase text-text-muted">{t('prizeTitle')}</h2>
          <p className="mt-1 text-body-sm">{prize}</p>
        </section>
      )}

      {/* The sponsor line (MONETISATION S2) sits beside the prize because that
          is the deal: the sponsor provides the prize and is acknowledged for it.
          Renders nothing for an unsponsored campaign or a lapsed sponsor. */}
      <CampaignSponsor partnerId={campaign.partnerId} />

      <section className="space-y-3">
        <h2 className="text-h4 font-bold text-ink">{t('finalStandings')}</h2>
        <FrozenStandings
          rows={rows}
          leaderboardType={campaign.leaderboardType}
          cityNames={Object.fromEntries(
            catalog.all.map((city) => [city.id, cityDisplayName(city.nameBg, city.nameEn, locale)]),
          )}
        />
      </section>

      <p className="text-body-sm">
        <Link href={`/kampanii/${campaign.slug}`} className="font-medium text-link hover:text-link-hover">
          {t('backToCampaign')}
        </Link>
      </p>
      </main>
    </AppShell>
  );
}
