/**
 * Date-of-birth handling for the sports passport (docs/ROADMAP.md §5, legal
 * constants: "DOB derived-then-discarded").
 *
 * The ONLY thing the platform is allowed to keep is the boolean this module
 * returns. The date itself must never reach the database, a log line, an
 * analytics event or an export — see apps/web/tests/dob-not-persisted.test.ts,
 * which proves that end to end.
 */

/** Bulgarian majority age; minors are excluded from individual public leaderboards. */
export const MINOR_AGE = 18;

/** Civil timezone the product reasons in — the same one Stage 4 schedules in. */
export const APP_TIME_ZONE = 'Europe/Sofia';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_AGE_YEARS = 120;

export class InvalidDateOfBirthError extends Error {
  constructor(readonly reason: 'format' | 'not_a_date' | 'future' | 'implausible') {
    // No date value in the message: this string can reach a log.
    super(`invalid date of birth (${reason})`);
    this.name = 'InvalidDateOfBirthError';
  }
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

/** Today's civil date in Europe/Sofia — never the server's local date. */
export function civilToday(now: Date = new Date()): CivilDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const match = ISO_DATE.exec(parts);
  if (!match) throw new Error('unexpected Intl output');
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function parseCivil(input: string): CivilDate {
  const match = ISO_DATE.exec(input.trim());
  if (!match) throw new InvalidDateOfBirthError('format');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Round-trip through UTC to reject 2025-02-30 and friends. Comparing the
  // components back out avoids Date's silent overflow into the next month.
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    throw new InvalidDateOfBirthError('not_a_date');
  }
  return { year, month, day };
}

/** Completed years between two civil dates (no timezone arithmetic involved). */
export function completedYears(birth: CivilDate, today: CivilDate): number {
  let years = today.year - birth.year;
  const hadBirthday =
    today.month > birth.month || (today.month === birth.month && today.day >= birth.day);
  if (!hadBirthday) years -= 1;
  return years;
}

/**
 * Derive the ONLY value we persist. Callers pass the raw form input and keep
 * nothing else: the parameter must not be spread into an insert, echoed into a
 * response, or logged on the error path.
 *
 * A 29 February birth date counts as a birthday on 1 March in common years —
 * completedYears treats "today >= (month, day)" as had-birthday, so 03-01 in a
 * non-leap year is already past 02-29.
 */
export function deriveIsMinor(dateOfBirth: string, now: Date = new Date()): boolean {
  const birth = parseCivil(dateOfBirth);
  const today = civilToday(now);
  const age = completedYears(birth, today);
  if (age < 0) throw new InvalidDateOfBirthError('future');
  if (age > MAX_AGE_YEARS) throw new InvalidDateOfBirthError('implausible');
  return age < MINOR_AGE;
}
