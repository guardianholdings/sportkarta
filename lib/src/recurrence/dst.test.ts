import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  addDays,
  expandRrule,
  formatWall,
  instantToWall,
  isoWeekday,
  offsetAt,
  parseRrule,
  SOFIA_TZ,
  WEEKDAY_CODES,
  wallToMs,
  zonedToInstant,
  type WallClock,
} from './index.js';

/**
 * Europe/Sofia DST correctness — the non-negotiable requirement of
 * docs/ROADMAP.md §6 ("Europe/Sofia DST property tests (non-negotiable)").
 *
 * These are pure, so they run everywhere and are never skipped. The DST
 * transitions are DISCOVERED from the tz database rather than hardcoded, so the
 * suite keeps testing the real boundaries if the rules ever change, and it
 * covers every late-March and late-October crossing from 2020 to 2035 rather
 * than one cherry-picked pair.
 *
 * The bug every one of these exists to catch: expanding a recurrence by adding
 * 7 × 86 400 000 ms to an INSTANT. That is right for 50 weeks of the year and
 * silently moves every session by an hour for the other two.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface Transition {
  /** Instant of the change. */
  atMs: number;
  offsetBeforeMs: number;
  offsetAfterMs: number;
  /** Positive when clocks go forward (spring), negative in autumn. */
  deltaMs: number;
}

/**
 * Every Europe/Sofia offset change in [from, to), found by scanning day by day
 * and then bisecting to the exact minute. No hardcoded dates — if the EU ever
 * abolishes DST, this simply finds fewer transitions and the properties below
 * still have to hold.
 */
function findTransitions(fromYear: number, toYear: number): Transition[] {
  const out: Transition[] = [];
  let cursor = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear, 0, 1);
  let previous = offsetAt(cursor, SOFIA_TZ);

  while (cursor < end) {
    const next = cursor + DAY_MS;
    const offset = offsetAt(next, SOFIA_TZ);
    if (offset !== previous) {
      let lo = cursor;
      let hi = next;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000;
        if (mid === lo) break;
        if (offsetAt(mid, SOFIA_TZ) === previous) lo = mid;
        else hi = mid;
      }
      out.push({
        atMs: hi,
        offsetBeforeMs: previous,
        offsetAfterMs: offset,
        deltaMs: offset - previous,
      });
      previous = offset;
    }
    cursor = next;
  }
  return out;
}

const TRANSITIONS = findTransitions(2020, 2036);
const SPRING = TRANSITIONS.filter((t) => t.deltaMs > 0);
const AUTUMN = TRANSITIONS.filter((t) => t.deltaMs < 0);

/** The civil date a transition happens on, in local terms. */
function localDateOf(transition: Transition): WallClock {
  // One minute after the change is unambiguously on the new side.
  return instantToWall(transition.atMs + 60_000, SOFIA_TZ);
}

describe('Europe/Sofia DST transitions (discovered from the tz database)', () => {
  it('finds two transitions a year, in late March and late October', () => {
    expect(SPRING.length).toBe(16);
    expect(AUTUMN.length).toBe(16);
    for (const transition of SPRING) {
      const date = localDateOf(transition);
      expect(date.month).toBe(3);
      expect(date.day).toBeGreaterThanOrEqual(25);
      expect(isoWeekday(date)).toBe(7); // last Sunday
      expect(transition.deltaMs).toBe(HOUR_MS);
    }
    for (const transition of AUTUMN) {
      const date = localDateOf(transition);
      expect(date.month).toBe(10);
      expect(date.day).toBeGreaterThanOrEqual(25);
      expect(isoWeekday(date)).toBe(7);
      expect(transition.deltaMs).toBe(-HOUR_MS);
    }
  });

  it('is EET (+2) in winter and EEST (+3) in summer', () => {
    expect(offsetAt(Date.UTC(2026, 0, 15), SOFIA_TZ)).toBe(2 * HOUR_MS);
    expect(offsetAt(Date.UTC(2026, 6, 15), SOFIA_TZ)).toBe(3 * HOUR_MS);
  });
});

