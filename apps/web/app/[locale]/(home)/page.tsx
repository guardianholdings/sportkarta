import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Suspense } from 'react';

import { ClubsSection } from '@/components/home/clubs-section';
import { ContributeSection } from '@/components/home/contribute-section';
import { GamesSection } from '@/components/home/games-section';
import { Hero, type HeroDots } from '@/components/home/hero';
import { PlaceSearch } from '@/components/home/place-search';
import { PersonalStrip, PersonalStripSkeleton } from '@/components/home/personal-strip';
import { HowItWorks } from '@/components/marketing/how-it-works';
import { NumbersBand } from '@/components/marketing/numbers-band';
import { PassportSection } from '@/components/marketing/passport-section';
import { PrinciplesBand } from '@/components/marketing/principles-band';
import { AppShell } from '@/components/shell/app-shell';
import { type CurrentUser, getCurrentUser } from '@/lib/auth-session';
import { clubsEnabled } from '@/lib/clubs/access';
import { dotLayer, dotMask, gamePulses } from '@/lib/home/dots';
import { orNull } from '@/lib/home/memo';
import { dotPlaces, topPlaces } from '@/lib/home/places';
import {
  contributionPulse,
  heroSports,
  nationalNumbers,
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
 * The front page (/) — what POPS is, made of its own live data; and for a
 * signed-in member, their own day (operator decision 2026-10-31, UX audit N4).
 *
 * A VISITOR gets the landing: the hero with the dot map, how it works, the
 * week's тренировки, the numbers, contributing, the passport, the clubs band
 * and the principles.
 *
 * A MEMBER gets «today first»: their strip (next up, streak, badges — and the
 * check-in card while one is open), the search, the week's тренировки,
 * contributing, and the principles as the trust block. The pitch sections are
 * a visitor's; a member was scrolling past them to reach anything of theirs.
 * Their aggregates are not even loaded for a member.
 *
 * Until it existed the map WAS "/": a link carrying a map parameter never
 * reaches this page — middleware.ts sends it to /karta with a 308. Every
 * section is optional — a failed aggregate leaves its section out instead of
 * failing the page (`orNull`).
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  const user = await orNull('user', getCurrentUser);
  if (user) return <MemberHome user={user} locale={locale} />;

  const [mask, layer, pulses, sports, games, pulse, campaign, numbers] = await Promise.all([
    orNull('dot mask', dotMask),
    orNull('dot layer', () => dotLayer(null)),
    orNull('game pulses', gamePulses),
    orNull('hero sports', () => heroSports()),
    orNull('games', upcomingGames),
    orNull('contributions', contributionPulse),
    orNull('campaign', runningCampaign),
    orNull('national numbers', nationalNumbers),
  ]);
  const clubs = clubsEnabled();

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
    <AppShell active={null}>
      <main>
        <Hero locale={locale} dots={dots} sports={sports ?? []} numbers={numbers} />
        <HowItWorks />
        <GamesSection games={games ?? []} locale={locale} />
        <NumbersBand
          places={dots?.layer.total ?? numbers?.free ?? null}
          numbers={numbers}
          gamesThisWeek={pulses?.total ?? null}
          contributions={pulse?.last30Days ?? null}
          locale={locale}
        />
        <ContributeSection pulse={pulse} campaign={campaign} locale={locale} />
        <PassportSection signedIn={false} />
        {clubs && <ClubsSection />}
        <PrinciplesBand signedIn={false} />
      </main>
    </AppShell>
  );
}

/** The signed-in member's home: their day first, then the week and the map. */
async function MemberHome({ user, locale }: { user: CurrentUser; locale: string }) {
  const [t, games, pulse, campaign] = await Promise.all([
    getTranslations('Home'),
    orNull('games', upcomingGames),
    orNull('contributions', contributionPulse),
    orNull('campaign', runningCampaign),
  ]);

  return (
    <AppShell active={null}>
      <main>
        {/* A fixed heading: the greeting streams in behind a skeleton and may
            fail, and the page must have its h1 either way. */}
        <h1 className="sr-only">{t('personal.label')}</h1>
        <Suspense fallback={<PersonalStripSkeleton />}>
          <PersonalStrip user={user} locale={locale} />
        </Suspense>
        <section
          aria-label={t('hero.searchLabel')}
          className="mx-auto max-w-6xl px-4 pt-6 sm:px-6 lg:px-8"
        >
          <PlaceSearch locale={locale} />
        </section>
        <GamesSection games={games ?? []} locale={locale} />
        <ContributeSection pulse={pulse} campaign={campaign} locale={locale} />
        <PrinciplesBand signedIn />
      </main>
    </AppShell>
  );
}
