import { instantToWall, SOFIA_TZ } from '../recurrence/index.js';

/**
 * Civil dates for the club module — `YYYY-MM-DD` strings, Sofia calendar.
 *
 * Memberships, pauses, charges and invoices are CALENDAR facts ("valid until
 * 14 March"), never instants, so they are stored as `date` and computed here in
 * pure civil arithmetic. Nothing here adds 86 400 000 ms to anything: a day is
 * a calendar step, so DST cannot move a validity date.
 */

export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= daysInMonth(y, m) && y >= 2000 && y <= 2100;
}

function parts(date: IsoDate): [number, number, number] {
  const match = ISO_DATE.exec(date);
  if (!match) throw new RangeError(`not an ISO date: ${date}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function format(y: number, m: number, d: number): IsoDate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Today on a Sofia wall calendar. */
export function sofiaToday(now: Date = new Date()): IsoDate {
  const wall = instantToWall(now.getTime(), SOFIA_TZ);
  return format(wall.year, wall.month, wall.day);
}

/** Calendar arithmetic through UTC midnight, which has no DST. */
export function addDaysIso(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = parts(date);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return format(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/**
 * `months` calendar months later. When the day does not exist in the target
 * month (31 January + 1 month) it is CLAMPED to that month's last day, and the
 * second element says so — membershipEndsOn needs to know.
 */
export function addMonthsIso(date: IsoDate, months: number): [IsoDate, boolean] {
  const [y, m, d] = parts(date);
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = daysInMonth(year, month);
  return [format(year, month, Math.min(d, last)), d > last];
}

export type Validity = { days: number } | { months: number };

/**
 * The last day (INCLUSIVE) a membership starting on `startsOn` is valid.
 *
 *   days:   startsOn + days − 1. A 1-day pass is valid on its own day.
 *   months: "until the same date next month", i.e. the day before it —
 *           15 Jan + 1 month ends 14 Feb — except when that date does not
 *           exist, where the period runs to the END of the target month:
 *           31 Jan + 1 month ends 28 Feb (not 27), 30 Jan likewise. A client
 *           who buys a month on the 31st gets the whole of February.
 */
export function membershipEndsOn(startsOn: IsoDate, validity: Validity): IsoDate {
  if ('days' in validity) return addDaysIso(startsOn, validity.days - 1);
  const [target, clamped] = addMonthsIso(startsOn, validity.months);
  return clamped ? target : addDaysIso(target, -1);
}

/** First day of the month `date` falls in. */
export function monthStart(date: IsoDate): IsoDate {
  const [y, m] = parts(date);
  return format(y, m, 1);
}

/** ISO week key `YYYY-Www` for the Monday-based week containing `date`. */
export function isoWeekKey(date: IsoDate): string {
  const [y, m, d] = parts(date);
  const day = new Date(Date.UTC(y, m - 1, d));
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(day.getTime() + (3 - weekday) * 86_400_000);
  const weekYear = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(weekYear, 0, 4));
  const jan4Weekday = (jan4.getUTCDay() + 6) % 7;
  const week1Monday = jan4.getTime() - jan4Weekday * 86_400_000;
  const week = Math.floor((thursday.getTime() - week1Monday) / (7 * 86_400_000)) + 1;
  return `${String(weekYear)}-W${String(week).padStart(2, '0')}`;
}

/** The Monday that starts ISO week `YYYY-Www`, or null for a malformed key. */
export function isoWeekMonday(key: string): IsoDate | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53 || year < 2000 || year > 2100) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Weekday = (jan4.getUTCDay() + 6) % 7;
  const monday = new Date(jan4.getTime() - jan4Weekday * 86_400_000 + (week - 1) * 7 * 86_400_000);
  const result = format(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
  return isoWeekKey(result) === key ? result : null;
}
