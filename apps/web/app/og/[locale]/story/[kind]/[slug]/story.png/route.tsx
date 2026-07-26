import { getDb, listCampaigns, facilityLegend, LEGEND_WINDOW_DAYS } from '@sportkarta/db';
import { getTranslations } from 'next-intl/server';

import { OG_PALETTE } from '@/lib/og/palette';
import { renderStoryCard } from '@/lib/og/story';
import { getFacilityBySlug } from '@/lib/public-data';
import { occurrenceView } from '@/lib/sessions/occurrence';

/**
 * PUBLIC story images — 1080×1920, for a place, a session or a campaign.
 *
 * The three path constraints the sibling card route documents apply unchanged
 * and each fails silently if broken: not under `/api/` (robots.txt disallows it
 * and the scrapers honour that), a DOTTED final segment (`story.png`, so
 * middleware skips the locale rewrite), and the locale as a route SEGMENT
 * (because that dot means next-intl never resolves a request locale, so every
 * story would otherwise render in Bulgarian).
 *
 * PUBLIC AND CACHEABLE, deliberately. Nothing here names a person — a facility,
 * a session and a campaign are all already-public subjects, so `ImageResponse`'s
 * default year-long immutable cache is correct and wanted. The moment a story
 * names a member it belongs on `/og/lichen/…` instead, which is session-gated
 * and `no-store`.
 *
 * THE LEGEND STORY NAMES NOBODY. It prints the number of days the most regular
 * person has come, exactly as the facility page does — operator decision 1 of
 * 2026-07-26. That is a fact about the PLACE, and it is also the invitation.
 */

export const runtime = 'nodejs';

const KINDS = ['facility', 'session', 'campaign', 'legend'] as const;
type Kind = (typeof KINDS)[number];

function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

type Params = Promise<{ locale: string; kind: string; slug: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { locale, kind, slug } = await params;
  if (!isKind(kind)) return new Response('Not found', { status: 404 });
  const lang = locale === 'en' ? 'en' : 'bg';

  const [tOg, tStory, tSport] = await Promise.all([
    getTranslations({ locale: lang, namespace: 'Og' }),
    getTranslations({ locale: lang, namespace: 'Story' }),
    getTranslations({ locale: lang, namespace: 'Sport' }),
  ]);
  const wordmark = tOg('wordmark');
  const attribution = tOg('attribution');
  const callToAction = tStory('callToAction');

  if (kind === 'facility' || kind === 'legend') {
    const facility = await getFacilityBySlug(slug);
    if (!facility) return new Response('Not found', { status: 404 });
    const name = facility.name ?? tOg('facility.unnamed');
    const sports = facility.sportTypes.map((s) => tSport(s)).join(' · ') || null;

    if (kind === 'legend') {
      const legend = await facilityLegend(getDb(), facility.id);
      // No holder yet, or below the floor — no story rather than an empty one.
      if (!legend) return new Response('Not found', { status: 404 });
      return renderStoryCard({
        eyebrow: tStory('legend.eyebrow'),
        hero: String(legend.days),
        heroLabel: tStory('legend.heroLabel'),
        title: tStory('legend.title', { place: name }),
        subtitle: tStory('legend.window', { days: LEGEND_WINDOW_DAYS }),
        wordmark,
        callToAction,
        attribution,
        accent: OG_PALETTE.accent,
      });
    }

    // TITLE-LED, no hero. A facility's only available number is how many sports
    // it lists, and a 260px "1" is a giant numeral saying nothing. The place
    // NAME is what makes somebody recognise it and go, so it takes the big type.
    return renderStoryCard({
      eyebrow: facility.municipalityName ?? facility.quarter,
      title: name,
      subtitle: sports,
      wordmark,
      callToAction,
      attribution,
      accent: OG_PALETTE.brand,
    });
  }

  if (kind === 'session') {
    // No viewer: a public story must contain nothing that depends on who looks.
    const view = await occurrenceView(slug, null);
    if (!view) return new Response('Not found', { status: 404 });
    // THE HOUR IS THE HERO. This is the one share with an action attached —
    // "we play Thursday 18:00, come" — so the time is the biggest thing on the
    // screen. `startsAtLocal` is already a Sofia wall clock formatted in SQL, so
    // it is SPLIT rather than re-derived: turning it back into an instant here
    // would reintroduce exactly the timezone question that formatting settled.
    const [datePart, timePart] = view.startsAtLocal.split('T');
    const day = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'bg-BG', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(`${datePart ?? ''}T00:00:00`));
    return renderStoryCard({
      eyebrow: day,
      hero: (timePart ?? '').slice(0, 5) || '—',
      heroLabel: tStory('session.heroLabel'),
      title: view.title,
      subtitle: view.facilityName,
      wordmark,
      callToAction: tStory('session.callToAction'),
      // A session happens at a mapped facility.
      attribution,
      accent: OG_PALETTE.accent,
    });
  }

  const campaigns = await listCampaigns(getDb(), { statuses: ['published', 'closed'] });
  const campaign = campaigns.find((c) => c.slug === slug);
  if (!campaign) return new Response('Not found', { status: 404 });
  const title = lang === 'en' ? (campaign.titleEn ?? campaign.titleBg) : campaign.titleBg;
  const blurb = lang === 'en' ? campaign.blurbEn : campaign.blurbBg;
  return renderStoryCard({
    eyebrow: tStory('campaign.eyebrow'),
    // A campaign's hero is its NAME rather than a number: there is no single
    // figure that means anything before somebody has joined, and an invented one
    // would be the Wrapped-2024 failure.
    // Title-led for the same reason: no figure means anything before anyone has
    // joined, and an invented one would be the Wrapped-2024 failure.
    title: title || '—',
    subtitle: blurb ?? null,
    wordmark,
    callToAction,
    // No map data on a campaign story, so no attribution line.
    accent: OG_PALETTE.accentDeep,
  });
}