describe('wall clock ⇄ instant', () => {
  it('round-trips every unambiguous local reading (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TRANSITIONS.length - 1 }),
        // Any minute in the ±10 days around a transition, excluding the hour
        // that the transition itself makes special (covered separately below).
        fc.integer({ min: -10 * 24 * 60, max: 10 * 24 * 60 }),
        (index, minutesFromTransition) => {
          const transition = TRANSITIONS[index] as Transition;
          const instantMs = transition.atMs + minutesFromTransition * 60_000;
          const wall = instantToWall(instantMs, SOFIA_TZ);
          const resolved = zonedToInstant(wall, SOFIA_TZ);
          // Whatever the case, the result is a REAL instant reading as that
          // wall clock: no instant taken from the zone can ever come back as a
          // gap, and none can drift to a different local reading.
          expect(resolved.resolution).not.toBe('gap_shifted');
          expect(instantToWall(resolved.instantMs, SOFIA_TZ)).toEqual(wall);
          if (resolved.resolution === 'exact') {
            // Unambiguous readings round-trip exactly.
            expect(resolved.instantMs).toBe(instantMs);
          } else {
            // The repeated autumn hour: the engine always picks the earlier of
            // the two, so an instant from the first pass comes back unchanged
            // and one from the second pass moves back by exactly the fold.
            expect(resolved.resolution).toBe('fold_first');
            expect(resolved.instantMs).toBeLessThanOrEqual(instantMs);
            expect([0, HOUR_MS]).toContain(instantMs - resolved.instantMs);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('shifts a nonexistent spring reading forward by the gap (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: SPRING.length - 1 }),
        fc.integer({ min: 0, max: 59 }),
        (index, minute) => {
          const transition = SPRING[index] as Transition;
          // The local hour that vanishes starts at the pre-transition offset's
          // reading of the transition instant (03:00 in Bulgaria).
          const gapStart = instantToWall(transition.atMs - 60_000, SOFIA_TZ);
          const missing: WallClock = {
            ...gapStart,
            hour: gapStart.hour + 1,
            minute,
          };
          const resolved = zonedToInstant(missing, SOFIA_TZ);
          expect(resolved.resolution).toBe('gap_shifted');
          // Forward by exactly the gap: 03:30 → 04:30, never backwards and
          // never onto the transition instant itself.
          expect(resolved.instantMs).toBe(wallToMs(missing) - transition.offsetBeforeMs);
          expect(resolved.wall.hour).toBe(missing.hour + transition.deltaMs / HOUR_MS);
          expect(resolved.wall.minute).toBe(minute);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('takes the FIRST of the two autumn readings (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: AUTUMN.length - 1 }),
        fc.integer({ min: 0, max: 59 }),
        (index, minute) => {
          const transition = AUTUMN[index] as Transition;
          // The repeated hour reads the same before and after the change.
          const repeated: WallClock = {
            ...instantToWall(transition.atMs, SOFIA_TZ),
            minute,
          };
          const resolved = zonedToInstant(repeated, SOFIA_TZ);
          expect(resolved.resolution).toBe('fold_first');

          const first = wallToMs(repeated) - transition.offsetBeforeMs;
          const second = wallToMs(repeated) - transition.offsetAfterMs;
          expect(second - first).toBe(HOUR_MS);
          expect(resolved.instantMs).toBe(first);
          // Both are real instants that read as this wall clock; we picked one,
          // so the session happens once, not twice.
          expect(instantToWall(first, SOFIA_TZ)).toEqual(repeated);
          expect(instantToWall(second, SOFIA_TZ)).toEqual(repeated);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('recurrence across DST', () => {
  /** A weekly rule anchored `weeksBefore` weeks ahead of a transition. */
  function seriesAround(transition: Transition, hour: number, minute: number, weeksBefore = 3) {
    const local = localDateOf(transition);
    const dtstart: WallClock = { ...addDays(local, -7 * weeksBefore), hour, minute };
    return dtstart;
  }

  it('keeps the local time-of-day fixed across every transition (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TRANSITIONS.length - 1 }),
        // Any hour outside 02:00–04:59, where the gap/fold policies apply.
        fc.oneof(fc.integer({ min: 5, max: 23 }), fc.integer({ min: 0, max: 1 })),
        fc.constantFrom(0, 15, 30, 45),
        fc.constantFrom('FREQ=WEEKLY', 'FREQ=DAILY', 'FREQ=WEEKLY;BYDAY=TU,TH'),
        (index, hour, minute, rrule) => {
          const transition = TRANSITIONS[index] as Transition;
          const dtstart = seriesAround(transition, hour, minute);
          const occurrences = expandRrule(
            { dtstart, timeZone: SOFIA_TZ, durationMinutes: 90, rrule },
            {
              from: new Date(transition.atMs - 21 * DAY_MS),
              to: new Date(transition.atMs + 21 * DAY_MS),
            },
          );
          expect(occurrences.length).toBeGreaterThan(0);
          for (const occurrence of occurrences) {
            // THE property: the wall clock never moves, whatever the offset did.
            expect(occurrence.wall.hour).toBe(hour);
            expect(occurrence.wall.minute).toBe(minute);
            expect(occurrence.resolution).toBe('exact');
            // …and the stored instant really does read back as that wall clock.
            expect(instantToWall(occurrence.startsAt.getTime(), SOFIA_TZ)).toEqual(occurrence.wall);
          }
          // Which means the UTC instants across the transition are NOT a
          // constant stride apart — the thing a naive implementation gets wrong.
          const strides = occurrences
            .slice(1)
            .map(
              (o, i) =>
                o.startsAt.getTime() -
                (occurrences[i] as (typeof occurrences)[0]).startsAt.getTime(),
            );
          const crossing = strides.some((s) => s !== strides[0]);
          if (occurrences.length > 2) expect(crossing).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('spaces daily occurrences 23h or 25h apart exactly on a transition day', () => {
    for (const transition of TRANSITIONS) {
      const dtstart = seriesAround(transition, 18, 0, 1);
      const occurrences = expandRrule(
        { dtstart, timeZone: SOFIA_TZ, durationMinutes: 60, rrule: 'FREQ=DAILY' },
        {
          from: new Date(transition.atMs - 8 * DAY_MS),
          to: new Date(transition.atMs + 8 * DAY_MS),
        },
      );
      const gaps = occurrences
        .slice(1)
        .map(
          (o, i) =>
            o.startsAt.getTime() - (occurrences[i] as (typeof occurrences)[0]).startsAt.getTime(),
        );
      const oddGaps = gaps.filter((g) => g !== DAY_MS);
      // Exactly one pair straddles the change, and it is short or long by
      // exactly the transition delta.
      expect(oddGaps).toEqual([DAY_MS - transition.deltaMs]);
    }
  });

  it('holds the duration in elapsed time, not wall clock, across the gap', () => {
    const spring = SPRING[6] as Transition;
    const local = localDateOf(spring);
    const dtstart: WallClock = { ...addDays(local, -7), hour: 2, minute: 30 };
    const [occurrence] = expandRrule(
      { dtstart, timeZone: SOFIA_TZ, durationMinutes: 120, rrule: 'FREQ=WEEKLY' },
      { from: new Date(spring.atMs - DAY_MS), to: new Date(spring.atMs + DAY_MS) },
    );
    expect(occurrence).toBeDefined();
    const session = occurrence as NonNullable<typeof occurrence>;
    // A 02:30 start on the spring night: two hours of play is two hours, even
    // though the clock reads 05:30 at the end rather than 04:30.
    expect(session.endsAt.getTime() - session.startsAt.getTime()).toBe(2 * HOUR_MS);
    expect(instantToWall(session.endsAt.getTime(), SOFIA_TZ).hour).toBe(5);
  });

  it('reports gap_shifted for a session inside the vanished hour', () => {
    const spring = SPRING[6] as Transition;
    const local = localDateOf(spring);
    const dtstart: WallClock = { ...addDays(local, -14), hour: 3, minute: 30 };
    const occurrences = expandRrule(
      { dtstart, timeZone: SOFIA_TZ, durationMinutes: 60, rrule: 'FREQ=WEEKLY' },
      { from: new Date(spring.atMs - 20 * DAY_MS), to: new Date(spring.atMs + 20 * DAY_MS) },
    );
    const shifted = occurrences.filter((o) => o.resolution === 'gap_shifted');
    expect(shifted).toHaveLength(1);
    expect((shifted[0] as (typeof occurrences)[0]).wall.hour).toBe(4);
    // Every other week is untouched — one impossible reading must not move the
    // rest of the series.
    for (const other of occurrences.filter((o) => o.resolution !== 'gap_shifted')) {
      expect(other.wall.hour).toBe(3);
      expect(other.wall.minute).toBe(30);
    }
  });

  it('reports fold_first for a session inside the repeated hour', () => {
    const autumn = AUTUMN[6] as Transition;
    const local = localDateOf(autumn);
    const repeatedHour = instantToWall(autumn.atMs, SOFIA_TZ).hour;
    const dtstart: WallClock = { ...addDays(local, -14), hour: repeatedHour, minute: 30 };
    const occurrences = expandRrule(
      { dtstart, timeZone: SOFIA_TZ, durationMinutes: 60, rrule: 'FREQ=WEEKLY' },
      { from: new Date(autumn.atMs - 20 * DAY_MS), to: new Date(autumn.atMs + 20 * DAY_MS) },
    );
    const folded = occurrences.filter((o) => o.resolution === 'fold_first');
    expect(folded).toHaveLength(1);
    // It happens once, at the earlier of the two candidate instants.
    const foldedOccurrence = folded[0] as (typeof occurrences)[0];
    expect(offsetAt(foldedOccurrence.startsAt.getTime(), SOFIA_TZ)).toBe(autumn.offsetBeforeMs);
    expect(
      occurrences.filter((o) => o.wall.hour === repeatedHour && o.wall.minute === 30).length,
    ).toBe(occurrences.length);
  });

  it('is strictly increasing with no repeated local reading (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TRANSITIONS.length - 1 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 1, max: 3 }),
        fc.subarray([...WEEKDAY_CODES], { minLength: 1 }),
        (index, hour, interval, days) => {
          const transition = TRANSITIONS[index] as Transition;
          const dtstart = seriesAround(transition, hour, 0, 6);
          const rrule = `FREQ=WEEKLY;INTERVAL=${String(interval)};BYDAY=${days.join(',')}`;
          const occurrences = expandRrule(
            { dtstart, timeZone: SOFIA_TZ, durationMinutes: 60, rrule },
            {
              from: new Date(transition.atMs - 40 * DAY_MS),
              to: new Date(transition.atMs + 40 * DAY_MS),
            },
          );
          const seen = new Set<string>();
          let previous = -Infinity;
          for (const occurrence of occurrences) {
            expect(occurrence.startsAt.getTime()).toBeGreaterThan(previous);
            previous = occurrence.startsAt.getTime();
            const key = formatWall(occurrence.wall);
            expect(seen.has(key)).toBe(false);
            seen.add(key);
            expect(
              (days as string[]).includes(WEEKDAY_CODES[isoWeekday(occurrence.wall) - 1] as string),
            ).toBe(true);
          }
        },
      ),
      { numRuns: 250 },
    );
  });

  it('splitting the window changes nothing (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: TRANSITIONS.length - 1 }),
        fc.integer({ min: 0, max: 23 }),
        fc.constantFrom('FREQ=DAILY', 'FREQ=WEEKLY;BYDAY=MO,WE,FR', 'FREQ=WEEKLY;INTERVAL=2'),
        fc.integer({ min: -20, max: 20 }),
        (index, hour, rrule, splitDays) => {
          const transition = TRANSITIONS[index] as Transition;
          const dtstart = seriesAround(transition, hour, 0, 8);
          const series = { dtstart, timeZone: SOFIA_TZ, durationMinutes: 60, rrule };
          const from = new Date(transition.atMs - 30 * DAY_MS);
          const to = new Date(transition.atMs + 30 * DAY_MS);
          const split = new Date(transition.atMs + splitDays * DAY_MS);

          const whole = expandRrule(series, { from, to }).map((o) => o.startsAt.getTime());
          const halves = [
            ...expandRrule(series, { from, to: split }),
            ...expandRrule(series, { from: split, to }),
          ].map((o) => o.startsAt.getTime());
          // This is exactly what lets the materializer run on a rolling window
          // and top up incrementally without ever duplicating or losing one.
          expect(halves).toEqual(whole);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('rrule parsing', () => {
  it('accepts the supported subset', () => {
    expect(parseRrule('FREQ=WEEKLY;BYDAY=TU,TH')).toEqual({
      freq: 'WEEKLY',
      interval: 1,
      byDay: [2, 4],
      count: undefined,
      untilMs: undefined,
    });
    expect(parseRrule('FREQ=DAILY;INTERVAL=3;COUNT=10').interval).toBe(3);
    expect(parseRrule('FREQ=WEEKLY;UNTIL=20261231T235959Z').untilMs).toBe(
      Date.UTC(2026, 11, 31, 23, 59, 59),
    );
  });

  it('rejects everything outside it, with a slug', () => {
    const cases: [string, string][] = [
      ['FREQ=MONTHLY;BYDAY=1SA', 'rrule_unsupported_freq'],
      ['FREQ=YEARLY', 'rrule_unsupported_freq'],
      ['FREQ=WEEKLY;BYSETPOS=-1', 'rrule_unsupported_part'],
      ['FREQ=WEEKLY;BYMONTHDAY=15', 'rrule_unsupported_part'],
      ['FREQ=DAILY;BYDAY=MO', 'rrule_byday_requires_weekly'],
      ['FREQ=WEEKLY;BYDAY=1SA', 'rrule_byday_invalid'],
      ['FREQ=WEEKLY;COUNT=5;UNTIL=20261231T235959Z', 'rrule_count_and_until'],
      ['FREQ=WEEKLY;WKST=SU', 'rrule_wkst_unsupported'],
      ['FREQ=WEEKLY;INTERVAL=0', 'rrule_interval_range'],
      ['FREQ=WEEKLY;INTERVAL=1;INTERVAL=2', 'rrule_duplicate_part'],
      ['FREQ=WEEKLY;UNTIL=20260231T000000Z', 'rrule_until_invalid'],
      ['INTERVAL=2', 'rrule_syntax'],
      ['', 'rrule_empty'],
    ];
    for (const [text, code] of cases) {
      expect(() => parseRrule(text), text).toThrowError(code);
    }
  });

  it('counts from DTSTART, not from the window', () => {
    const dtstart: WallClock = { year: 2026, month: 1, day: 5, hour: 18, minute: 0 };
    const series = {
      dtstart,
      timeZone: SOFIA_TZ,
      durationMinutes: 60,
      rrule: 'FREQ=WEEKLY;COUNT=3',
    };
    // A window that starts after the second occurrence still sees only the
    // third — COUNT is a property of the series, not of the query.
    const all = expandRrule(series, { from: new Date(0), to: new Date(Date.UTC(2027, 0, 1)) });
    expect(all).toHaveLength(3);
    const late = expandRrule(series, {
      from: new Date(Date.UTC(2026, 0, 15)),
      to: new Date(Date.UTC(2027, 0, 1)),
    });
    expect(late).toHaveLength(1);
    expect(late[0]?.wall.day).toBe(19);
  });

  it('stays aligned to DTSTART when fast-forwarding over years (property)', () => {
    // Expansion skips whole INTERVAL steps to reach the window instead of
    // walking from DTSTART, so a decade-old daily series costs the same as a
    // new one. The skip must land on the rule's own grid — an off-by-one here
    // would silently shift an entire series by a day.
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 2015, max: 2024 }),
        fc.integer({ min: 0, max: 300 }),
        (interval, startYear, windowOffsetDays) => {
          const dtstart: WallClock = { year: startYear, month: 1, day: 1, hour: 20, minute: 0 };
          const from = new Date(Date.UTC(2026, 0, 1) + windowOffsetDays * DAY_MS);
          const occurrences = expandRrule(
            {
              dtstart,
              timeZone: SOFIA_TZ,
              durationMinutes: 60,
              rrule: `FREQ=DAILY;INTERVAL=${String(interval)}`,
            },
            { from, to: new Date(from.getTime() + 30 * DAY_MS) },
          );
          expect(occurrences.length).toBeGreaterThan(0);
          for (const occurrence of occurrences) {
            // Every date is a whole number of INTERVAL days after DTSTART, in
            // CIVIL days — the grid DST cannot perturb.
            const civilDays = Math.round((wallToMs(occurrence.wall) - wallToMs(dtstart)) / DAY_MS);
            expect(civilDays % interval).toBe(0);
            expect(occurrence.wall.hour).toBe(20);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('treats a series with no rule as a single occurrence', () => {
    const dtstart: WallClock = { year: 2026, month: 5, day: 1, hour: 9, minute: 0 };
    const occurrences = expandRrule(
      { dtstart, timeZone: SOFIA_TZ, durationMinutes: 45, rrule: null },
      { from: new Date(0), to: new Date(Date.UTC(2030, 0, 1)) },
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.wall).toEqual(dtstart);
  });

  it('never emits a BYDAY occurrence before DTSTART', () => {
    // DTSTART is a Wednesday; MO of that same week precedes the series.
    const dtstart: WallClock = { year: 2026, month: 4, day: 8, hour: 19, minute: 0 };
    const occurrences = expandRrule(
      { dtstart, timeZone: SOFIA_TZ, durationMinutes: 60, rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' },
      { from: new Date(0), to: new Date(Date.UTC(2026, 3, 20)) },
    );
    expect(occurrences.map((o) => `${String(o.wall.day)}`)).toEqual(['8', '13', '15']);
  });
});
