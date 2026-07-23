/**
 * RRULE parsing and expansion for pickup sessions (docs/ROADMAP.md §6).
 *
 * A DELIBERATE SUBSET of RFC 5545, not a general implementation:
 *
 *     FREQ=DAILY|WEEKLY [;INTERVAL=n] [;BYDAY=MO,…,SU] [;COUNT=n | ;UNTIL=…Z]
 *     [;WKST=MO]
 *
 * That covers everything a пикап session needs ("every Tuesday and Thursday at
 * 18:00", "every day", "every other Saturday until the end of term"). MONTHLY,
 * YEARLY, BYSETPOS, BYMONTHDAY, BYMONTH and inline EXDATE are rejected at parse
 * time AND by a CHECK constraint on play_sessions.rrule — the same
 * closed-vocabulary posture as facility_condition_reports.tags: widening the
 * grammar is a migration and a decision, never an accident. Exceptions to a
 * series are rows (a cancelled occurrence), not rule text.
 *
 * Expansion is pure civil-date arithmetic (see zoned.ts): candidates are
 * generated as wall clock readings, and only the survivors are turned into
 * instants. WKST is fixed to Monday — the ISO and Bulgarian week — and accepted
 * in the text only so a calendar export that states it round-trips.
 */

import {
  addDays,
  assertTimeZone,
  instantToWall,
  isoWeekday,
  parseWall,
  wallToMs,
  zonedToInstant,
  type DstResolution,
  type WallClock,
} from './zoned.js';

export type Frequency = 'DAILY' | 'WEEKLY';

/** RFC 5545 two-letter weekday codes, indexed by ISO weekday (1 = Monday). */
export const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

export interface Rrule {
  freq: Frequency;
  interval: number;
  /** ISO weekdays (1–7), ascending. Empty = "whatever day DTSTART falls on". */
  byDay: number[];
  count?: number;
  /**
   * INCLUSIVE upper bound as an instant, from `UNTIL=…Z` (RFC 5545: always UTC,
   * and an occurrence landing exactly on it is part of the series).
   */
  untilMs?: number;
}

export type RecurrenceErrorCode =
  | 'rrule_empty'
  | 'rrule_syntax'
  | 'rrule_unsupported_part'
  | 'rrule_unsupported_freq'
  | 'rrule_duplicate_part'
  | 'rrule_interval_range'
  | 'rrule_count_range'
  | 'rrule_until_invalid'
  | 'rrule_count_and_until'
  | 'rrule_byday_requires_weekly'
  | 'rrule_byday_invalid'
  | 'rrule_wkst_unsupported'
  | 'rrule_too_many_occurrences';

/** Slug-carrying error, mirroring apps/web/lib/contributions/errors.ts. */
export class RecurrenceError extends Error {
  readonly code: RecurrenceErrorCode;

  constructor(code: RecurrenceErrorCode) {
    super(code);
    this.name = 'RecurrenceError';
    this.code = code;
  }
}

export const MAX_INTERVAL = 999;
export const MAX_COUNT = 999;
/**
 * Hard ceiling on candidates examined in one expansion. A window is at most 8
 * weeks (the materializer's horizon), but a DTSTART years in the past with
 * COUNT still has to be walked from the start, so the bound is generous —
 * while still making a pathological rule fail fast instead of spinning.
 */
export const MAX_ITERATIONS = 20_000;

export function parseRrule(text: string): Rrule {
  const trimmed = text.trim();
  if (trimmed === '') throw new RecurrenceError('rrule_empty');

  const seen = new Set<string>();
  let freq: Frequency | undefined;
  let interval = 1;
  let byDay: number[] = [];
  let count: number | undefined;
  let untilMs: number | undefined;

  for (const part of trimmed.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) throw new RecurrenceError('rrule_syntax');
    const name = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (seen.has(name)) throw new RecurrenceError('rrule_duplicate_part');
    seen.add(name);

    switch (name) {
      case 'FREQ':
        if (value !== 'DAILY' && value !== 'WEEKLY') {
          throw new RecurrenceError('rrule_unsupported_freq');
        }
        freq = value;
        break;
      case 'INTERVAL': {
        if (!/^[0-9]+$/.test(value)) throw new RecurrenceError('rrule_syntax');
        interval = Number(value);
        if (interval < 1 || interval > MAX_INTERVAL) {
          throw new RecurrenceError('rrule_interval_range');
        }
        break;
      }
      case 'COUNT': {
        if (!/^[0-9]+$/.test(value)) throw new RecurrenceError('rrule_syntax');
        count = Number(value);
        if (count < 1 || count > MAX_COUNT) throw new RecurrenceError('rrule_count_range');
        break;
      }
      case 'UNTIL':
        untilMs = parseUntil(value);
        break;
      case 'BYDAY':
        byDay = parseByDay(value);
        break;
      case 'WKST':
        // Accepted for round-tripping only; every other value would change the
        // meaning of INTERVAL for weekly rules and is not implemented.
        if (value !== 'MO') throw new RecurrenceError('rrule_wkst_unsupported');
        break;
      default:
        throw new RecurrenceError('rrule_unsupported_part');
    }
  }

  if (!freq) throw new RecurrenceError('rrule_syntax');
  if (count !== undefined && untilMs !== undefined) {
    throw new RecurrenceError('rrule_count_and_until');
  }
  if (byDay.length > 0 && freq !== 'WEEKLY') {
    throw new RecurrenceError('rrule_byday_requires_weekly');
  }

  return { freq, interval, byDay, count, untilMs };
}

