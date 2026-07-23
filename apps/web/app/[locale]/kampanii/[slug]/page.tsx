import { campaignBySlug, campaignStanding, getDb, publicStandings } from '@sportkarta/db';
import { campaignPhase, daysRemaining } from '@sportkarta/lib/campaigns';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { CampaignStandings } from '@/components/campaigns/campaign-standings';
import { Link } from '@/i18n/navigation';
import { getCurrentUser } from '@/lib/auth-session';
import { localizedText } from '@/lib/campaigns';
import { cityDisplayName, loadCityCatalog } from '@/lib/places';

/**
 * A campaign's landing page (docs/ROADMAP.md §7, Stage 5.3).
 *
 * WHILE RUNNING this shows LIVE standings — that is the point of a campaign,
 * and the numbers are expected to move. Once closed, the standings a visitor
 * sees come from the frozen snapshot on /rezultati, not from re-running the
 * query, because a published winner must not change afterwards.
 *
 * A draft or cancelled campaign is a 404: not "hidden", not "coming soon",
 * simply absent, so a leaked slug reveals nothing about what is being planned.
 *
 * noindex, like the passports and leaderboard it links to. The page names
 * members who opted their passport public; indexing it would publish those
 * names against a search query, which is a different decision from "anyone I
 * send the link to".
 */
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, slug } = await params;
  const campaign = await campaignBySlug(getDb(), slug);
  if (!campaign || campaign.status === 'draft' || campaign.status === 'cancelled') {
    return { robots: { index: false, follow: false } };
  }
  const title = localizedText(campaign.titleBg, campaign.titleEn, locale) ?? campaign.slug;
  const description = localizedText(campaign.blurbBg, campaign.blurbEn, locale) ?? undefined;
  return {
    title,
    ...(description ? { description } : {}),
    // Shareable, not indexed: OpenGraph so a pasted link previews properly in
    // Facebook and Viber, which is how a Bulgarian NGO campaign actually
    // spreads — while robots keeps it out of search results.
    openGraph: { title, ...(description ? { description } : {}), type: 'website' },
    robots: { index: false, follow: false },
  };
}

export default async function CampaignPage({ params }: { params: PageParams }) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('Campaign');

  const campaign = await campaignBySlug(getDb(), slug);
  if (!campaign || campaign.status === 'draft' || campaign.status === 'cancelled') notFound();

  const now = new Date();
  const phase = campaignPhase(campaign.status, campaign.window, now);
  const user = await getCurrentUser();

  const [standings, catalog, standing] = await Promise.all([
    campaign.status === 'closed'
      ? Promise.resolve([])
      : publicStandings(getDb(), campaign, { limit: 25 }),
    loadCityCatalog(),
    user ? campaignStanding(getDb(), campaign, user.id) : Promise.resolve(null),
  ]);

  const title = localizedText(campaign.titleBg, campaign.titleEn, locale) ?? campaign.slug;
  const blurb = localizedText(campaign.blurbBg, campaign.blurbEn, locale);
  const prize = localizedText(campaign.prizeBg, campaign.prizeEn, locale);

  // The template picks the emphasis, not the data: `sprint` leads with the
  // countdown because it is short, `city_race` leads with the prize because the
  // competition is between towns rather than people.
  const leadWithCountdown = campaign.template === 'sprint';

  return (
    <main className="mx-auto max-w-2xl space-y-8 p-4">
      <header className="space-y-3 border-b border-neutral-200 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">{t(`phase_${phase}`)}</span>
          {phase === 'running' && leadWithCountdown && (
            <span className="rounded bg-neutral-900 px-2 py-0.5 text-xs text-white">
              {t('daysLeft', { count: daysRemaining(campaign.window, now) })}
            </span>
          )}
        </div>
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-sm text-neutral-500">
          {campaign.window.startsOn} → {campaign.window.endsOn}
          {phase === 'running' && !leadWithCountdown &&
            ` · ${t('daysLeft', { count: daysRemaining(campaign.window, now) })}`}
        </p>
        {blurb && <p className="text-sm">{blurb}</p>}
      </header>

      {prize && (
        <section className="rounded border border-neutral-900 p-4">
          <h2 className="text-sm font-semibold uppercase text-neutral-500">{t('prizeTitle')}</h2>
          <p className="mt-1 text-sm">{prize}</p>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t('howToScore')}</h2>
        <ul className="space-y-1 text-sm">
          {campaign.rules.events.map((event) => (
            <li key={event.kind} className="flex gap-3">
              <span>{t(`event_${event.kind}`)}</span>
              <span className="ml-auto font-medium tabular-nums">
                {t('weightValue', { weight: event.weight })}
              </span>
            </li>
          ))}
        </ul>
        {campaign.rules.perDayCap !== undefined && (
          <p className="text-xs text-neutral-500">
            {t('capNote', { cap: campaign.rules.perDayCap })}
          </p>
        )}
        <p className="text-xs text-neutral-500">{t(`scopeNote_${campaign.scope.kind}`)}</p>
      </section>

      {campaign.status === 'closed' ? (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t('finishedTitle')}</h2>
          <p className="text-sm text-neutral-600">{t('finishedBody')}</p>
          <Link
            href={`/kampanii/${campaign.slug}/rezultati`}
            className="inline-block rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
          >
            {t('seeResults')}
          </Link>
        </section>
      ) : phase === 'awaiting_close' ? (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">{t('awaitingTitle')}</h2>
          {/* Honest rather than reassuring: the window has closed, and the
              numbers below are the last live ones, not the official result. */}
          <p className="text-sm text-neutral-600">{t('awaitingBody')}</p>
        </section>
      ) : null}

      {campaign.status !== 'closed' && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">
            {campaign.leaderboardType === 'city' ? t('cityStandings') : t('standings')}
          </h2>
          <CampaignStandings
            rows={standings}
            leaderboardType={campaign.leaderboardType}
            cityNames={Object.fromEntries(
              catalog.all.map((city) => [
                city.id,
                cityDisplayName(city.nameBg, city.nameEn, locale),
              ]),
            )}
          />
          {campaign.leaderboardType === 'individual' && (
            <p className="text-xs text-neutral-500">{t('eligibilityNote')}</p>
          )}
        </section>
      )}

      {user && (
        <section className="space-y-1 rounded border border-neutral-200 p-4 text-sm">
          <h2 className="font-semibold">{t('yourStandingTitle')}</h2>
          {standing ? (
            <p className="text-neutral-600">
              {t('yourStanding', { rank: standing.rank, score: standing.score })}
            </p>
          ) : (
            <p className="text-neutral-600">{t('yourStandingNone')}</p>
          )}
        </section>
      )}
    </main>
  );
}
