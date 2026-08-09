import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  addDays,
  instantToWall,
  isoWeekday,
  offsetAt,
  SOFIA_TZ,
  zonedToInstant,
  type WallClock,
} from '../recurrence/index.js';

import {
  bucketKeyFor,
  formatCivilDate,
  freezeCandidate,
  nextBucketKey,
  previousBucketKey,
  STREAK_FREEZE_CAP_PER_YEAR,
  streakBuckets,
  summarizeStreak,
  type Timed,
} from './streaks.js';

/**
 * DST correctness for passport streaks (docs/ROADMAP.md §7: "DST-correct
 * streaks"), in the same spirit as lib/src/recurrence/dst.test.ts: the
 * transitions are DISCOVERED from the tz database, not hardcoded, so this suite
 * keeps testing the real boundaries if the rules ever change, and it covers
 * every crossing from 2020 to 2035 rather than one cherry-picked pair.
 *
 * The bugs these exist to catch, all silent in production:
 *
 *  - bucketing an instant by its UTC date, which moves evening activity (most
 *    of amateur sport) into the wrong Sofia day;
 *  - advancing a day with `+ 86_400_000` ms, which is wrong exactly twice a
 *    year and therefore never noticed in testing;
 *  - answering "is the streak alive" with the server's local calendar.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface Transition {
  atMs: number;
  offsetBeforeMs: number;
  offsetAfterMs: number;
  /** Positive when clocks go forward (spring), negative in autumn. */
  deltaMs: number;
}

/** Every Europe/Sofia offset change in [from, to), by daily scan then bisection. */
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

function at(iso: string): Timed {
  return { at: new Date(iso) };
}

/** Local midnight on the civil day a transition falls on. */
function transitionDay(transition: Transition): WallClock {
  const wall = instantToWall(transition.atMs + 60_000, SOFIA_TZ);
  return { ...wall, hour: 0, minute: 0 };
}

describe('civil day bucketing', () => {
  it('reads the Sofia calendar, not the UTC one', () => {
    // 22:30Z in winter is 00:30 the next day in Sofia (EET, +2).
    expect(bucketKeyFor(new Date('2026-01-05T22:30:00Z'), 'day')).toBe('2026-01-06');
    // 21:30Z in summer is 00:30 the next day (EEST, +3).
    expect(bucketKeyFor(new Date('2026-07-05T21:30:00Z'), 'day')).toBe('2026-07-06');
    // …and an hour earlier, both are still the same Sofia day.
    expect(bucketKeyFor(new Date('2026-01-05T21:30:00Z'), 'day')).toBe('2026-01-05');
    expect(bucketKeyFor(new Date('2026-07-05T20:30:00Z'), 'day')).toBe('2026-07-05');
  });

  it('puts both sides of every transition on the correct civil day (property)', () => {
    for (const transition of TRANSITIONS) {
      const day = formatCivilDate(transitionDay(transition));
      // A minute before and a minute after the change are the same Sofia day:
      // the clocks move at 03:00/04:00 local, in the middle of that day.
      expect(bucketKeyFor(new Date(transition.atMs - 60_000), 'day')).toBe(day);
      expect(bucketKeyFor(new Date(transition.atMs + 60_000), 'day')).toBe(day);
    }
  });

  it('never lets a bucket span more than one civil day, whatever the offset', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 16 * 365 * 24 * 60 }), (minutesFrom2020) => {
        const instant = new Date(Date.UTC(2020, 0, 1) + minutesFrom2020 * 60_000);
        const key = bucketKeyFor(instant, 'day');
        const wall = instantToWall(instant.getTime(), SOFIA_TZ);
        expect(key).toBe(formatCivilDate(wall));
      }),
      { numRuns: 500 },
    );
  });
});

describe('civil week bucketing', () => {
  it('starts weeks on the Sofia Monday, like the digest does', () => {
    // 2026-07-23 is a Thursday; its week starts Monday 2026-07-20.
    expect(bucketKeyFor(new Date('2026-07-23T12:00:00Z'), 'week')).toBe('2026-07-20');
    // Sunday night 21:30Z is already Monday in Sofia, so it belongs to the NEXT week.
    expect(bucketKeyFor(new Date('2026-07-19T21:30:00Z'), 'week')).toBe('2026-07-20');
    expect(bucketKeyFor(new Date('2026-07-19T20:30:00Z'), 'week')).toBe('2026-07-13');
  });

  it('every week key is a Monday (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 16 * 365 * 24 }), (hoursFrom2020) => {
        const instant = new Date(Date.UTC(2020, 0, 1) + hoursFrom2020 * HOUR_MS);
        const key = bucketKeyFor(instant, 'week');
        const [year, month, day] = key.split('-').map(Number) as [number, number, number];
        expect(isoWeekday({ year, month, day, hour: 0, minute: 0 })).toBe(1);
      }),
      { numRuns: 500 },
    );
  });
});

