import type { Metadata } from 'next';
import { setRequestLocale } from 'next-intl/server';
import { Suspense } from 'react';

import { ClubsSection } from '@/components/home/clubs-section';
import { ContributeSection } from '@/components/home/contribute-section';
import { GamesSection } from '@/components/home/games-section';
import { Hero, type HeroDots } from '@/components/home/hero';
import { MarketingHeader } from '@/components/marketing/marketing-header';
import { PersonalStrip, PersonalStripSkeleton } from '@/components/home/personal-strip';
import { AppShell } from '@/components/shell/app-shell';
import { getCurrentUser } from '@/lib/auth-session';
import { clubsEnabled } from '@/lib/clubs/access';
import { dotLayer, dotMask, gamePulses } from '@/lib/home/dots';
import { orNull } from '@/lib/home/memo';
import { dotPlaces, topPlaces } from '@/lib/home/places';
import {
  clubTeaser,
  contributionPulse,
  heroSports,
  runningCampaign,
  upcomingGames,
} from '@/lib/home/sections';
import { buildAlternates } from '@/lib/seo';

// It greets a signed-in member, so it renders per request; everything else on
// it is memoised per process (lib/home/memo.ts).
export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  // No title of its own: the front page carries the site's default title and
  // description from the locale layout, the template is for every other page.
  return { alternates: buildAlternates('/', locale) };
}

/**
 * The front page (/) — what POPS is, made of its own live data.
 *
 * Until it existed the map WAS "/": a link carrying a map parameter never
 * reaches this page — middleware.ts sends it to /karta with a 308. Every
 * section is optional — a failed aggregate leaves its section out instead of
 * failing the page (`orNull`).
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const [user, mask, layer, pulses, sports, games, pulse, campaign, clubs] = await Promise.all([
    orNull('user', getCurrentUser),
    orNull('dot mask', dotMask),
    orNull('dot layer', () => dotLayer(null)),
    orNull('game pulses', gamePulses),
    orNull('hero sports', () => heroSports()),
    orNull('games', upcomingGames),
    orNull('contributions', contributionPulse),
    orNull('campaign', runningCampaign),
    orNull('clubs', () => clubTeaser(locale)),
  ]);

  let dots: HeroDots | null = null;
  if (mask && layer) {
    const named = await orNull('dot places', () =>
      Promise.all([dotPlaces(layer, locale), topPlaces(layer, locale)]),
    );
    if (named) {
      const [places, top] = named;
      dots = { mask, layer, pulses: pulses ?? { total: 0, cells: [] }, places, top };
    }
  }

  return (
    <AppShell
      active={null}
      topbar={<MarketingHeader signedIn={user !== null} clubs={clubsEnabled()} />}
    >
      <main>
        {user && (
          <Suspense fallback={<PersonalStripSkeleton />}>
            <PersonalStrip user={user} locale={locale} />
          </Suspense>
        )}
        <Hero locale={locale} dots={dots} sports={sports ?? []} />
        <GamesSection games={games ?? []} locale={locale} />
        <ContributeSection pulse={pulse} campaign={campaign} locale={locale} />
        {clubs && <ClubsSection teaser={clubs} locale={locale} />}
      </main>
    </AppShell>
  );
}
