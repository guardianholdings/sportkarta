import { CLUB_TRIAL_DAYS } from '@sportkarta/lib/clubs';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { AudienceBand } from '@/components/marketing/clubs/audience-band';
import { Audiences } from '@/components/marketing/clubs/audiences';
import { Catalogue } from '@/components/marketing/clubs/catalogue';
import { DaySection } from '@/components/marketing/clubs/day-section';
import { Edges } from '@/components/marketing/clubs/edges';
import { Faq } from '@/components/marketing/clubs/faq';
import { FinalCta } from '@/components/marketing/clubs/final-cta';
import { CLUBS_HERO_ID, LandingHero } from '@/components/marketing/clubs/landing-hero';
import { Pricing } from '@/components/marketing/clubs/pricing';
import { Steps } from '@/components/marketing/clubs/steps';
import { StickyCta } from '@/components/marketing/clubs/sticky-cta';
import { AppShell } from '@/components/shell/app-shell';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { clubSwitchOn } from '@/lib/clubs/features';
import { platformFeeFree } from '@/lib/clubs/landing';
import { dotLayer, gamePulses } from '@/lib/home/dots';
import { orNull } from '@/lib/home/memo';
import { nationalNumbers } from '@/lib/home/sections';
import { buildAlternates, siteSocialMetadata } from '@/lib/seo';

// The «скоро» chips read the env switches at request time (a compose change,
// no rebuild).
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const [t, tOg] = await Promise.all([
    getTranslations({ locale, namespace: 'ClubsLanding' }),
    getTranslations({ locale, namespace: 'Og' }),
  ]);
  return {
    title: t('metaTitle'),
    description: t('metaDescription', { days: CLUB_TRIAL_DAYS }),
    alternates: buildAlternates('/za-klubove', locale),
    ...siteSocialMetadata(
      locale,
      { siteName: tOg('wordmark'), imageAlt: tOg('clubs.imageAlt') },
      { card: 'klubove' },
    ),
  };
}

/**
 * The clubs page (/za-klubove): everything the «Клубове» add-on does, for a
 * gym, studio, club or trainer deciding whether to apply — the complete
 * catalogue, the prices, the steps and the questions, with one call to
 * action throughout. 404 while the add-on is off, like every club route.
 *
 * No loading boundary: the page may 404, and a route that streams a 200
 * before it can call notFound() cannot (tests/route-boundaries.test.ts).
 */
export default async function ClubsLandingPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const [numbers, layer, pulses, t] = await Promise.all([
    orNull('national numbers', nationalNumbers),
    orNull('dot layer', () => dotLayer(null)),
    orNull('game pulses', gamePulses),
    getTranslations('ClubsLanding'),
  ]);
  const feeFree = platformFeeFree();
  const paymentsOn = clubSwitchOn('payments');
  const smsOn = clubSwitchOn('sms');

  return (
    <AppShell active="/za-klubove">
      <main>
        <LandingHero feeFree={feeFree} paymentsOn={paymentsOn} />
        <Audiences />
        <DaySection paymentsOn={paymentsOn} />
        <AudienceBand
          places={layer?.total ?? numbers?.free ?? null}
          numbers={numbers}
          gamesThisWeek={pulses?.total ?? null}
          locale={locale}
        />
        <Catalogue />
        <Edges feeFree={feeFree} paymentsOn={paymentsOn} />
        <Pricing locale={locale} />
        <Steps />
        <Faq paymentsOn={paymentsOn} smsOn={smsOn} />
        <FinalCta />
        <StickyCta watchId={CLUBS_HERO_ID} href="/klubove/zayavka" label={t('cta')} />
      </main>
    </AppShell>
  );
}
