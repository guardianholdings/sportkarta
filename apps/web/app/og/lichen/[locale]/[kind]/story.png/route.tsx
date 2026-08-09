import { getTranslations } from 'next-intl/server';

import { getCurrentUser } from '@/lib/auth-session';
import { OG_PALETTE } from '@/lib/og/palette';
import { renderStoryCard } from '@/lib/og/story';
import { divisionStory, passportStory, weekStory } from '@/lib/og/story-data';

/**
 * PERSON-SCOPED STORY IMAGES for the member's own current state — their week,
 * their passport, their division. 1080×1920, for Instagram and Facebook stories.
 *
 * `lichen` = «личен», personal. Everything the sibling `pasport/[handle]` route
 * says about caching, indexing and migration 0012 applies here unchanged, plus
 * one rule that is stronger:
 *
 * THIS ROUTE IS GATED ON THE SESSION, NOT ON A PUBLIC HANDLE. The passport CARD
 * renders for anyone with the link because the member opted their passport
 * public — that consent is what makes it shareable. A STORY has no such opt-in:
 * it is generated for the member's own device, handed to their own OS share
 * sheet as a file, and they decide where it goes. So the subject is always
 * `getCurrentUser()` and NEVER a parameter. There is no handle, no id and no
 * way to render a story about somebody else — which is also why this needs no
 * `leaderboard_eligible_members` join: it publishes nothing.
 *
 * The consequence to keep in mind: because it needs a cookie, no scraper can
 * fetch it, so this must never be used as an `og:image`. Stories are files a
 * person posts; cards are URLs a crawler reads. Different artifacts, different
 * routes, and `SharePayload.storyPath`/`cardPath` keep them apart.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Never cached, never stored, never indexed. */
const PERSON_SCOPED_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
  'X-Robots-Tag': 'noindex, noimageindex, noarchive',
} as const;

const KINDS = ['week', 'passport', 'division'] as const;
type Kind = (typeof KINDS)[number];

function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

type Params = Promise<{ locale: string; kind: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { locale, kind } = await params;
  if (!isKind(kind))
    return new Response('Not found', { status: 404, headers: PERSON_SCOPED_HEADERS });
  const lang = locale === 'en' ? 'en' : 'bg';

  // No session, no story. 404 rather than 401: an unauthenticated probe learns
  // nothing about whether the member or the data exists.
  const user = await getCurrentUser();
  if (!user) return new Response('Not found', { status: 404, headers: PERSON_SCOPED_HEADERS });

  const [tOg, tStory, tDivision] = await Promise.all([
    getTranslations({ locale: lang, namespace: 'Og' }),
    getTranslations({ locale: lang, namespace: 'Story' }),
    getTranslations({ locale: lang, namespace: 'Division' }),
  ]);

  const data =
    kind === 'week'
      ? await weekStory(user.id, {
          eyebrow: tStory('week.eyebrow'),
          heroLabel: tStory('week.heroLabel'),
          title: tStory('week.title'),
          labelMinutes: tStory('label.minutes'),
          labelSports: tStory('label.sports'),
          callToAction: tStory('callToAction'),
        })
      : kind === 'passport'
        ? await passportStory(user.id, {
            eyebrow: tStory('passport.eyebrow'),
            heroLabel: tStory('passport.heroLabel'),
            title: tStory('passport.title'),
            labelContributions: tStory('label.contributions'),
            labelBadges: tStory('label.checkins'),
            callToAction: tStory('callToAction'),
          })
        : await divisionStory(user.id, {
            eyebrow: tStory('division.eyebrow'),
            heroLabel: tStory('division.heroLabel'),
            title: (tier) => tStory('division.title', { tier }),
            tierName: (slug) => tDivision(`tier.${slug}`),
            labelPoints: tStory('label.points'),
            labelOf: tStory('label.inGroup'),
            callToAction: tStory('callToAction'),
          });

  // Nothing to say yet — a story of zeroes is the Wrapped-2024 failure in the
  // other direction, so it 404s and the UI simply does not offer the control.
  if (!data) return new Response('Not found', { status: 404, headers: PERSON_SCOPED_HEADERS });

  return renderStoryCard({
    ...data,
    wordmark: tOg('wordmark'),
    accent: kind === 'division' ? OG_PALETTE.accent : OG_PALETTE.brand,
    headers: PERSON_SCOPED_HEADERS,
  });
}
