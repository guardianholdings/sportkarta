import { getDb } from '@sportkarta/db';
import { getTranslations } from 'next-intl/server';

import { publicPassport } from '@/lib/passport';
import { renderOgCard } from '@/lib/og/card';
import { OG_PALETTE } from '@/lib/og/palette';
import { toPassportShare } from '@/lib/share/passport-payload';

/**
 * The PERSON-SCOPED card (docs/ENGAGEMENT.md C4).
 *
 * Separate from `/og/[locale]/[kind]/…` on purpose, and the separation is the
 * feature. `lichen` = "личен", personal.
 *
 * THREE THINGS THIS ROUTE DOES THAT THE PUBLIC ONE MUST NOT, AND VICE VERSA:
 *
 * 1. `dynamic = 'force-dynamic'` + `Cache-Control: private, no-store`.
 *    ImageResponse defaults to `public, immutable, max-age=31536000`. On a card
 *    carrying a member's NAME that is functionally the frozen named artifact
 *    migration 0012 forbids — a member who erases their account or makes their
 *    passport private cannot revoke a copy a CDN promised to keep for a year.
 *    force-dynamic additionally keeps it out of Next's ISR cache on disk, so the
 *    image is never written down anywhere. It is generated on demand from live
 *    data, every time, exactly as §3 requires.
 *
 * 2. `X-Robots-Tag: noindex`. `/pasport/[handle]` is deliberately noindex —
 *    "public means anyone I send the link to, not indexed against your name
 *    forever". But an OG image is a SEPARATE URL that carries none of the page's
 *    metadata, so without this header the card would be a freshly INDEXABLE URL
 *    whose pixels contain a member's name, quietly undoing that decision.
 *    It must be a HEADER and never a robots.txt Disallow: Facebook's and Viber's
 *    scrapers honour robots.txt, so a Disallow would kill the preview this card
 *    exists to create while doing nothing about indexing the page it is on.
 *
 * 3. It reads through `publicPassport`, which resolves the handle through
 *    `publicPassportOwner`'s visibility predicate. A member who has not opted in
 *    has no public passport, so this 404s — the consent check is the same one
 *    the page makes, in SQL, and there is no second code path here to get wrong.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Never cached, never stored, never indexed. */
const PERSON_SCOPED_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'X-Robots-Tag': 'noindex, noimageindex, noarchive',
} as const;

type Params = Promise<{ locale: string; handle: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { locale, handle } = await params;
  const lang = locale === 'en' ? 'en' : 'bg';

  const passport = await publicPassport(getDb(), handle);
  // Not public, or no such handle — indistinguishable on purpose.
  if (!passport) return new Response('Not found', { status: 404, headers: PERSON_SCOPED_HEADERS });

  // The narrowed payload, not the public passport: a share travels further than
  // a page and outlives the decision to publish. Its keys are pinned by
  // tests/passport-share-privacy.test.ts.
  const share = toPassportShare(passport);
  const t = await getTranslations({ locale: lang, namespace: 'Og' });

  return renderOgCard({
    eyebrow: share.homeCity,
    title: share.displayName,
    subtitle: t('passport.since', { month: share.memberSince }),
    stats: [
      // The label AGREES with the number. Bulgarian has no bare plural noun
      // that works for both: a fixed "тренировки" renders "1 тренировки", which
      // is simply wrong — caught by looking at the rendered card.
      { value: String(share.points), label: t('passport.points', { count: share.points }) },
      { value: String(share.checkins), label: t('passport.checkins', { count: share.checkins }) },
      { value: String(share.badgeCount), label: t('passport.badges', { count: share.badgeCount }) },
    ],
    wordmark: t('wordmark'),
    // No map data on a passport card — and deliberately no facility, day or
    // time anywhere in the payload it renders from.
    accent: OG_PALETTE.brandDeep,
    headers: { ...PERSON_SCOPED_HEADERS },
  });
}
