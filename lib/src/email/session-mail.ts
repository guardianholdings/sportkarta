/**
 * Play-session transactional email (docs/ROADMAP.md §6, Stage 4.2).
 *
 * Pure, like the weekly digest next door: data and already-translated strings
 * in, `MailMessage` out. The strings come from `apps/web/messages/<locale>.json`
 * so the mail and the site say the same words and the i18n parity test covers
 * both. Nothing here hardcodes UI copy, and nothing here decides who to send to.
 *
 * FIVE KINDS, ONE RENDERER. Confirmation, waitlist, promotion, reminder and
 * cancellation differ by one headline sentence and by whether they carry an
 * "add to calendar" link; everything else — when, where, how many spots, how to
 * withdraw — is the same block. Writing them as five near-identical templates
 * is how one of them ends up missing the withdrawal link a year from now.
 *
 * WHAT IS NEVER IN THESE MESSAGES:
 *   - Anybody but the recipient. Not the organiser's address, not who else is
 *     going, not how far down the waitlist a named person is. A session
 *     attendee list is the sort of thing that gets forwarded.
 *   - The recipient's own address in the SUBJECT. Subjects land in notification
 *     previews on a lock screen and in bounce reports.
 *   - A credential. The private calendar-feed URL is one, and these messages
 *     are exactly what gets forwarded; they link to the profile instead.
 */

import { brandEmailHtml } from './html.js';
import type { MailMessage } from './mailer.js';

export type SessionMailKind =
  | 'rsvp_confirmed'
  | 'rsvp_waitlisted'
  | 'promoted'
  | 'reminder_24h'
  | 'reminder_2h'
  | 'occurrence_cancelled';

export interface SessionMailStrings {
  /**
   * The locale these strings are in. It writes the date as well: «събота,
   * 12 октомври 2026 г., 18:30» and "Saturday 12 October 2026, 18:30" are copy
   * too, not a format the renderer may pick for itself.
   */
  locale: string;
  /** `{title}` — one subject line per kind. */
  subjectConfirmed: string;
  subjectWaitlisted: string;
  subjectPromoted: string;
  subjectReminder: string;
  subjectCancelled: string;

  /** `{name}` */
  greeting: string;
  /**
   * The same greeting with no name in it. Members who signed up by one-time
   * code and never opened the profile have an empty display name, and
   * «Здравейте, ,» is the first thing they would read from us.
   */
  greetingNoName: string;

  /** The one sentence that differs. `{title}` */
  leadConfirmed: string;
  /** `{title}` `{position}` — the place ON THE WAITLIST, 1 for the first person waiting. */
  leadWaitlisted: string;
  /** `{title}` */
  leadPromoted: string;
  /** `{title}` `{hours}` */
  leadReminder: string;
  /** `{title}` */
  leadCancelled: string;

  labelWhen: string;
  labelWhere: string;
  labelSpots: string;
  /** `{going}` `{capacity}` */
  spots: string;
  /**
   * `{going}`, in two explicit forms rather than an ICU plural, like the
   * digest's intro: this runs in the worker with no next-intl, and «1 записани»
   * is what a single form printed for the first person to sign up.
   */
  spotsUnlimitedOne: string;
  spotsUnlimitedOther: string;

  viewSession: string;
  addToCalendar: string;
  withdraw: string;
  calendarFeed: string;
  footer: string;
}

export interface SessionMailData {
  kind: SessionMailKind;
  recipientName: string;
  title: string;
  /** Already-translated sport label. */
  sport: string;
  /** Sofia wall clock `YYYY-MM-DDTHH:MM:SS` — never converted again here. */
  startsAtLocal: string;
  facilityName: string;
  facilityUrl?: string | undefined;
  sessionUrl: string;
  /** Per-occurrence .ics. Omitted for a cancellation — there is nothing to add. */
  calendarUrl?: string | undefined;
  /**
   * Where the member manages their calendar feed — the PROFILE page, never the
   * feed URL itself. The feed token is a credential (anyone holding the URL can
   * read where this person plays, indefinitely), and a mail gets forwarded
   * ("join me!") and sits in the relay's Sent folder; the profile link is
   * worthless to anyone who is not signed in as the member.
   */
  calendarSettingsUrl?: string | undefined;
  capacity: number | null;
  going: number;
  /**
   * The member's place ON THE WAITLIST — 1 for the first person waiting — for
   * the waitlisted kind only. Not the queue position: with 10 places, the first
   * person waiting is 11th in the queue and 1st on the waitlist.
   */
  waitlistPlace?: number | undefined;
  /** Hours before the start, for the reminder kinds. */
  hoursBefore?: number | undefined;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/**
 * `YYYY-MM-DDTHH:MM:SS` → «събота, 12 октомври 2026 г., 18:30» (T-20). It read
 * «12.10.2026, 18:30» in both languages, with no weekday — the one thing a
 * reminder is read for.
 *
 * The TIME is still string surgery on the wall clock: constructing an instant
 * from it would re-interpret the civil time in whatever zone the worker
 * container happens to be in, which is the single most common way a "18:00"
 * session becomes "21:00" in somebody's mail. Only the DATE goes through Intl,
 * for its weekday and month names — read at noon UTC and formatted in UTC, which
 * names the same calendar day whatever zone anything runs in.
 */
export function formatLocal(startsAtLocal: string, locale: string): string {
  // Matched rather than split: `'not-a-date'.split('-')` yields three truthy
  // parts and a truthiness check would happily render "date.a.not, ".
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startsAtLocal);
  if (!match) return startsAtLocal;
  const [, year, month, day, hour, minute] = match;
  const date = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'bg', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), 12)));
  return `${date}, ${String(hour)}:${String(minute)}`;
}