describe('successor arithmetic is civil, not elapsed time', () => {
  it('advances one calendar day across every transition (property)', () => {
    for (const transition of TRANSITIONS) {
      const day = formatCivilDate(transitionDay(transition));
      const previous = previousBucketKey(day, 'day');
      expect(nextBucketKey(previous, 'day')).toBe(day);
      expect(previousBucketKey(nextBucketKey(day, 'day'), 'day')).toBe(day);
    }
  });

  it('advances one calendar week across every transition (property)', () => {
    for (const transition of TRANSITIONS) {
      const day = formatCivilDate(transitionDay(transition));
      expect(previousBucketKey(nextBucketKey(day, 'week'), 'week')).toBe(day);
    }
  });
});

describe('streaks across DST transitions', () => {
  /**
   * The headline property. A member active at 20:00 local every day through a
   * transition has an unbroken streak — even though one of those gaps is 23 h
   * and another is 25 h of elapsed time. An implementation that compares
   * instants rather than civil days breaks the March one.
   */
  it('keeps a daily streak unbroken through every transition', () => {
    for (const transition of TRANSITIONS) {
      const day = transitionDay(transition);
      // Five consecutive days at 20:00 LOCAL, centred on the transition day.
      // Built civil-first — the calendar day is stepped with addDays and only
      // then resolved to an instant — so each event really is at 20:00 on the
      // wall, on both sides of the change. The elapsed gaps are 23 h and 25 h.
      const events: Timed[] = [];
      for (let offset = -2; offset <= 2; offset += 1) {
        const evening = { ...addDays(day, offset), hour: 20, minute: 0 };
        events.push({ at: new Date(zonedToInstant(evening, SOFIA_TZ).instantMs) });
      }

      const buckets = streakBuckets(events, 'day');
      expect(buckets).toHaveLength(5);
      expect(buckets.map((bucket) => bucket.runLength)).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('counts the 23-hour spring day and the 25-hour autumn day as exactly one day each', () => {
    for (const transition of TRANSITIONS) {
      // Two events on the transition day itself, on opposite sides of the change.
      const events = [
        { at: new Date(transition.atMs - 60_000) },
        { at: new Date(transition.atMs + 60_000) },
      ];
      const buckets = streakBuckets(events, 'day');
      expect(buckets).toHaveLength(1);
      expect(buckets[0]?.runLength).toBe(1);
      // And the badge date is the EARLIER of the two, not whichever sorted first.
      expect(buckets[0]?.firstAt.getTime()).toBe(transition.atMs - 60_000);
    }
  });

  it('does not merge two distinct days into one across a transition', () => {
    for (const transition of TRANSITIONS) {
      const events = [
        // 12:00 local the day before, and 12:00 local the day after.
        { at: new Date(transition.atMs - 20 * HOUR_MS) },
        { at: new Date(transition.atMs + 30 * HOUR_MS) },
      ];
      const buckets = streakBuckets(events, 'day');
      expect(buckets.length).toBeGreaterThanOrEqual(2);
      expect(new Set(buckets.map((b) => b.key)).size).toBe(buckets.length);
    }
  });
});

describe('summarizeStreak', () => {
  it('is empty for a member who has done nothing', () => {
    expect(summarizeStreak([], 'day', { now: new Date('2026-07-23T09:00:00Z') })).toEqual({
      unit: 'day',
      current: 0,
      longest: 0,
      lastActive: null,
      // Nothing to lose, so nothing is at risk.
      atRisk: false,
    });
  });

  it('collapses several events on one day into a single day', () => {
    const events = [
      at('2026-07-20T06:00:00Z'),
      at('2026-07-20T15:00:00Z'),
      at('2026-07-21T15:00:00Z'),
    ];
    const summary = summarizeStreak(events, 'day', { now: new Date('2026-07-21T18:00:00Z') });
    expect(summary.longest).toBe(2);
    expect(summary.current).toBe(2);
  });

  it('keeps a streak alive while today is still open', () => {
    // Active yesterday, nothing yet today — that is not a broken streak.
    const events = [at('2026-07-20T15:00:00Z'), at('2026-07-21T15:00:00Z')];
    const summary = summarizeStreak(events, 'day', { now: new Date('2026-07-22T09:00:00Z') });
    expect(summary.current).toBe(2);
    expect(summary.lastActive).toBe('2026-07-21');
  });

  it('breaks the streak once a whole day has been missed', () => {
    const events = [at('2026-07-20T15:00:00Z'), at('2026-07-21T15:00:00Z')];
    const summary = summarizeStreak(events, 'day', { now: new Date('2026-07-23T09:00:00Z') });
    expect(summary.current).toBe(0);
    // The record survives the break — this is what a streak badge scores.
    expect(summary.longest).toBe(2);
  });

  it('answers liveness in Sofia time, not the server clock', () => {
    // 21:30Z on the 21st is already the 22nd in Sofia. A member last active on
    // the 20th is therefore two Sofia days back and the streak is over —
    // a UTC-clocked answer would still call it alive.
    const events = [at('2026-07-20T15:00:00Z')];
    expect(summarizeStreak(events, 'day', { now: new Date('2026-07-21T21:30:00Z') }).current).toBe(
      0,
    );
    expect(summarizeStreak(events, 'day', { now: new Date('2026-07-21T20:30:00Z') }).current).toBe(
      1,
    );
  });

  it('tracks the longest run when it is not the current one', () => {
    const events = [
      at('2026-06-01T09:00:00Z'),
      at('2026-06-02T09:00:00Z'),
      at('2026-06-03T09:00:00Z'),
      at('2026-06-04T09:00:00Z'),
      // gap
      at('2026-07-21T09:00:00Z'),
      at('2026-07-22T09:00:00Z'),
    ];
    const summary = summarizeStreak(events, 'day', { now: new Date('2026-07-22T12:00:00Z') });
    expect(summary.longest).toBe(4);
    expect(summary.current).toBe(2);
  });

  it('counts week streaks in Sofia Monday-start weeks', () => {
    const events = [
      at('2026-06-30T17:00:00Z'), // Tue of week starting 2026-06-29
      at('2026-07-07T17:00:00Z'), // week starting 2026-07-06
      at('2026-07-14T17:00:00Z'), // week starting 2026-07-13
      at('2026-07-21T17:00:00Z'), // week starting 2026-07-20
    ];
    const summary = summarizeStreak(events, 'week', { now: new Date('2026-07-23T12:00:00Z') });
    expect(summary.longest).toBe(4);
    expect(summary.current).toBe(4);
  });

  it('keeps a week streak alive through last week and breaks it after that', () => {
    const events = [at('2026-07-14T17:00:00Z'), at('2026-07-21T17:00:00Z')];
    // Now is in the week starting 2026-07-27; last active week is the previous one.
    expect(summarizeStreak(events, 'week', { now: new Date('2026-07-28T12:00:00Z') }).current).toBe(
      2,
    );
    // A week later, a whole week has been missed.
    expect(summarizeStreak(events, 'week', { now: new Date('2026-08-04T12:00:00Z') }).current).toBe(
      0,
    );
  });

  it('is order-independent — events may arrive from the database in any order', () => {
    const events = [
      at('2026-07-22T09:00:00Z'),
      at('2026-07-20T09:00:00Z'),
      at('2026-07-21T09:00:00Z'),
    ];
    const summary = summarizeStreak(events, 'day', { now: new Date('2026-07-22T12:00:00Z') });
    expect(summary).toEqual({
      unit: 'day',
      current: 3,
      longest: 3,
      lastActive: '2026-07-22',
      // Active TODAY, so the open period is already satisfied.
      atRisk: false,
    });
  });

  it('refuses an invalid instant rather than silently bucketing NaN', () => {
    expect(() => streakBuckets([{ at: new Date('nonsense') }], 'day')).toThrow(/invalid instant/);
  });
});

/**
 * Streak freezes («замразяване», ENGAGEMENT.md A4).
 *
 * A frozen period does not break a run. Two properties matter more than the
 * arithmetic, and both are asserted here rather than trusted:
 *
 *  1. A freeze BRIDGES but does not COUNT. It forgives a week you missed; it
 *     must never manufacture one you did not show up for, because the whole
 *     product framing is "reward showing up" (§1.2) and a streak inflated by
 *     absence is the opposite claim.
 *  2. With no freezes, nothing changes at all. The freeze path and the old
 *     adjacency test are the same code (`bridged` with an empty set), so the
 *     DST suite above is still testing the same function it always was.
 */
describe('streak freezes', () => {
  const MON = (day: string): Timed => at(`${day}T09:00:00Z`);

  it('bridges a missed week so the run survives', () => {
    // Active weeks of 6 Jul and 20 Jul; the week of 13 Jul is missed but frozen.
    const events = [MON('2026-07-06'), MON('2026-07-20')];
    const frozen = new Set(['2026-07-13']);
    const summary = summarizeStreak(events, 'week', {
      now: new Date('2026-07-20T12:00:00Z'),
      frozen,
    });
    expect(summary.current).toBe(2);
    expect(summary.longest).toBe(2);
  });

  it('does NOT count the frozen week toward the run', () => {
    // The decisive assertion: two weeks of real activity with one frozen gap is
    // a streak of TWO, not three. A freeze is forgiveness, not attendance.
    const events = [MON('2026-07-06'), MON('2026-07-20')];
    const summary = summarizeStreak(events, 'week', {
      now: new Date('2026-07-20T12:00:00Z'),
      frozen: new Set(['2026-07-13']),
    });
    expect(summary.current).toBe(2);
  });

  it('breaks the run when the missed week is NOT frozen', () => {
    const events = [MON('2026-07-06'), MON('2026-07-20')];
    const summary = summarizeStreak(events, 'week', {
      now: new Date('2026-07-20T12:00:00Z'),
    });
    expect(summary.current).toBe(1);
    expect(summary.longest).toBe(1);
  });

  it('bridges two consecutive frozen weeks', () => {
    const events = [MON('2026-06-29'), MON('2026-07-20')];
    const summary = summarizeStreak(events, 'week', {
      now: new Date('2026-07-20T12:00:00Z'),
      frozen: new Set(['2026-07-06', '2026-07-13']),
    });
    expect(summary.current).toBe(2);
  });

  it('does not bridge a gap where only SOME of the missed weeks are frozen', () => {
    const events = [MON('2026-06-29'), MON('2026-07-20')];
    const summary = summarizeStreak(events, 'week', {
      now: new Date('2026-07-20T12:00:00Z'),
      frozen: new Set(['2026-07-06']), // 13 Jul still missing
    });
    expect(summary.current).toBe(1);
  });

  it('keeps a run alive when the frozen week is the one just gone', () => {
    // Last activity two weeks ago, last week frozen, this week still open: the
    // member has not broken anything yet.
    const events = [MON('2026-07-06')];
    const summary = summarizeStreak(events, 'week', {
      now: new Date('2026-07-22T12:00:00Z'), // week of 20 Jul, still open
      frozen: new Set(['2026-07-13']),
    });
    expect(summary.current).toBe(1);
    expect(summary.atRisk).toBe(true);
  });

  it('changes nothing when the freeze set is empty', () => {
    const events = [MON('2026-07-06'), MON('2026-07-13'), MON('2026-07-20')];
    const now = new Date('2026-07-20T12:00:00Z');
    expect(summarizeStreak(events, 'week', { now })).toEqual(
      summarizeStreak(events, 'week', { now, frozen: new Set() }),
    );
  });
});

describe('atRisk', () => {
  it('is true when the streak is alive but the open period is still empty', () => {
    const events = [at('2026-07-21T09:00:00Z')]; // yesterday
    const summary = summarizeStreak(events, 'day', {
      now: new Date('2026-07-22T12:00:00Z'),
    });
    expect(summary.current).toBe(1);
    expect(summary.atRisk).toBe(true);
  });

  it('is false once the member has been active in the open period', () => {
    const events = [at('2026-07-21T09:00:00Z'), at('2026-07-22T09:00:00Z')];
    const summary = summarizeStreak(events, 'day', {
      now: new Date('2026-07-22T12:00:00Z'),
    });
    expect(summary.atRisk).toBe(false);
  });

  it('is false for a streak that is already broken — nothing left to lose', () => {
    const events = [at('2026-07-10T09:00:00Z')];
    const summary = summarizeStreak(events, 'day', {
      now: new Date('2026-07-22T12:00:00Z'),
    });
    expect(summary.current).toBe(0);
    expect(summary.atRisk).toBe(false);
  });

  it('is never true while current is zero', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 400 }), { maxLength: 30 }), (offsets) => {
        const base = Date.UTC(2026, 0, 1, 9, 0, 0);
        const events = offsets.map((d) => ({ at: new Date(base + d * 86_400_000) }));
        const summary = summarizeStreak(events, 'day', {
          now: new Date(base + 401 * 86_400_000),
        });
        return summary.current > 0 || !summary.atRisk;
      }),
    );
  });
});