/** RFC 5545 UNTIL for a date-time DTSTART is always UTC: `YYYYMMDDTHHMMSSZ`. */
function parseUntil(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) throw new RecurrenceError('rrule_until_invalid');
  const ms = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  if (!Number.isFinite(ms)) throw new RecurrenceError('rrule_until_invalid');
  // Guard against 2026-02-31T…, which Date.UTC rolls over silently.
  const iso = new Date(ms).toISOString();
  if (
    iso.slice(0, 19).replace(/[-:]/g, '') !==
    `${match[1]}${match[2]}${match[3]}T${match[4]}${match[5]}${match[6]}`
  ) {
    throw new RecurrenceError('rrule_until_invalid');
  }
  return ms;
}

function parseByDay(value: string): number[] {
  if (value === '') throw new RecurrenceError('rrule_byday_invalid');
  const days = new Set<number>();
  for (const code of value.split(',')) {
    const index = (WEEKDAY_CODES as readonly string[]).indexOf(code);
    // An ordinal prefix (1SA, -1SU) is MONTHLY territory and unsupported.
    if (index < 0) throw new RecurrenceError('rrule_byday_invalid');
    days.add(index + 1);
  }
  return [...days].sort((a, b) => a - b);
}

/** Canonical text for a parsed rule — what gets stored. */
export function formatRrule(rule: Rrule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${String(rule.interval)}`);
  if (rule.byDay.length > 0) {
    parts.push(`BYDAY=${rule.byDay.map((d) => WEEKDAY_CODES[d - 1] ?? '').join(',')}`);
  }
  if (rule.count !== undefined) parts.push(`COUNT=${String(rule.count)}`);
  if (rule.untilMs !== undefined) {
    parts.push(`UNTIL=${new Date(rule.untilMs).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`);
  }
  return parts.join(';');
}

export interface Occurrence {
  /** The wall clock the occurrence actually happens at, in the series' zone. */
  wall: WallClock;
  startsAt: Date;
  endsAt: Date;
  resolution: DstResolution;
}

export interface SeriesDefinition {
  /** DTSTART as a wall clock reading — never an instant. */
  dtstart: WallClock;
  timeZone: string;
  durationMinutes: number;
  /** NULL/undefined = a one-off session: exactly one occurrence at DTSTART. */
  rrule?: Rrule | string | null;
}

export interface ExpandWindow {
  /** Inclusive lower bound on the START instant. */
  from: Date;
  /** Exclusive upper bound on the START instant. */
  to: Date;
  /** Safety valve for a caller that only wants the next few. */
  limit?: number;
}

/**
 * Expand a series into the occurrences whose START falls in `[from, to)`.
 *
 * COUNT is counted from DTSTART, not from the window — RFC 5545 semantics and
 * the only reading that keeps a rolling window stable — so expansion always
 * walks from DTSTART and filters afterwards.
 *
 * `endsAt` is `startsAt + durationMinutes` of ELAPSED time, not wall clock: two
 * hours of football is two hours regardless of which way the clocks went that
 * night. The alternative (holding the end's wall clock) would make a session
 * spanning the spring gap one hour shorter than the organiser announced.
 */
export function expandRrule(series: SeriesDefinition, window: ExpandWindow): Occurrence[] {
  assertTimeZone(series.timeZone);
  if (!Number.isInteger(series.durationMinutes) || series.durationMinutes <= 0) {
    throw new RangeError('durationMinutes must be a positive integer');
  }

  const rule =
    typeof series.rrule === 'string' ? parseRrule(series.rrule) : (series.rrule ?? undefined);
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();
  const limit = window.limit ?? Number.POSITIVE_INFINITY;
  const out: Occurrence[] = [];

  if (!rule) {
    const single = materialize(series.dtstart, series, fromMs, toMs);
    return single ? [single] : [];
  }

  // Without COUNT, nothing depends on how many occurrences preceded the window,
  // so the walk can start near it instead of at DTSTART. That matters: a daily
  // series from 2020 would otherwise cost thousands of tz conversions on every
  // hourly run, forever, and a handful of such series would starve the
  // materializer's batch. With COUNT the walk must start at DTSTART, because
  // COUNT counts occurrences the rule generated, not ones in the window.
  // Two days of slack absorbs any offset difference; `notBefore` only ever
  // moves the start EARLIER than the first candidate that could qualify.
  const notBefore =
    rule.count === undefined ? addDays(instantToWall(fromMs, series.timeZone), -2) : undefined;

  let emitted = 0;
  let iterations = 0;
  for (const wall of candidateWalls(series.dtstart, rule, notBefore)) {
    if (++iterations > MAX_ITERATIONS) {
      throw new RecurrenceError('rrule_too_many_occurrences');
    }
    const zoned = zonedToInstant(wall, series.timeZone);

    // UNTIL bounds the SERIES (an instant, per RFC), independently of the
    // window: passing it ends the rule, so stop rather than skip.
    if (rule.untilMs !== undefined && zoned.instantMs > rule.untilMs) break;

    // COUNT counts every occurrence the rule generates, including ones before
    // the window — so it is incremented here, before any window filtering.
    emitted += 1;
    if (rule.count !== undefined && emitted > rule.count) break;

    if (zoned.instantMs >= toMs) break;
    if (zoned.instantMs < fromMs) continue;

    out.push(toOccurrence(zoned, series.durationMinutes));
    if (out.length >= limit) break;
  }

  return out;
}

function toOccurrence(
  zoned: ReturnType<typeof zonedToInstant>,
  durationMinutes: number,
): Occurrence {
  return {
    wall: zoned.wall,
    startsAt: new Date(zoned.instantMs),
    endsAt: new Date(zoned.instantMs + durationMinutes * 60_000),
    resolution: zoned.resolution,
  };
}

function materialize(
  wall: WallClock,
  series: SeriesDefinition,
  fromMs: number,
  toMs: number,
): Occurrence | undefined {
  const zoned = zonedToInstant(wall, series.timeZone);
  if (zoned.instantMs < fromMs || zoned.instantMs >= toMs) return undefined;
  return toOccurrence(zoned, series.durationMinutes);
}

/**
 * The rule's candidate wall clocks, in order, as an unbounded generator. All
 * arithmetic is civil — `addDays` never touches an instant — so the local
 * time-of-day is invariant by construction and no DST transition can shift it.
 *
 * `notBefore` fast-forwards the walk to the last rule-aligned step at or before
 * that date. It is only ever an optimisation: the skip is a whole number of
 * INTERVAL steps, computed by flooring, so it can never step OVER a candidate
 * the caller still wants.
 */
function* candidateWalls(
  dtstart: WallClock,
  rule: Rrule,
  notBefore?: WallClock,
): Generator<WallClock> {
  if (rule.freq === 'DAILY') {
    let wall = dtstart;
    if (notBefore) {
      wall = addDays(wall, alignedSkip(dtstart, notBefore, rule.interval));
    }
    for (;;) {
      yield wall;
      wall = addDays(wall, rule.interval);
    }
    // Unreachable — the loop above never exits. Stated explicitly so that
    // adding a `break` to it cannot silently fall through into the weekly walk.
  }

  // WEEKLY. Weeks start on Monday (WKST=MO), and INTERVAL counts weeks between
  // occurrence WEEKS, not between occurrences — so the walk is week by week and
  // the BYDAY set is emitted in ascending weekday order inside each active week.
  const days = rule.byDay.length > 0 ? rule.byDay : [isoWeekday(dtstart)];
  const dtstartMs = wallToMs(dtstart);
  let weekStart = addDays(dtstart, -(isoWeekday(dtstart) - 1));
  if (notBefore) {
    const weeks = alignedSkip(weekStart, notBefore, rule.interval, 7);
    weekStart = addDays(weekStart, weeks);
  }
  for (;;) {
    for (const isoDay of days) {
      const wall = addDays(weekStart, isoDay - 1);
      // A BYDAY earlier in DTSTART's own week is before the series begins.
      if (wallToMs(wall) >= dtstartMs) yield wall;
    }
    weekStart = addDays(weekStart, 7 * rule.interval);
  }
}

const CIVIL_DAY_MS = 24 * 60 * 60 * 1000;

/** Whole INTERVAL steps (in days) from `origin` that stay at or before `target`. */
function alignedSkip(origin: WallClock, target: WallClock, interval: number, stepDays = 1): number {
  const elapsedDays = Math.floor((wallToMs(target) - wallToMs(origin)) / CIVIL_DAY_MS);
  if (elapsedDays <= 0) return 0;
  const step = interval * stepDays;
  return Math.floor(elapsedDays / step) * step;
}

/** Parses a `YYYY-MM-DDTHH:MM` DTSTART string into a wall clock. */
export { parseWall as parseDtstart };
