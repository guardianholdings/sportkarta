import { addDays, instantToWall, isoWeekday, SOFIA_TZ, type WallClock } from '../recurrence/index.js';

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
  /**
   * The run is alive but the period currently open is still empty — it ends
   * unless something happens before this period closes.
   *
   * False for a dead streak (nothing left to lose) and false once the member
   * has been active in the open period. Never true when `current` is 0.
   */
  atRisk: boolean;
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
export function bucketKeyFor(
  at: Date,
  unit: StreakUnit,
  timeZone: string = SOFIA_TZ,
): BucketKey {
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
const NO_FREEZES: ReadonlySet<BucketKey> = new Set();

/**
 * Is the run from `from` to `to` unbroken — either adjacent, or separated only
 * by periods that are frozen?
 *
 * With an empty freeze set this is exactly the old adjacency test, which is why
 * adding freezes changed no existing behaviour: for neighbouring periods the
 * loop never runs and the answer is the same one `key === nextBucketKey(previous)`
 * gave.
 *
 * Terminates because `nextBucketKey` strictly advances and keys sort
 * chronologically (that is the whole reason they are `YYYY-MM-DD` strings).
 */
function bridged(
  from: BucketKey,
  to: BucketKey,
  unit: StreakUnit,
  frozen: ReadonlySet<BucketKey>,
): boolean {
  let cursor = nextBucketKey(from, unit);
  while (cursor < to) {
    if (!frozen.has(cursor)) return false;
    cursor = nextBucketKey(cursor, unit);
  }
  return cursor === to;
}

export function streakBuckets(
  events: readonly Timed[],
  unit: StreakUnit,
  timeZone: string = SOFIA_TZ,
  frozen: ReadonlySet<BucketKey> = NO_FREEZES,
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
    // A frozen period BRIDGES the run without COUNTING toward it: `run + 1` is
    // the one active period just found, never the frozen gap as well. A freeze
    // forgives a week you missed; it must not manufacture one you did not show
    // up for, which is the whole framing of the product (ENGAGEMENT.md §1.2 —
    // reward showing up, not performance).
    run = previous !== null && bridged(previous, key, unit, frozen) ? run + 1 : 1;
    buckets.push({ key, firstAt: new Date(earliest.get(key) as number), runLength: run });
    previous = key;
  }
  return buckets;
}

export interface StreakOptions {
  timeZone?: string;
  /** "Now" for the liveness question. Defaults to the real clock. */
  now?: Date;
  /**
   * Periods that do not break a run even though nothing happened in them
   * («замразяване», ENGAGEMENT.md A4).
   *
   * NOT A BALANCE THE MEMBER SPENDS. CLAUDE.md is explicit that the points
   * economy is earning-only with no spending mechanics, and a freeze you hold
   * and consume would be exactly that. It is forgiveness the system applies on
   * the member's behalf, capped per rolling year, and the copy must describe it
   * as APPLIED rather than as something to use up.
   *
   * The caller supplies the set — this module stays pure and stateless, so the
   * tests can still pin real DST transitions with no database in sight.
   */
  frozen?: ReadonlySet<BucketKey>;
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
  const frozen = options.frozen ?? NO_FREEZES;
  const buckets = streakBuckets(events, unit, timeZone, frozen);
  if (buckets.length === 0) {
    return { unit, current: 0, longest: 0, lastActive: null, atRisk: false };
  }

  const longest = buckets.reduce((best, bucket) => Math.max(best, bucket.runLength), 0);
  const last = buckets[buckets.length - 1] as StreakBucket;

  const nowKey = bucketKeyFor(options.now ?? new Date(), unit, timeZone);
  // `bridged` subsumes the old "this period or the previous one" test: for the
  // immediately preceding period there is nothing in between, so it is true
  // with no freezes at all. Frozen periods simply extend how far back the last
  // activity may sit and still be alive.
  const alive = last.key === nowKey || bridged(last.key, nowKey, unit, frozen);

  return {
    unit,
    current: alive ? last.runLength : 0,
    longest,
    lastActive: last.key,
    // Alive, but nothing in the period that is currently open — so the run ends
    // unless something happens before this period closes. Derived HERE rather
    // than by a caller comparing dates, because `bucketKeyFor` is the one place
    // an instant is allowed to become a calendar position, and "is my streak in
    // danger" is a question about Sofia's calendar.
    atRisk: alive && last.key !== nowKey,
  };
}
