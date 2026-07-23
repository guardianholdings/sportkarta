import { SOFIA_TZ, zonedToInstant } from '../recurrence/index.js';

/**
 * Reporting periods, in CIVIL Sofia time (Stage 6.2).
 *
 * A reporting period is a range of DAYS to whoever files the document, not a
 * range of instants — "второ тримесечие на 2026" begins at midnight in Sofia,
 * not at midnight UTC. For four months of the year those differ by three hours,
 * which is enough to move a Saturday-morning session from one quarter into the
 * previous one and make two consecutive annexes fail to add up to the year.
 *
 * So the boundaries are resolved through the same DST-correct primitive the
 * recurrence engine uses (Stage 4.1), rather than by string arithmetic on ISO
 * dates. The engine already knows that the March day is 23 hours long.
 *
 * The window is HALF-OPEN: `from` inclusive, `to` exclusive. That is the only
 * form that includes the last day's final microsecond without the query having
 * to know a column's precision, and it composes — Q2's `to` is exactly Q3's
 * `from`, so consecutive periods can neither double-count a session nor drop
 * one between them. The renderer prints the day before `to`, so the reader
 * still sees an inclusive range.
 */

export interface ReportPeriod {
  /** Inclusive start instant. */
  from: Date;
  /** EXCLUSIVE end instant. */
  to: Date;
  /** Canonical label, e.g. `2026-Q2`. */
  label: string;
}

/** Midnight in Sofia on a civil date, as a real instant. */
export function sofiaMidnight(year: number, month: number, day: number): Date {
  const resolved = zonedToInstant({ year, month, day, hour: 0, minute: 0 }, SOFIA_TZ);
  return new Date(resolved.instantMs);
}

const QUARTER_RE = /^(\d{4})-Q([1-4])$/;

/** `2026-Q2` → the civil Sofia window for April, May and June 2026. */
export function quarterPeriod(label: string): ReportPeriod {
  const match = QUARTER_RE.exec(label.trim().toUpperCase());
  if (!match) {
    throw new Error(`reports: expected a quarter like 2026-Q2, got "${label}"`);
  }
  const year = Number(match[1]);
  const quarter = Number(match[2]);
  const startMonth = (quarter - 1) * 3 + 1;
  const endYear = quarter === 4 ? year + 1 : year;
  const endMonth = quarter === 4 ? 1 : startMonth + 3;
  return {
    from: sofiaMidnight(year, startMonth, 1),
    to: sofiaMidnight(endYear, endMonth, 1),
    label: `${String(year)}-Q${String(quarter)}`,
  };
}

/** The quarter a given instant falls in, in Sofia civil time. */
export function quarterOf(instant: Date): string {
  // Sofia is never more than three hours from UTC, so a UTC month read for an
  // instant can only be wrong within three hours of a month boundary — which is
  // exactly when a quarterly report gets generated (just after midnight on the
  // 1st). Resolve properly rather than reading getUTCMonth.
  const probe = new Date(instant.getTime());
  for (let year = probe.getUTCFullYear() - 1; year <= probe.getUTCFullYear() + 1; year += 1) {
    for (let quarter = 1; quarter <= 4; quarter += 1) {
      const period = quarterPeriod(`${String(year)}-Q${String(quarter)}`);
      if (instant >= period.from && instant < period.to) return period.label;
    }
  }
  throw new Error('reports: could not resolve a quarter for the given instant');
}

/** The quarter before the one `instant` falls in — what a Q-close job reports. */
export function previousQuarter(instant: Date): string {
  const current = quarterPeriod(quarterOf(instant));
  // One second before this quarter began is the last instant of the previous.
  return quarterOf(new Date(current.from.getTime() - 1000));
}

/**
 * An arbitrary civil-day range, as the admin form supplies it: two `YYYY-MM-DD`
 * strings, both INCLUSIVE to the person typing them. The end is converted to
 * the exclusive next midnight, which is the whole reason this helper exists —
 * doing it at each call site is how the last day of a grant period gets dropped
 * from one annex out of five.
 */
export function dayRangePeriod(fromDay: string, toDayInclusive: string): ReportPeriod {
  const parse = (value: string): [number, number, number] => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match) throw new Error(`reports: expected YYYY-MM-DD, got "${value}"`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const [fy, fm, fd] = parse(fromDay);
  const [ty, tm, td] = parse(toDayInclusive);
  const from = sofiaMidnight(fy, fm, fd);
  // Midnight on the day AFTER the inclusive end. Constructed through a UTC
  // date only to advance the calendar day; the result is re-resolved in Sofia.
  const nextDay = new Date(Date.UTC(ty, tm - 1, td + 1));
  const to = sofiaMidnight(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate());
  if (to <= from) {
    throw new Error('reports: the end of the period must not precede its start');
  }
  return { from, to, label: `${fromDay}_${toDayInclusive}` };
}
