/**
 * Wall clock ⇄ instant conversion for a named IANA zone (docs/ROADMAP.md §6).
 *
 * Sessions are scheduled in WALL CLOCK time: "every Tuesday at 18:00 in Sofia"
 * means 18:00 on the wall, in March and in July alike, even though those are
 * different UTC instants. Every calendar rule in rrule.ts is therefore expanded
 * in naive civil time — where no DST exists at all — and only the finished
 * candidates come through here to become instants. That ordering is the whole
 * correctness argument: an implementation that adds 7 × 86 400 000 ms to an
 * instant silently moves a session by an hour twice a year; this one cannot,
 * because it never adds anything to an instant.
 *
 * No dependency. `luxon` is in the lockfile only as a transitive dependency of
 * pg-boss's cron-parser; adopting it directly would add supply-chain surface for
 * arithmetic we must understand line by line anyway. Node 22 ships full ICU, so
 * `Intl` carries the tz database.
 *
 * Two moments a year have no single answer, and both policies below are
 * DELIBERATE, recorded per occurrence (play_session_occurrences.dst_resolution)
 * rather than left as invisible behaviour. They match RFC 5545 and the
 * `compatible` disambiguation of the TC39 Temporal proposal:
 *
 *   - SPRING GAP (last Sunday of March, 03:00 EET → 04:00 EEST): local times
 *     03:00–03:59 do not exist. A session nominally at 03:30 is SHIFTED FORWARD
 *     by the length of the gap, to 04:30 EEST. `resolution = 'gap_shifted'`.
 *   - AUTUMN FOLD (last Sunday of October, 04:00 EEST → 03:00 EET): local times
 *     03:00–03:59 happen twice. We take the FIRST (the still-in-DST one), so an
 *     03:30 session happens once, at the earlier of the two instants.
 *     `resolution = 'fold_first'`.
 */

export type DstResolution = 'exact' | 'gap_shifted' | 'fold_first';

/**
 * A naive civil date-time — a reading on a wall clock, with no zone attached.
 * Month is 1-based (unlike `Date`), because every other part is 1-based too and
 * an off-by-one here is a whole month of wrong sessions.
 */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export interface ZonedInstant {
  /** Milliseconds since the epoch — a real point in time. */
  instantMs: number;
  /**
   * The wall clock the instant actually lands on. Equals the requested one
   * except for `gap_shifted`, where the requested reading does not exist.
   */
  wall: WallClock;
  resolution: DstResolution;
}

/**
 * Wider than any real UTC offset (max is +14:00), so probing at ±26 h is
 * guaranteed to straddle any single transition.
 */
const PROBE_MS = 26 * 60 * 60 * 1000;

const MINUTE_MS = 60_000;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      // h23 rather than hour12:false: the latter can still yield "24" for
      // midnight in some ICU versions, which would silently become day+1.
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Throws for an unknown zone, at the call site rather than deep in expansion. */
export function assertTimeZone(timeZone: string): void {
  try {
    formatterFor(timeZone).format(0);
  } catch {
    throw new RangeError(`unknown time zone: ${timeZone}`);
  }
}

/**
 * The civil date-time an instant reads as in `timeZone`, expressed as the
 * milliseconds that reading WOULD be if it were UTC. Subtracting the instant
 * from it gives the zone's offset at that instant (east-positive).
 */
function wallMsOf(instantMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const field: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') field[part.type] = part.value;
  }
  const year = Number(field.year);
  // BC years would make the arithmetic below nonsense; they cannot occur for
  // session data, so fail loudly rather than compute a wrong instant.
  if (field.era === 'B') throw new RangeError('pre-common-era instants are not supported');
  return Date.UTC(
    year,
    Number(field.month) - 1,
    Number(field.day),
    Number(field.hour),
    Number(field.minute),
    Number(field.second),
  );
}

/** The zone's UTC offset in milliseconds at a given instant (east-positive). */
export function offsetAt(instantMs: number, timeZone: string): number {
  return wallMsOf(instantMs, timeZone) - instantMs;
}

