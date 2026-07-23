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
 */

import type { MailMessage } from './mailer.js';

export type SessionMailKind =
  | 'rsvp_confirmed'
  | 'rsvp_waitlisted'
  | 'promoted'
  | 'reminder_24h'
  | 'reminder_2h'
  | 'occurrence_cancelled';

export interface SessionMailStrings {
  /** `{title}` — one subject line per kind. */
  subjectConfirmed: string;
  subjectWaitlisted: string;
  subjectPromoted: string;
  subjectReminder: string;
  subjectCancelled: string;

  /** `{name}` */
  greeting: string;

  /** The one sentence that differs. `{title}` */
  leadConfirmed: string;
  /** `{title}` `{position}` */
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
  /** `{going}` */
  spotsUnlimited: string;

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
  /** The member's private subscription feed, if they have one. */
  feedUrl?: string | undefined;
  capacity: number | null;
  going: number;
  /** Waitlist position, for the waitlisted kind only. */
  position?: number | undefined;
  /** Hours before the start, for the reminder kinds. */
  hoursBefore?: number | undefined;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/**
 * `YYYY-MM-DDTHH:MM:SS` → `DD.MM.YYYY, HH:MM`. Pure string surgery on a wall
 * clock: constructing a Date here would re-interpret the civil time as an
 * instant in whatever zone the worker container happens to be in, which is the
 * single most common way a "18:00" session becomes "21:00" in somebody's mail.
 */
export function formatLocal(startsAtLocal: string): string {
  // Matched rather than split: `'not-a-date'.split('-')` yields three truthy
  // parts and a truthiness check would happily render "date.a.not, ".
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startsAtLocal);
  if (!match) return startsAtLocal;
  const [, year, month, day, hour, minute] = match;
  return `${day}.${month}.${year}, ${hour}:${minute}`;
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
        position: data.position ?? 0,
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
      ? fill(strings.spotsUnlimited, { going: data.going })
      : fill(strings.spots, { going: data.going, capacity: data.capacity });

  const lines: string[] = [
    fill(strings.greeting, { name: data.recipientName }),
    '',
    leadFor(data, strings),
    '',
    `${strings.labelWhen}: ${formatLocal(data.startsAtLocal)}`,
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
  if (data.feedUrl) lines.push('', `${strings.calendarFeed}: ${data.feedUrl}`);

  lines.push('', strings.footer);

  return {
    to: '',
    subject: subjectFor(data, strings),
    text: lines.join('\n'),
  };
}
