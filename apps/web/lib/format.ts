/**
 * Dates, numbers and lists the way a Bulgarian — or English — reader expects
 * them. Pure and client-safe.
 *
 * TIME ZONE: EXPLICIT, ALWAYS. Every date is rendered in Europe/Sofia. The web
 * and worker processes deliberately run in UTC: node-postgres reads a
 * `timestamp WITHOUT time zone` (play_sessions.starts_at_local, a wall clock)
 * as process-local time, and UTC is what keeps that reading equal to the wall
 * clock — so "fix it with TZ=Europe/Sofia" would move every session by two or
 * three hours. A formatter that leaned on the process default printed the UTC
 * calendar day instead: anything done between 00:00 and 03:00 in Sofia showed
 * as the day before (UX audit 2026-10-10).
 *
 * LOCALE. `bg` as it is — «10 октомври 2026 г.», «98,8%», «12 345». The English
 * site is a European one, so `en` formats as en-GB («10 October 2026»), never
 * in the US month-first order.
 */

export const APP_TIME_ZONE = 'Europe/Sofia';

/** The Intl locale for one of the site's locales. */
export function intlLocale(locale: string): string {
  return locale === 'en' ? 'en-GB' : locale;
}

type DateInput = Date | string | number;

/**
 * A civil date (`YYYY-MM` or `YYYY-MM-DD`, e.g. a `date` column or a passport
 * month) is a calendar day, not an instant: it is read at noon UTC, which is
 * the same day in Sofia whatever the season.
 */
const CIVIL = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;

function toDate(value: DateInput): Date {
  if (typeof value === 'string') {
    const civil = CIVIL.exec(value);
    if (civil) {
      return new Date(Date.UTC(Number(civil[1]), Number(civil[2]) - 1, Number(civil[3] ?? 1), 12));
    }
  }
  return value instanceof Date ? value : new Date(value);
}

/** «10 октомври 2026 г.» / «10 October 2026»; `medium` gives «10.10.2026 г.». */
export function formatDate(
  value: DateInput,
  locale: string,
  style: 'long' | 'medium' = 'long',
): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: style,
    timeZone: APP_TIME_ZONE,
  }).format(toDate(value));
}

/** «10 октомври 2026 г. в 18:30» / «10 October 2026 at 18:30». */
export function formatDateTime(value: DateInput, locale: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: APP_TIME_ZONE,
  }).format(toDate(value));
}

/** «октомври 2026 г.» / «October 2026» — also for a `YYYY-MM` month. */
export function formatMonthYear(value: DateInput, locale: string): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: 'long',
    year: 'numeric',
    timeZone: APP_TIME_ZONE,
  }).format(toDate(value));
}

/** A number with the locale's separators: «12 345,6» / «12,345.6». */
export function formatNumber(
  value: number,
  locale: string,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(intlLocale(locale), options).format(value);
}

/** A percentage already on the 0–100 scale: «98,8%» / «98.8%». */
export function formatPercent(value: number, locale: string, digits = 1): string {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'percent',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value / 100);
}

/**
 * Values in the reader's alphabetical order of their labels.
 *
 * CANONICAL_SPORTS is ordered by its English slugs (archery, athletics,
 * badminton …), which on the Bulgarian site reads as no order at all —
 * «стрелба с лък, лека атлетика, бадминтон …», with «футбол» lost in the
 * middle of 29. Every picker sorts by the label it actually shows.
 */
export function inReadingOrder<T extends string>(
  values: readonly T[],
  locale: string,
  labelOf: (value: T) => string,
): T[] {
  const collator = new Intl.Collator(intlLocale(locale));
  return [...values].sort((a, b) => collator.compare(labelOf(a), labelOf(b)));
}
