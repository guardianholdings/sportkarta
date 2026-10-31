import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { Suspense } from 'react';

import { Chapter, GUIDE_CHAPTERS } from '@/components/guide/chapter';
import { CheckinProof } from '@/components/guide/checkin-proof';
import { DataLayers, PhotoRules } from '@/components/guide/data-layers';
import { Faq } from '@/components/guide/faq';
import { FindMore } from '@/components/guide/find-more';
import { GuideIntro } from '@/components/guide/guide-intro';
import { GuideNav } from '@/components/guide/guide-nav';
import { Ledger } from '@/components/guide/ledger';
import { MoreGrid } from '@/components/guide/more-grid';
import { OnSite } from '@/components/guide/on-site';
import { PassportMore } from '@/components/guide/passport-more';
import { PlaceLifecycle } from '@/components/guide/place-lifecycle';
import { PlayMore } from '@/components/guide/play-more';
import { RankingMore } from '@/components/guide/ranking-more';
import { Recorded } from '@/components/guide/recorded';
import { ClubsSection } from '@/components/home/clubs-section';
import { ContributeSection } from '@/components/home/contribute-section';
import { GamesSection } from '@/components/home/games-section';
import { Hero, type HeroDots } from '@/components/home/hero';
import { PlaceSearch } from '@/components/home/place-search';
import { PersonalStrip, PersonalStripSkeleton } from '@/components/home/personal-strip';
import { NumbersBand } from '@/components/marketing/numbers-band';
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
import { WINDOW_MS } from '@sportkarta/lib/checkin-token';
import { POINTS_BY_EVENT } from '@sportkarta/lib/points';

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
 * A VISITOR gets the landing and a guide to the whole product: the hero with
 * the dot map, then five chapters — find a place, contribute to the map,
 * play, the passport, the rankings — each one a screen recording made of
 * real phone screens (components/guide/screen-recording.tsx) with its steps
 * written out beside it, and the pictures that explain the rules (points,
 * the life of a new place, whose data wins, the QR check-in, streaks,
 * divisions). Then everything else POPS does, the clubs band, the questions
 * a first visit asks, and the principles.
 *
 * A MEMBER gets «today first»: their strip (next up, streak, badges — and the
 * check-in card while one is open), the search, the week's игри,
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
  const t = await getTranslations('Home.guide');
  const tProof = await getTranslations('Home.guide.play.proof');

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

  const places = dots?.layer.total ?? numbers?.free ?? null;
  const chapter = (key: (typeof GUIDE_CHAPTERS)[number]['key']) => {
    const index = GUIDE_CHAPTERS.findIndex((c) => c.key === key);
    return {
      id: GUIDE_CHAPTERS[index]?.id ?? key,
      number: index + 1,
      overline: t(`${key}.overline`),
      title: t(`${key}.title`),
    };
  };

  return (
    <AppShell active={null}>
      <main>
        <Hero locale={locale} dots={dots} sports={sports ?? []} numbers={numbers} />
        <div id="guide">
          <GuideNav
            label={t('nav.label')}
            guideId="guide"
            items={[
              ...GUIDE_CHAPTERS.map((c) => ({ id: c.id, label: t(`nav.${c.key}`) })),
              { id: 'oshte', label: t('nav.more') },
            ]}
          />
          <GuideIntro />

          <Chapter
            {...chapter('find')}
            lead={places ? t('find.lead', { count: places }) : t('find.leadNoCount')}
          >
            <Recorded keys={['find']} locale={locale}>
              <FindMore />
            </Recorded>
          </Chapter>

          <NumbersBand
            places={places}
            numbers={numbers}
            gamesThisWeek={pulses?.total ?? null}
            contributions={pulse?.last30Days ?? null}
            locale={locale}
          />

          <Chapter {...chapter('contribute')} lead={t('contribute.lead')} raised>
            <Recorded keys={['add', 'verify']} locale={locale}>
              <PlaceLifecycle waiting={pulse?.awaitingVerification ?? null} />
            </Recorded>
            <div className="mt-14 grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
              <OnSite />
              <div className="flex flex-col gap-4">
                <DataLayers />
                <PhotoRules />
              </div>
            </div>
          </Chapter>

          <Chapter {...chapter('play')} lead={t('play.lead')}>
            <Recorded keys={['play']} locale={locale} note={t('play.note')}>
              <CheckinProof
                labels={{
                  title: tProof('title'),
                  rotate: { title: tProof('rotate.title'), body: tProof('rotate.body') },
                  place: { title: tProof('place.title'), body: tProof('place.body') },
                  time: { title: tProof('time.title'), body: tProof('time.body') },
                  result: tProof('result'),
                  without: tProof('without'),
                  ticks: {
                    before: tProof('ticks.before'),
                    start: tProof('ticks.start'),
                    end: tProof('ticks.end'),
                    after: tProof('ticks.after'),
                  },
                  seconds: tProof('seconds', { count: WINDOW_MS / 1000 }),
                  points: t('passport.ledger.points', {
                    count: POINTS_BY_EVENT.session_attended,
                  }),
                }}
              />
            </Recorded>
            <PlayMore games={games ?? []} locale={locale} />
          </Chapter>

          <Chapter {...chapter('passport')} lead={t('passport.lead')} raised>
            <Recorded keys={['passport']} locale={locale} note={t('passport.note')}>
              <Ledger />
            </Recorded>
            <PassportMore signedIn={false} />
          </Chapter>

          <Chapter {...chapter('ranking')} lead={t('ranking.lead')}>
            <RankingMore campaign={campaign} locale={locale} />
          </Chapter>

          <MoreGrid locale={locale} />
        </div>
        {clubs && <ClubsSection />}
        <Faq />
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