/** A wall clock reading as the milliseconds it would be if it were UTC. */
export function wallToMs(wall: WallClock): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/** The wall clock an instant reads as in `timeZone`. */
export function instantToWall(instantMs: number, timeZone: string): WallClock {
  return msToWall(wallMsOf(instantMs, timeZone));
}

function msToWall(ms: number): WallClock {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/**
 * Resolve a wall clock reading in `timeZone` to a real instant.
 *
 * A candidate instant `t = wallMs - offset` is valid exactly when the zone's
 * offset AT `t` is that same offset — self-consistency is the definition. Both
 * offsets in play around a transition are found by probing ±26 h, which cannot
 * miss one. The count of valid candidates classifies the three cases:
 *
 *   2 → the reading happens twice (fold): take the earlier instant.
 *   1 → the ordinary case.
 *   0 → the reading does not exist (gap): `wallMs - offsetBefore` lands exactly
 *       one gap-length past the requested reading, which is the forward shift.
 */
export function zonedToInstant(wall: WallClock, timeZone: string): ZonedInstant {
  const wallMs = wallToMs(wall);
  const offsetBefore = offsetAt(wallMs - PROBE_MS, timeZone);
  const offsetAfter = offsetAt(wallMs + PROBE_MS, timeZone);

  const candidates = (offsetBefore === offsetAfter ? [offsetBefore] : [offsetBefore, offsetAfter])
    .map((offset) => wallMs - offset)
    .filter((instantMs) => offsetAt(instantMs, timeZone) === wallMs - instantMs)
    .sort((a, b) => a - b);

  if (candidates.length === 1) {
    return { instantMs: candidates[0] as number, wall, resolution: 'exact' };
  }
  if (candidates.length > 1) {
    // Fold: the earliest is the last moment of the outgoing offset (DST here).
    return { instantMs: candidates[0] as number, wall, resolution: 'fold_first' };
  }

  // Gap. offsetBefore is the smaller (pre-transition) offset, so wallMs -
  // offsetBefore is the later of the two impossible candidates and lands after
  // the transition — i.e. the requested reading pushed forward by the gap.
  const instantMs = wallMs - offsetBefore;
  return { instantMs, wall: instantToWall(instantMs, timeZone), resolution: 'gap_shifted' };
}

/** Convenience: the same, as a `Date`. */
export function zonedToDate(wall: WallClock, timeZone: string): Date {
  return new Date(zonedToInstant(wall, timeZone).instantMs);
}

/** `YYYY-MM-DDTHH:MM:SS` — the shape Postgres accepts for `timestamp`. */
export function formatWall(wall: WallClock): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:00`;
}

/**
 * Parses `YYYY-MM-DDTHH:MM[:SS]`. Sessions start on a whole minute, and a
 * non-zero seconds field is REFUSED rather than truncated: silently dropping it
 * would make every occurrence of that series a few seconds off the time the
 * organiser set, with nothing anywhere saying so.
 */
export function parseWall(text: string): WallClock {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(text);
  if (!match) throw new RangeError(`not a wall clock date-time: ${text}`);
  if (match[6] !== undefined && match[6] !== '00') {
    throw new RangeError(`sessions start on a whole minute: ${text}`);
  }
  const wall: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
  };
  // Round-trip guard: rejects 2026-02-31 and friends, which Date.UTC would
  // happily roll over into March.
  if (formatWall(msToWall(wallToMs(wall))) !== formatWall(wall)) {
    throw new RangeError(`not a valid calendar date-time: ${text}`);
  }
  return wall;
}

/** Adds whole days in CIVIL time — no instants, so no DST can leak in. */
export function addDays(wall: WallClock, days: number): WallClock {
  return msToWall(wallToMs(wall) + days * 24 * 60 * MINUTE_MS);
}

/** ISO weekday of a civil date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(wall: WallClock): number {
  const day = new Date(wallToMs(wall)).getUTCDay();
  return day === 0 ? 7 : day;
}
