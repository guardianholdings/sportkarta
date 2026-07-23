import { campaignBySlug, frozenResults, getDb } from '@sportkarta/db';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { FrozenStandings } from '@/components/campaigns/campaign-standings';
import { Link } from '@/i18n/navigation';
import { localizedText } from '@/lib/campaigns';
import { cityDisplayName, loadCityCatalog } from '@/lib/places';

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
    <main className="mx-auto max-w-2xl space-y-8 p-4">
      <header className="space-y-2 border-b border-neutral-200 pb-4">
        <p className="text-xs uppercase tracking-wide text-neutral-500">{t('resultsEyebrow')}</p>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-neutral-500">
          {campaign.window.startsOn} → {campaign.window.endsOn}
        </p>
        {/* Says plainly that these numbers are final, so nobody wonders why
            their score kept rising afterwards and the page did not. */}
        <p className="text-xs text-neutral-500">{t('resultsFrozenNote')}</p>
      </header>

      {prize && (
        <section className="rounded border border-neutral-900 p-4">
          <h2 className="text-sm font-semibold uppercase text-neutral-500">{t('prizeTitle')}</h2>
          <p className="mt-1 text-sm">{prize}</p>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t('finalStandings')}</h2>
        <FrozenStandings
          rows={rows}
          leaderboardType={campaign.leaderboardType}
          cityNames={Object.fromEntries(
            catalog.all.map((city) => [
              city.id,
              cityDisplayName(city.nameBg, city.nameEn, locale),
            ]),
          )}
        />
      </section>

      <p className="text-sm">
        <Link href={`/kampanii/${campaign.slug}`} className="underline">
          {t('backToCampaign')}
        </Link>
      </p>
    </main>
  );
}
