import { calendarOccurrence, getDb } from '@sportkarta/db';
import { renderCalendar } from '@sportkarta/lib/ical';

import { siteUrl } from '@/lib/seo';

/**
 * One session as a downloadable `.ics` (docs/ROADMAP.md §6, Stage 4.2).
 *
 * `/kalendar/sesiya/<occurrenceId>.ics` — the "add to calendar" link on the
 * session page and in every notification email. Public, because the session
 * page it hangs off is public, and it carries nothing the page does not:
 * title, time, place, coordinates. No attendee, no count, no organiser address.
 *
 * The static `sesiya` segment sits alongside the dynamic `[token]` route one
 * level up; Next resolves the more specific path first, and a feed token is at
 * least 22 characters, so the two cannot collide.
 *
 * `Content-Disposition: attachment` here rather than `inline`: this is a
 * one-shot download the member asked for, and every calendar app on every
 * platform handles a downloaded .ics. The subscription feed is the inline one.
 */

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params;
  const occurrenceId = name.endsWith('.ics') ? name.slice(0, -4) : name;

  const notFound = new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
  if (!UUID_RE.test(occurrenceId)) return notFound;

  const occurrence = await calendarOccurrence(getDb(), occurrenceId);
  if (!occurrence) return notFound;

  const base = siteUrl().replace(/\/+$/, '');
  const host = new URL(base).host;

  return new Response(
    renderCalendar({
      name: occurrence.title,
      prodId: '-//SportKarta//Play sessions//BG',
      events: [
        {
          // The SAME uid the subscription feed uses, deliberately: a member who
          // downloaded this file and later subscribed must end up with one
          // event, not two copies of the same Tuesday.
          uid: `occurrence-${occurrence.occurrenceId}@${host}`,
          startsAt: new Date(occurrence.startsAt),
          endsAt: new Date(occurrence.endsAt),
          summary: occurrence.title,
          location: occurrence.facilityName ?? undefined,
          url: `${base}/sesiya/${occurrence.occurrenceId}`,
          lat: occurrence.lat ?? undefined,
          lon: occurrence.lon ?? undefined,
          cancelled: occurrence.cancelled,
          sequence: occurrence.cancelled ? 1 : 0,
        },
      ],
    }),
    {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="session-${occurrence.occurrenceId}.ics"`,
        // Public but short-lived: a cancellation should reach anyone who
        // re-downloads within the hour.
        'Cache-Control': 'public, max-age=300, s-maxage=900',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
