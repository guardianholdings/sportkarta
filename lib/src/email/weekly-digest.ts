/**
 * The weekly city digest email body (docs/ROADMAP.md §6, Stage 4.4).
 *
 * Pure: data and already-translated strings in, `MailMessage` out. The strings
 * come from `apps/web/messages/<locale>.json` — the source of truth per
 * CLAUDE.md — so the email and the page say the same words, and the i18n parity
 * test covers the email too. Nothing here hardcodes UI copy.
 *
 * Plain text is always produced: it is the body that survives every client, and
 * it is what lands in `apps/web/var/mail` for inspection in development.
 */

import { brandEmailHtml } from './html.js';
import type { MailMessage } from './mailer.js';

/** One row of the digest, already resolved and ordered by the caller. */
export interface DigestEntry {
  /** Sofia wall clock `YYYY-MM-DDTHH:MM:SS` — never converted again here. */
  startsAtLocal: string;
  title: string;
  /** Already-translated sport label. */
  sport: string;
  facilityName: string;
  facilityUrl?: string | undefined;
  capacity: number | null;
  going: number;
}

export interface DigestStrings {
  /** `{city}` */
  subject: string;
  /** `{name}` `{city}` */
  greeting: string;
  /**
   * Two explicit forms rather than an ICU plural: this renderer runs in the
   * worker, which has no next-intl, and a half-implemented ICU interpreter
   * would ship `{count, plural, ...}` straight into somebody's inbox — which is
   * exactly what happened before these became separate keys.
   */
  introOne: string;
  introOther: string;
  /** Weekday names, Monday first — 7 entries. */
  weekdays: readonly string[];
  /** `{going}` `{capacity}` */
  spots: string;
  /** `{going}` */
  spotsUnlimited: string;
  viewWeek: string;
  unsubscribe: string;
  footer: string;
}

export interface DigestData {
  cityName: string;
  recipientName: string;
  entries: readonly DigestEntry[];
  weekUrl: string;
  unsubscribeUrl: string;
}

/** Simple `{name}` interpolation — the same placeholder syntax next-intl uses. */
function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/** Weekday index 0..6 (Monday first) for a wall-clock date, without a Date. */
function weekdayIndex(startsAtLocal: string): number {
  const [datePart] = startsAtLocal.split('T');
  const [year, month, day] = (datePart ?? '').split('-').map(Number);
  // Date.UTC on the civil date: no timezone is involved, so this is calendar
  // arithmetic, not an instant conversion.
  const jsDay = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();
  return jsDay === 0 ? 6 : jsDay - 1;
}

function timeOf(startsAtLocal: string): string {
  return (startsAtLocal.split('T')[1] ?? '').slice(0, 5);
}

function dateOf(startsAtLocal: string): string {
  return startsAtLocal.split('T')[0] ?? '';
}

/**
 * Render the digest. Returns `undefined` for an empty week: a mail that says
 * "nothing is on" is not worth an inbox, and the job skips rather than sends.
 */
export function renderWeeklyDigest(
  data: DigestData,
  strings: DigestStrings,
): MailMessage | undefined {
  if (data.entries.length === 0) return undefined;

  const lines: string[] = [
    fill(strings.greeting, { name: data.recipientName, city: data.cityName }),
    '',
    fill(data.entries.length === 1 ? strings.introOne : strings.introOther, {
      count: data.entries.length,
    }),
    '',
  ];

  let lastDate = '';
  for (const entry of data.entries) {
    const date = dateOf(entry.startsAtLocal);
    if (date !== lastDate) {
      if (lastDate !== '') lines.push('');
      const weekday = strings.weekdays[weekdayIndex(entry.startsAtLocal)] ?? '';
      lines.push(`${weekday}, ${date}`);
      lastDate = date;
    }
    const spots =
      entry.capacity === null
        ? fill(strings.spotsUnlimited, { going: entry.going })
        : fill(strings.spots, { going: entry.going, capacity: entry.capacity });
    lines.push(
      `  ${timeOf(entry.startsAtLocal)}  ${entry.title} — ${entry.sport}, ${entry.facilityName} (${spots})`,
    );
    if (entry.facilityUrl) lines.push(`    ${entry.facilityUrl}`);
  }

  lines.push('', `${strings.viewWeek}: ${data.weekUrl}`, '', strings.footer, '');
  // Every message carries its own unsubscribe link — one click, no sign-in.
  lines.push(`${strings.unsubscribe}: ${data.unsubscribeUrl}`);

  const text = lines.join('\n');
  return {
    to: '',
    // The subject names the city, never the recipient: subjects end up in
    // notification previews, logs and bounce reports.
    subject: fill(strings.subject, { city: data.cityName }),
    text,
    html: brandEmailHtml(text),
  };
}