function subjectFor(data: SessionMailData, strings: SessionMailStrings): string {
  switch (data.kind) {
    case 'rsvp_confirmed':
      return fill(strings.subjectConfirmed, { title: data.title });
    case 'rsvp_waitlisted':
      return fill(strings.subjectWaitlisted, { title: data.title });
    case 'promoted':
      return fill(strings.subjectPromoted, { title: data.title });
    case 'reminder_24h':
    case 'reminder_2h':
      return fill(strings.subjectReminder, { title: data.title });
    case 'occurrence_cancelled':
      return fill(strings.subjectCancelled, { title: data.title });
  }
}

function leadFor(data: SessionMailData, strings: SessionMailStrings): string {
  switch (data.kind) {
    case 'rsvp_confirmed':
      return fill(strings.leadConfirmed, { title: data.title });
    case 'rsvp_waitlisted':
      return fill(strings.leadWaitlisted, {
        title: data.title,
        position: data.waitlistPlace ?? 0,
      });
    case 'promoted':
      return fill(strings.leadPromoted, { title: data.title });
    case 'reminder_24h':
    case 'reminder_2h':
      return fill(strings.leadReminder, {
        title: data.title,
        hours: data.hoursBefore ?? (data.kind === 'reminder_24h' ? 24 : 2),
      });
    case 'occurrence_cancelled':
      return fill(strings.leadCancelled, { title: data.title });
  }
}

export function renderSessionMail(data: SessionMailData, strings: SessionMailStrings): MailMessage {
  const cancelled = data.kind === 'occurrence_cancelled';
  const spots =
    data.capacity === null
      ? fill(data.going === 1 ? strings.spotsUnlimitedOne : strings.spotsUnlimitedOther, {
          going: data.going,
        })
      : fill(strings.spots, { going: data.going, capacity: data.capacity });

  const name = data.recipientName.trim();
  const lines: string[] = [
    name === '' ? strings.greetingNoName : fill(strings.greeting, { name }),
    '',
    leadFor(data, strings),
    '',
    `${strings.labelWhen}: ${formatLocal(data.startsAtLocal, strings.locale)}`,
    `${strings.labelWhere}: ${data.facilityName} — ${data.sport}`,
  ];
  if (data.facilityUrl) lines.push(`  ${data.facilityUrl}`);
  // A cancelled session has no meaningful attendance any more, and printing
  // "4/10 going" under "this is cancelled" reads as a mistake.
  if (!cancelled) lines.push(`${strings.labelSpots}: ${spots}`);

  lines.push('', `${strings.viewSession}: ${data.sessionUrl}`);
  if (!cancelled && data.calendarUrl) {
    lines.push(`${strings.addToCalendar}: ${data.calendarUrl}`);
  }
  // The way out is in every message that put something in the calendar. A
  // reminder that cannot be acted on is how people stop opening reminders.
  if (!cancelled) lines.push(`${strings.withdraw}: ${data.sessionUrl}`);
  if (data.calendarSettingsUrl) {
    lines.push('', `${strings.calendarFeed}: ${data.calendarSettingsUrl}`);
  }

  lines.push('', strings.footer);

  const text = lines.join('\n');
  return {
    to: '',
    subject: subjectFor(data, strings),
    text,
    // Same content, branded shell — the text part stays the source of truth.
    html: brandEmailHtml(text, strings.locale),
  };
}
