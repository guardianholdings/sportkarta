import {
  addDays,
  instantToWall,
  isoWeekday,
  SOFIA_TZ,
  type WallClock,
} from '../recurrence/index.js';

/**
 * Streaks for the sports passport (docs/ROADMAP.md §7: "DST-correct streaks").
 *
 * A streak is consecutive CIVIL periods — Sofia days, or Sofia Monday-start
 * weeks — in which the member did something. Not "24 hours apart", which is a
 * different and wrong question: two of the ~365 Sofia days are 23 h and 25 h
 * long, and a member who plays at 20:00 on the Saturday before the March
 * transition and 20:00 on the Sunday after it is 23 h apart and has obviously
 * not broken their streak.
 *
 * Three bugs this module exists to make impossible, all of them silent:
 *
 *  1. BUCKETING BY UTC DATE. An event at 22:30Z in winter (EET, +2) is already
 *     00:30 the next day in Sofia; at 21:30Z in summer (EEST, +3) likewise.
 *     Getting this wrong moves evening activity — which is most of it, for
 *     amateur sport — into the wrong day, splitting streaks and merging others.
 *  2. ADVANCING BY 86_400_000 ms. Adding a day of ELAPSED time to an instant
 *     lands at 23:00 or 01:00 on the DST days, so the day key comes out one
 *     off. Every successor here is computed with `addDays` on a WallClock,
 *     which is pure civil arithmetic — no instant is ever added to.
 *  3. ASKING THE SERVER WHAT DAY IT IS. "Is the streak still alive?" is a
 *     question about Sofia's calendar, not the container's. A UTC-clocked
 *     server would kill a streak an hour or two early every evening.
 *
 * The whole module is pure and takes `now` as a parameter, so the tests pin
 * real transitions discovered from the tz database rather than mocking a clock.
 */

export type StreakUnit = 'day' | 'week';

/** Anything with an instant. Callers pass PassportEvents; only `at` is read. */
export interface Timed {
  at: Date;
}

/**
 * A civil period, as `YYYY-MM-DD`: the day itself, or the Monday that starts
 * the week. Lexicographic order is chronological order, which is why the keys
 * are strings and not a struct.
 */
export type BucketKey = string;

export interface StreakBucket {
  key: BucketKey;
  /**
   * The earliest event in the period. This is what dates a badge: a streak is
   * completed the moment its final period is first entered, not at midnight.
   */
  firstAt: Date;
  /** 1 for the first period of a run, 2 for the second consecutive one, … */
  runLength: number;
}

export interface StreakSummary {
  unit: StreakUnit;
  /** The run in progress. Zero once a period has been missed. */
  current: number;
  /** The best run ever achieved — what a streak badge is measured against. */
  longest: number;
  /** Most recent active period, or null when there is no activity at all. */
  lastActive: BucketKey | null;
}

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `YYYY-MM-DD` for a wall clock, ignoring its time of day. */
export function formatCivilDate(wall: WallClock): string {
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** Midnight on a `YYYY-MM-DD` key, as a wall clock. */
export function parseCivilDate(key: BucketKey): WallClock {
  const match = CIVIL_DATE.exec(key);
  if (!match) throw new RangeError(`not a civil date: ${key}`);
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
  };
}

/**
 * The civil period an instant falls in, read through the tz database. This is
 * the one place an instant becomes a calendar position, and it is the only
 * place it is allowed to happen.
 */
export function bucketKeyFor(at: Date, unit: StreakUnit, timeZone: string = SOFIA_TZ): BucketKey {
  const wall = instantToWall(at.getTime(), timeZone);
  const midnight: WallClock = { ...wall, hour: 0, minute: 0 };
  if (unit === 'day') return formatCivilDate(midnight);
  // Monday-start weeks — the same week the digest sends (db/src/digest.ts), so
  // "4 weeks in a row" and "this week's sessions" cannot disagree about where a
  // week begins.
  return formatCivilDate(addDays(midnight, -(isoWeekday(midnight) - 1)));
}

/** The period immediately after `key`, in civil arithmetic. Never `+ 86 400 000`. */
export function nextBucketKey(key: BucketKey, unit: StreakUnit): BucketKey {
  return formatCivilDate(addDays(parseCivilDate(key), unit === 'day' ? 1 : 7));
}

/** The period immediately before `key`. */
export function previousBucketKey(key: BucketKey, unit: StreakUnit): BucketKey {
  return formatCivilDate(addDays(parseCivilDate(key), unit === 'day' ? -1 : -7));
}

/**
 * The active periods, chronologically, each carrying how far into its run it
 * is. Events may arrive in any order; several events in one period collapse to
 * one bucket, which is the entire point (playing twice on Tuesday is not a
 * two-day streak).
 */
export function streakBuckets(
  events: readonly Timed[],
  unit: StreakUnit,
  timeZone: string = SOFIA_TZ,
): StreakBucket[] {
  const earliest = new Map<BucketKey, number>();
  for (const event of events) {
    const ms = event.at.getTime();
    if (Number.isNaN(ms)) throw new RangeError('event has an invalid instant');
    const key = bucketKeyFor(event.at, unit, timeZone);
    const known = earliest.get(key);
    if (known === undefined || ms < known) earliest.set(key, ms);
  }

  const keys = [...earliest.keys()].sort();
  const buckets: StreakBucket[] = [];
  let previous: BucketKey | null = null;
  let run = 0;
  for (const key of keys) {
    run = previous !== null && key === nextBucketKey(previous, unit) ? run + 1 : 1;
    buckets.push({ key, firstAt: new Date(earliest.get(key) as number), runLength: run });
    previous = key;
  }
  return buckets;
}

export interface StreakOptions {
  timeZone?: string;
  /** "Now" for the liveness question. Defaults to the real clock. */
  now?: Date;
}

/**
 * Current and longest run.
 *
 * A run is ALIVE while the current period is still open — a member who played
 * yesterday and not yet today has not broken anything, they simply have not
 * played today. So the last active period counts as current when it is this
 * period or the previous one, and the streak dies only when a whole period has
 * passed with nothing in it.
 */
export function summarizeStreak(
  events: readonly Timed[],
  unit: StreakUnit,
  options: StreakOptions = {},
): StreakSummary {
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const buckets = streakBuckets(events, unit, timeZone);
  if (buckets.length === 0) return { unit, current: 0, longest: 0, lastActive: null };

  const longest = buckets.reduce((best, bucket) => Math.max(best, bucket.runLength), 0);
  const last = buckets[buckets.length - 1] as StreakBucket;

  const nowKey = bucketKeyFor(options.now ?? new Date(), unit, timeZone);
  const alive = last.key === nowKey || last.key === previousBucketKey(nowKey, unit);

  return { unit, current: alive ? last.runLength : 0, longest, lastActive: last.key };
}
