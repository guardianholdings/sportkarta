/**
 * iCalendar (RFC 5545) output for play sessions (docs/ROADMAP.md §6, Stage 4.2).
 *
 * Pure: occurrences in, a `.ics` string out. No database, no clock except the
 * one the caller passes, so every rule below is unit-testable — which matters
 * more here than usual, because a malformed calendar does not throw. It is
 * accepted by one client, silently ignored by another, and shows the wrong hour
 * in a third.
 *
 * THE TIME MODEL. Stage 4.1 schedules sessions in WALL CLOCK and materialises
 * each occurrence to a concrete instant. This file emits those instants as UTC
 * (`20260723T150000Z`) and therefore ships **no VTIMEZONE component at all**.
 * That is a deliberate choice, not a shortcut:
 *
 *   - Every occurrence is already resolved. There is no recurrence rule to
 *     expand in the client, so there is nothing for a VTIMEZONE to inform.
 *   - A hand-written VTIMEZONE for Europe/Sofia would be a second copy of the
 *     DST rules, maintained by us, diverging from the tz database the moment
 *     the EU changes its mind. Stage 4.1 went to considerable trouble to have
 *     exactly one source of truth for Bulgarian civil time; this must not
 *     quietly become a second one.
 *   - A UTC instant renders as local time in the reader's own calendar, which
 *     is what someone travelling actually wants.
 *
 * The cost is honest: a client cannot re-expand the series itself, and only the
 * materialised window (8 weeks) appears. That is the same horizon the site
 * shows, so the calendar and the website agree.
 */

/** Line endings are CRLF in RFC 5545 — not a stylistic preference. */
const CRLF = '\r\n';

/**
 * Content lines are folded at 75 OCTETS, not characters (RFC 5545 §3.1).
 * Bulgarian is two bytes per letter in UTF-8, so a character-counting folder
 * produces lines that are technically over-long, and a naive octet-counting one
 * splits a letter in half and yields mojibake in the middle of every session
 * title. Neither failure throws anywhere; both are visible only in somebody's
 * calendar. Hence the explicit encoder below.
 */
const MAX_OCTETS = 75;

const encoder = new TextEncoder();

/**
 * UTF-8 length of one code point, by arithmetic rather than by encoding it.
 * `encoder.encode(char).length` allocates a typed array per character, and this
 * runs for every character of every line of every calendar feed.
 */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

export function foldLine(line: string): string {
  // One allocation to answer the common case, which is "no folding needed".
  if (encoder.encode(line).length <= MAX_OCTETS) return line;

  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  // A continuation line begins with one space, which itself costs an octet.
  let budget = MAX_OCTETS;

  // Iterating the string yields whole code points, so a character is never
  // split. Astral characters (an emoji in a session title) stay intact too.
  for (const char of line) {
    const size = utf8Length(char.codePointAt(0) ?? 0);
    if (currentBytes + size > budget) {
      parts.push(current);
      current = '';
      currentBytes = 0;
      budget = MAX_OCTETS - 1;
    }
    current += char;
    currentBytes += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/**
 * TEXT escaping (RFC 5545 §3.3.11). Backslash first — escaping it after the
 * others would double-escape the backslashes they just introduced.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

/** UTC form: 20260723T150000Z. */
export function formatUtc(instant: Date): string {
  return `${instant
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')}`;
}

export interface IcalEvent {
  /**
   * Stable across every regeneration of this occurrence. A changed UID makes a
   * calendar show a duplicate rather than an update, so it is derived from the
   * occurrence id and nothing else — never from the title or the time.
   */
  uid: string;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  description?: string | undefined;
  location?: string | undefined;
  url?: string | undefined;
  /** WGS84, emitted as `GEO:lat;lon`. */
  lat?: number | undefined;
  lon?: number | undefined;
  cancelled?: boolean | undefined;
  /**
   * Bumped when the occurrence materially changes. A cancellation MUST arrive
   * with a higher SEQUENCE than the invitation it cancels, or a conforming
   * client is entitled to ignore it — which would leave a cancelled session
   * sitting in somebody's calendar forever.
   */
  sequence?: number | undefined;
}

export interface IcalCalendar {
  /** Shown as the calendar's name once subscribed (X-WR-CALNAME). */
  name: string;
  /** Product identifier; any stable string. */
  prodId: string;
  events: readonly IcalEvent[];
  /** Fixed in tests; defaults to now. */
  now?: Date | undefined;
}

function line(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

function eventLines(event: IcalEvent, stamp: string): string[] {
  const lines = [
    'BEGIN:VEVENT',
    line('UID', event.uid),
    line('DTSTAMP', stamp),
    line('DTSTART', formatUtc(event.startsAt)),
    line('DTEND', formatUtc(event.endsAt)),
    line('SUMMARY', escapeText(event.summary)),
    line('SEQUENCE', String(event.sequence ?? 0)),
    // A cancelled occurrence stays in the feed with STATUS:CANCELLED rather
    // than disappearing: a subscribed client that simply stops seeing an event
    // may keep showing it. Saying so explicitly is what removes it.
    line('STATUS', event.cancelled ? 'CANCELLED' : 'CONFIRMED'),
    // Nobody is invited by this file; it describes a public session. Without
    // TRANSP:OPAQUE some clients treat a subscribed event as free time.
    line('TRANSP', 'OPAQUE'),
  ];
  if (event.description) lines.push(line('DESCRIPTION', escapeText(event.description)));
  if (event.location) lines.push(line('LOCATION', escapeText(event.location)));
  if (event.url) lines.push(line('URL', event.url));
  if (typeof event.lat === 'number' && typeof event.lon === 'number') {
    lines.push(line('GEO', `${event.lat.toFixed(6)};${event.lon.toFixed(6)}`));
  }
  lines.push('END:VEVENT');
  return lines;
}

export function renderCalendar(calendar: IcalCalendar): string {
  const stamp = formatUtc(calendar.now ?? new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    line('VERSION', '2.0'),
    line('PRODID', calendar.prodId),
    line('CALSCALE', 'GREGORIAN'),
    // PUBLISH, never REQUEST: REQUEST is an invitation and makes clients offer
    // an RSVP dialogue that would go nowhere. RSVP happens on the site.
    line('METHOD', 'PUBLISH'),
    line('X-WR-CALNAME', escapeText(calendar.name)),
    // A subscribed calendar polls; without a hint, clients pick their own
    // interval, sometimes hourly. The window moves weekly.
    line('REFRESH-INTERVAL;VALUE=DURATION', 'PT12H'),
    line('X-PUBLISHED-TTL', 'PT12H'),
    ...calendar.events.flatMap((event) => eventLines(event, stamp)),
    'END:VCALENDAR',
  ];
  // Trailing CRLF: the last line must be terminated like every other one.
  return `${lines.join(CRLF)}${CRLF}`;
}