describe('freezeCandidate', () => {
  const W = (day: string): Timed => at(`${day}T09:00:00Z`);
  // Thursday of the week starting Mon 2026-07-20; the week just closed is 13 Jul.
  const NOW = new Date('2026-07-23T12:00:00Z');

  it('forgives the week just closed when a live run would otherwise end', () => {
    // Active 29 Jun and 6 Jul, missed 13 Jul.
    expect(freezeCandidate([W('2026-06-29'), W('2026-07-06')], [], { now: NOW })).toBe('2026-07-13');
  });

  it('returns null when the member was active in that week — nothing to save', () => {
    expect(
      freezeCandidate([W('2026-07-06'), W('2026-07-13')], [], { now: NOW }),
    ).toBeNull();
  });

  it('returns null when no run was in progress — freezes are not handed out for free', () => {
    // Last activity months ago: there is no streak to protect, so spending one
    // of the two would leave the member's first real streak unprotected.
    expect(freezeCandidate([W('2026-03-02')], [], { now: NOW })).toBeNull();
  });

  it('never freezes the week still in progress', () => {
    const candidate = freezeCandidate([W('2026-07-13')], [], { now: NOW });
    // The open week is 2026-07-20; only the closed one may ever be returned.
    expect(candidate).not.toBe('2026-07-20');
  });

  it('is idempotent — a week already frozen is not frozen twice', () => {
    const applied = [{ bucketKey: '2026-07-13', appliedAt: new Date('2026-07-20T00:00:00Z') }];
    expect(freezeCandidate([W('2026-06-29'), W('2026-07-06')], applied, { now: NOW })).toBeNull();
  });

  it('refuses once the rolling-year cap is spent', () => {
    const applied = [
      { bucketKey: '2026-05-04', appliedAt: new Date('2026-05-11T00:00:00Z') },
      { bucketKey: '2026-06-01', appliedAt: new Date('2026-06-08T00:00:00Z') },
    ];
    expect(applied).toHaveLength(STREAK_FREEZE_CAP_PER_YEAR);
    expect(freezeCandidate([W('2026-06-29'), W('2026-07-06')], applied, { now: NOW })).toBeNull();
  });

  it('the cap is ROLLING, so an old freeze stops counting', () => {
    const applied = [
      // Both more than a year before NOW: spent, but no longer counted.
      { bucketKey: '2025-05-05', appliedAt: new Date('2025-05-12T00:00:00Z') },
      { bucketKey: '2025-06-02', appliedAt: new Date('2025-06-09T00:00:00Z') },
    ];
    expect(freezeCandidate([W('2026-06-29'), W('2026-07-06')], applied, { now: NOW })).toBe(
      '2026-07-13',
    );
  });

  it('walks back over an existing freeze to find the run it is protecting', () => {
    // Active 29 Jun, 6 Jul already frozen, 13 Jul missed: the run is still
    // alive through the earlier freeze, so this week is worth saving too.
    const applied = [{ bucketKey: '2026-07-06', appliedAt: new Date('2026-07-13T00:00:00Z') }];
    expect(freezeCandidate([W('2026-06-29')], applied, { now: NOW })).toBe('2026-07-13');
  });

  it('a granted freeze actually keeps the streak alive (end to end, pure)', () => {
    const events = [W('2026-06-29'), W('2026-07-06')];
    // Without the freeze the run is dead by the open week.
    expect(summarizeStreak(events, 'week', { now: NOW }).current).toBe(0);
    const key = freezeCandidate(events, [], { now: NOW });
    expect(key).not.toBeNull();
    const after = summarizeStreak(events, 'week', {
      now: NOW,
      frozen: new Set([key as string]),
    });
    expect(after.current).toBe(2);
    expect(after.atRisk).toBe(true);
  });
});
