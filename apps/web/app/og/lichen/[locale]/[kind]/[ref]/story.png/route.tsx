import { getTranslations } from 'next-intl/server';

import { getCurrentUser } from '@/lib/auth-session';
import { OG_PALETTE } from '@/lib/og/palette';
import { renderStoryCard } from '@/lib/og/story';
import { trainingStory } from '@/lib/og/story-data';

/**
 * PERSON-SCOPED STORY IMAGES for one row the member owns — a single training.
 *
 * Everything the sibling `[kind]/story.png` route says applies unchanged: gated
 * on the session rather than on a parameter, `private, no-store`,
 * `force-dynamic`, `X-Robots-Tag: noindex`, and never usable as an `og:image`
 * because no scraper can fetch it.
 *
 * THE `ref` IS NOT AN AUTHORISATION. It selects WHICH of the member's own rows
 * to draw, and the lookup runs through `memberTrainings(userId)`, which is
 * already scoped in SQL — so a ref belonging to somebody else simply is not in
 * the result and the route 404s. There is deliberately no "does this row belong
 * to you" branch: an ownership check written as an `if` is one somebody can
 * later move, and this way there is nothing to move.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PERSON_SCOPED_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'X-Robots-Tag': 'noindex, noimageindex, noarchive',
} as const;

type Params = Promise<{ locale: string; kind: string; ref: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { locale, kind, ref } = await params;
  if (kind !== 'training') {
    return new Response('Not found', { status: 404, headers: PERSON_SCOPED_HEADERS });
  }
  const lang = locale === 'en' ? 'en' : 'bg';

  const user = await getCurrentUser();
  if (!user) return new Response('Not found', { status: 404, headers: PERSON_SCOPED_HEADERS });

  const [tOg, tStory, tSport] = await Promise.all([
    getTranslations({ locale: lang, namespace: 'Og' }),
    getTranslations({ locale: lang, namespace: 'Story' }),
    getTranslations({ locale: lang, namespace: 'Sport' }),
  ]);

  const data = await trainingStory(user.id, ref, {
    eyebrow: tStory('training.eyebrow'),
    heroKm: tStory('training.heroKm'),
    heroMin: tStory('training.heroMin'),
    title: (sport) => tStory('training.title', { sport: tSport(sport) }),
    labelMinutes: tStory('label.minutes'),
    labelKm: tStory('label.km'),
    labelElevation: tStory('label.elevation'),
    callToAction: tStory('callToAction'),
  });

  if (!data) return new Response('Not found', { status: 404, headers: PERSON_SCOPED_HEADERS });

  return renderStoryCard({
    ...data,
    wordmark: tOg('wordmark'),
    accent: OG_PALETTE.accent,
    headers: PERSON_SCOPED_HEADERS,
  });
}
