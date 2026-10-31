import { renderCalendar } from '@sportkarta/lib/ical';

import { clubsEnabled } from '@/lib/clubs/access';
import { eventForCalendar } from '@/lib/clubs/events';
import { siteUrl } from '@/lib/seo';

/**
 * One club event as a downloadable `.ics` (0053) —
 * `/kalendar/klub-sabitie/<eventId>.ics`, the «Добавете в календара» link on
 * the public event page. Public, because the page is: title, time, place —
 * no attendee, no count. A cancelled event is served as cancelled (with a
 * higher SEQUENCE) so a calendar that took it learns of it.
 */

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ name: string }> },
): Promise<Response> {
  const { name } = await params;
  const eventId = name.endsWith('.ics') ? name.slice(0, -4) : name;
  const notFound = new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
  if (!clubsEnabled() || !UUID_RE.test(eventId)) return notFound;

  const event = await eventForCalendar(eventId);
  if (!event) return notFound;

  const base = siteUrl().replace(/\/+$/, '');
  const host = new URL(base).host;
  return new Response(
    renderCalendar({
      name: event.title,
      prodId: '-//POPS//Club events//BG',
      events: [
        {
          uid: `club-event-${event.id}@${host}`,
          startsAt: new Date(event.startsAt),
          endsAt: new Date(event.endsAt),
          summary: event.title,
          location: event.locationName,
          url: `${base}/klub/${event.clubSlug}/sabitie/${event.id}`,
          cancelled: event.cancelled,
          sequence: event.cancelled ? 1 : 0,
        },
      ],
    }),
    {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': `attachment; filename="event-${event.id}.ics"`,
        'Cache-Control': 'public, max-age=300, s-maxage=900',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
