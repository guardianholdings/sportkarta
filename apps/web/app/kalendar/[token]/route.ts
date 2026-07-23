import { calendarFeed, getDb } from '@sportkarta/db';
import { renderCalendar, type IcalEvent } from '@sportkarta/lib/ical';

import { siteUrl } from '@/lib/seo';

/**
 * The member's private calendar feed (docs/ROADMAP.md §6, Stage 4.2).
 *
 * `/kalendar/<token>.ics`. Outside `[locale]` on purpose — the final segment
 * carries a dot, so the i18n middleware's matcher skips it, and the response
 * therefore sets no cookie. A calendar client would not keep one anyway.
 *
 * THE TOKEN IS THE CREDENTIAL, since a calendar client cannot sign in. That
 * shapes the response as much as the query:
 *
 *  - `Cache-Control: private, no-store`. A feed URL must never sit in a shared
 *    cache; it names one person's evenings and is bearer-authenticated.
 *  - `X-Robots-Tag: noindex`. If a token leaks into a page somewhere, it must
 *    not also become a search result.
 *  - An unknown token gets a flat 404 with no detail. There is nothing to
 *    distinguish "never existed" from "rotated", and saying which would confirm
 *    a guess.
 *
 * The feed is deliberately not paginated and not filtered by query parameter:
 * the only input is the token, so there is no surface here to probe.
 */

export const dynamic = 'force-dynamic';

const TOKEN_RE = /^[A-Za-z0-9_-]{22,64}$/;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token: raw } = await params;
  // The route captures "<token>.ics"; the suffix is how the middleware is
  // bypassed and how a calendar client recognises the file.
  const token = raw.endsWith('.ics') ? raw.slice(0, -4) : raw;

  const notFound = new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
  // Shape-checked before it reaches a query: this is an unauthenticated public
  // endpoint whose only parameter is a secret.
  if (!TOKEN_RE.test(token)) return notFound;

  const feed = await calendarFeed(getDb(), token);
  if (!feed) return notFound;

  const base = siteUrl().replace(/\/+$/, '');
  const host = new URL(base).host;
  const events: IcalEvent[] = feed.occurrences.map((occurrence) => ({
    // Stable across every regeneration: a changed UID makes a client show a
    // duplicate rather than an update.
    uid: `occurrence-${occurrence.occurrenceId}@${host}`,
    startsAt: new Date(occurrence.startsAt),
    endsAt: new Date(occurrence.endsAt),
    summary: occurrence.title,
    location: occurrence.facilityName ?? undefined,
    url: `${base}/sesiya/${occurrence.occurrenceId}`,
    lat: occurrence.lat ?? undefined,
    lon: occurrence.lon ?? undefined,
    cancelled: occurrence.cancelled,
    // A cancellation must arrive with a HIGHER sequence than the invitation it
    // cancels, or a conforming client may ignore it and leave the session in
    // the member's calendar for ever.
    sequence: occurrence.cancelled ? 1 : 0,
  }));

  return new Response(
    renderCalendar({
      name: 'SportKarta',
      prodId: '-//SportKarta//Play sessions//BG',
      events,
    }),
    {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="sportkarta.ics"',
        // Bearer-authenticated and personal: never a shared cache.
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    },
  );
}
