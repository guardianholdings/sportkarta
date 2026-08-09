import { getDb, listCampaigns } from '@sportkarta/db';
import { getTranslations } from 'next-intl/server';

import { renderOgCard, OG_MISSING } from '@/lib/og/card';
import { OG_PALETTE } from '@/lib/og/palette';
import { getFacilityBySlug } from '@/lib/public-data';
import { occurrenceView } from '@/lib/sessions/occurrence';

/**
 * Public link-preview cards (docs/ENGAGEMENT.md C2 — the highest-leverage
 * sharing work, and the reason it is first: Bulgaria shares on Viber and
 * Facebook, so what travels is a pasteable link with a good preview, not an
 * Instagram-shaped image).
 *
 * WHY THE PATH LOOKS LIKE THIS — three separate constraints, each of which
 * fails silently if ignored:
 *
 * 1. NOT UNDER /api/. app/robots.ts disallows `/api/`, and Facebook's and
 *    Viber's scrapers honour robots.txt. A card served from /api/og would be
 *    refused by exactly the crawlers it exists for, presenting as "the preview
 *    is blank on Viber" with nothing in any log.
 * 2. A DOTTED FINAL SEGMENT (`card.png`). middleware.ts matches
 *    `/((?!api|_next|_vercel|.*\..*).*)`, so it skips any path containing a dot
 *    and locale-rewrites everything else. A dotless /og/... would be redirected
 *    by next-intl on every scrape. Same rule the /tiles/*.pmtiles and
 *    /kalendar/*.ics routes already follow.
 * 3. LOCALE AS A ROUTE SEGMENT. Because the dot makes middleware skip this
 *    path, next-intl never resolves a request locale here — every card would
 *    silently render in Bulgarian, including one referenced from an /en page
 *    whose whole metadata block is English. The locale is therefore explicit.
 *
 * PUBLIC CARDS ONLY. Everything here names a place, a session or a campaign —
 * never a person. The default `cache-control: public, immutable, max-age=1y`
 * that ImageResponse sets is therefore correct and wanted. Person-scoped cards
 * (C4/C5) must NOT reuse this route: a one-year immutable cache of a card
 * naming a member is the frozen named artifact migration 0012 forbids, and they
 * need force-dynamic + no-store + X-Robots-Tag instead.
 */

export const runtime = 'nodejs';

const KINDS = ['obekt', 'sesiya', 'kampaniya'] as const;
type Kind = (typeof KINDS)[number];

function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

type Params = Promise<{ locale: string; kind: string; slug: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { locale, kind, slug } = await params;
  if (!isKind(kind)) return new Response('Not found', { status: 404 });
  const lang = locale === 'en' ? 'en' : 'bg';

  const [tOg, tSport] = await Promise.all([
    getTranslations({ locale: lang, namespace: 'Og' }),
    getTranslations({ locale: lang, namespace: 'Sport' }),
  ]);
  const wordmark = tOg('wordmark');
  const attribution = tOg('attribution');

  if (kind === 'obekt') {
    const facility = await getFacilityBySlug(slug);
    if (!facility) return new Response('Not found', { status: 404 });
    const place = facility.municipalityName ?? facility.quarter;
    return renderOgCard({
      // A missing quarter removes the row rather than printing an empty band.
      eyebrow: place,
      title: facility.name ?? tOg('facility.unnamed'),
      subtitle: facility.sportTypes.map((s) => tSport(s)).join(' · ') || null,
      wordmark,
      // Names a mapped place, so the credit is required.
      attribution,
      accent: OG_PALETTE.brand,
    });
  }

  if (kind === 'sesiya') {
    // No viewer: a link-preview card is fetched by a crawler with no session,
    // and it must contain nothing that depends on who is looking.
    const view = await occurrenceView(slug, null);
    if (!view) return new Response('Not found', { status: 404 });
    // THE DAY AND THE HOUR ARE THE MESSAGE. This is the one share with an action
    // attached — "we play Thursday 18:00, come along" — so the time is the
    // largest figure on the card, not a detail in the corner. `startsAtLocal` is
    // already a Sofia wall clock formatted in SQL, so it is split rather than
    // re-derived: turning it back into an instant here would reintroduce exactly
    // the timezone question the SQL formatting exists to settle.
    const [datePart, timePart] = view.startsAtLocal.split('T');
    const day = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : 'bg-BG', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(`${datePart ?? ''}T00:00:00`));
    return renderOgCard({
      eyebrow: day,
      title: view.title,
      // null, not the CTA: the footnote already carries it, and a missing
      // facility must not print the same line twice on one card.
      subtitle: view.facilityName ?? null,
      stats: [{ value: (timePart ?? '').slice(0, 5) || OG_MISSING, label: tOg('session.startsAt') }],
      footnote: tOg('session.cta'),
      wordmark,
      // A session happens at a mapped facility.
      attribution,
      accent: OG_PALETTE.accent,
    });
  }

  // kampaniya
  const campaigns = await listCampaigns(getDb(), { statuses: ['published', 'closed'] });
  const campaign = campaigns.find((c) => c.slug === slug);
  if (!campaign) return new Response('Not found', { status: 404 });
  const title = lang === 'en' ? (campaign.titleEn ?? campaign.titleBg) : campaign.titleBg;
  const blurb = lang === 'en' ? campaign.blurbEn : campaign.blurbBg;
  return renderOgCard({
    eyebrow: tOg('campaign.eyebrow'),
    title: title || OG_MISSING,
    subtitle: blurb ?? null,
    wordmark,
    // No map data on a campaign card, so no attribution line.
    accent: OG_PALETTE.accentDeep,
  });
}
