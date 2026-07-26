import { describe, expect, it } from 'vitest';

import { LAUNCH_BADGES, LAUNCH_BADGE_SLUGS } from './catalog.js';
import {
  assertValidCatalog,
  evaluateBadge,
  evaluateBadges,
  passportStreaks,
  type BadgeDefinition,
  type PassportEvent,
  type PassportEventKind,
} from './rules.js';

/**
 * Rule evaluation (docs/ROADMAP.md §7, Stage 5.1).
 *
 * The properties that matter are the ones a member would notice and could not
 * be argued out of: a badge appearing one event early or late, a badge dated
 * "now" instead of when it was actually earned, and a badge that silently
 * counts something it should not.
 */

const T0 = Date.UTC(2026, 0, 5, 9, 0); // Mon 2026-01-05 11:00 Sofia
const DAY_MS = 24 * 60 * 60 * 1000;

interface EventOptions {
  facilityId?: string | null;
  municipalityId?: string | null;
  sports?: readonly string[];
  points?: number;
}

/**
 * An event `dayOffset` days after T0, at the same time of day.
 *
 * `facilityId` and `municipalityId` are read with `in` rather than `??`,
 * because an explicit null is a case under test (an event with no place) and
 * `??` would quietly substitute the default for it.
 */
function event(
  kind: PassportEventKind,
  dayOffset: number,
  options: EventOptions = {},
): PassportEvent {
  return {
    kind,
    at: new Date(T0 + dayOffset * DAY_MS),
    facilityId: 'facilityId' in options ? (options.facilityId ?? null) : 'f1',
    municipalityId: 'municipalityId' in options ? (options.municipalityId ?? null) : 'm1',
    sports: options.sports ?? ['football'],
    points: options.points ?? 0,
  };
}

/** `count` of `kind` at `threshold`, for the boundary tests. */
function countBadge(kind: PassportEventKind, threshold: number): BadgeDefinition {
  return {
    slug: 'test_badge',
    group: 'contribution',
    rule: { kind: 'count', events: [kind], threshold },
  };
}

describe('count rules', () => {
  const badge = countBadge('facility_verified', 3);

  it('is unearned one event short, and reports honest progress', () => {
    const state = evaluateBadge(badge, [
      event('facility_verified', 0),
      event('facility_verified', 1),
    ]);
    expect(state.earned).toBe(false);
    expect(state.earnedAt).toBeNull();
    expect(state.progress).toEqual({ have: 2, need: 3 });
  });

  it('is earned exactly on the threshold event', () => {
    const state = evaluateBadge(badge, [
      event('facility_verified', 0),
      event('facility_verified', 1),
      event('facility_verified', 2),
    ]);
    expect(state.earned).toBe(true);
    expect(state.progress).toEqual({ have: 3, need: 3 });
  });

  it('dates the badge at the crossing event, not at evaluation time', () => {
    const state = evaluateBadge(badge, [
      event('facility_verified', 0),
      event('facility_verified', 1),
      event('facility_verified', 2),
      // Later events must not move the date — this is what makes a badge added
      // to the catalogue months from now carry its true historical date.
      event('facility_verified', 40),
      event('facility_verified', 41),
    ]);
    expect(state.earnedAt?.getTime()).toBe(T0 + 2 * DAY_MS);
  });

  it('caps displayed progress at the threshold', () => {
    const events = Array.from({ length: 9 }, (_, i) => event('facility_verified', i));
    expect(evaluateBadge(badge, events).progress).toEqual({ have: 3, need: 3 });
  });

  it('counts only the kinds the rule names', () => {
    const state = evaluateBadge(badge, [
      event('facility_added', 0),
      event('condition_reported', 1),
      event('session_checkin', 2),
      event('facility_verified', 3),
    ]);
    expect(state.progress).toEqual({ have: 1, need: 3 });
  });

  it('sums across kinds when the rule names several', () => {
    const anyContribution: BadgeDefinition = {
      slug: 'test_badge',
      group: 'contribution',
      rule: {
        kind: 'count',
        events: ['facility_added', 'facility_verified', 'condition_reported'],
        threshold: 3,
      },
    };
    const state = evaluateBadge(anyContribution, [
      event('facility_added', 0),
      event('facility_verified', 1),
      event('session_checkin', 2), // not a contribution
      event('condition_reported', 3),
    ]);
    expect(state.earned).toBe(true);
    expect(state.earnedAt?.getTime()).toBe(T0 + 3 * DAY_MS);
  });

  it('is order-independent — the database may return any order', () => {
    const events = [
      event('facility_verified', 2),
      event('facility_verified', 0),
      event('facility_verified', 1),
    ];
    expect(evaluateBadge(badge, events).earnedAt?.getTime()).toBe(T0 + 2 * DAY_MS);
  });

  it('is empty, not earned, for a member who has done nothing', () => {
    const state = evaluateBadge(badge, []);
    expect(state).toMatchObject({ earned: false, earnedAt: null, progress: { have: 0, need: 3 } });
  });

  it('earns a threshold-1 badge on the very first event', () => {
    const first = countBadge('session_checkin', 1);
    const state = evaluateBadge(first, [event('session_checkin', 0)]);
    expect(state.earned).toBe(true);
    expect(state.earnedAt?.getTime()).toBe(T0);
  });
});

describe('distinct rules', () => {
  const municipalities: BadgeDefinition = {
    slug: 'test_badge',
    group: 'contribution',
    rule: {
      kind: 'distinct',
      events: ['facility_added', 'facility_verified', 'condition_reported'],
      dimension: 'municipality',
      threshold: 3,
    },
  };

  it('counts distinct values, not events', () => {
    const state = evaluateBadge(municipalities, [
      event('facility_verified', 0, { municipalityId: 'sofia' }),
      event('facility_verified', 1, { municipalityId: 'sofia' }),
      event('facility_verified', 2, { municipalityId: 'sofia' }),
      event('facility_verified', 3, { municipalityId: 'plovdiv' }),
    ]);
    expect(state.earned).toBe(false);
    expect(state.progress).toEqual({ have: 2, need: 3 });
  });

  it('is earned by the event that introduces the final distinct value', () => {
    const state = evaluateBadge(municipalities, [
      event('facility_verified', 0, { municipalityId: 'sofia' }),
      event('facility_verified', 1, { municipalityId: 'plovdiv' }),
      event('facility_verified', 5, { municipalityId: 'varna' }),
      event('facility_verified', 9, { municipalityId: 'burgas' }),
    ]);
    expect(state.earnedAt?.getTime()).toBe(T0 + 5 * DAY_MS);
  });

  it('ignores events with no value in that dimension', () => {
    const state = evaluateBadge(municipalities, [
      event('facility_verified', 0, { municipalityId: null }),
      event('facility_verified', 1, { municipalityId: null }),
    ]);
    expect(state.progress).toEqual({ have: 0, need: 3 });
  });

  it('counts every sport a multi-sport facility carries', () => {
    const sports: BadgeDefinition = {
      slug: 'test_badge',
      group: 'contribution',
      rule: {
        kind: 'distinct',
        events: ['facility_added'],
        dimension: 'sport',
        threshold: 5,
      },
    };
    const state = evaluateBadge(sports, [
      event('facility_added', 0, { sports: ['football', 'basketball'] }),
      // One event crosses the line by more than one — the badge is still dated
      // to it, and is not skipped for want of an exact equality.
      event('facility_added', 3, { sports: ['tennis', 'volleyball', 'running', 'fitness'] }),
    ]);
    expect(state.earned).toBe(true);
    expect(state.earnedAt?.getTime()).toBe(T0 + 3 * DAY_MS);
    expect(state.progress).toEqual({ have: 5, need: 5 });
  });

  it('de-duplicates repeated sports on the same facility', () => {
    const sports: BadgeDefinition = {
      slug: 'test_badge',
      group: 'contribution',
      rule: { kind: 'distinct', events: ['facility_added'], dimension: 'sport', threshold: 3 },
    };
    const state = evaluateBadge(sports, [
      event('facility_added', 0, { sports: ['football', 'football', 'football'] }),
    ]);
    expect(state.progress).toEqual({ have: 1, need: 3 });
  });

  it('counts distinct Sofia days, not distinct instants', () => {
    const days: BadgeDefinition = {
      slug: 'test_badge',
      group: 'contribution',
      rule: { kind: 'distinct', events: ['session_checkin'], dimension: 'day', threshold: 2 },
    };
    const twiceOneDay = [
      { ...event('session_checkin', 0), at: new Date('2026-01-05T08:00:00Z') },
      { ...event('session_checkin', 0), at: new Date('2026-01-05T18:00:00Z') },
    ];
    expect(evaluateBadge(days, twiceOneDay).progress).toEqual({ have: 1, need: 2 });

    // 21:30Z is still the same Sofia day in winter; 22:30Z is the next one.
    const acrossMidnight = [
      { ...event('session_checkin', 0), at: new Date('2026-01-05T21:30:00Z') },
      { ...event('session_checkin', 0), at: new Date('2026-01-05T22:30:00Z') },
    ];
    expect(evaluateBadge(days, acrossMidnight).earned).toBe(true);
  });
});

describe('streak rules', () => {
  const sevenDays: BadgeDefinition = {
    slug: 'test_badge',
    group: 'participation',
    rule: {
      kind: 'streak',
      events: ['facility_added', 'facility_verified', 'condition_reported', 'session_checkin'],
      unit: 'day',
      threshold: 7,
    },
  };

  it('is unearned at six consecutive days', () => {
    const events = Array.from({ length: 6 }, (_, i) => event('session_checkin', i));
    const state = evaluateBadge(sevenDays, events);
    expect(state.earned).toBe(false);
    expect(state.progress).toEqual({ have: 6, need: 7 });
  });

  it('is earned on the seventh consecutive day, dated to that day’s first event', () => {
    const events = Array.from({ length: 7 }, (_, i) => event('session_checkin', i));
    // A second event later on the seventh day must not become the earn date.
    events.push({ ...event('session_checkin', 6), at: new Date(T0 + 6 * DAY_MS + 6 * 3600_000) });
    const state = evaluateBadge(sevenDays, events);
    expect(state.earned).toBe(true);
    expect(state.earnedAt?.getTime()).toBe(T0 + 6 * DAY_MS);
  });

  it('resets after a missed day and scores the longest run, not the total', () => {
    const events = [
      ...Array.from({ length: 4 }, (_, i) => event('session_checkin', i)),
      // day 4 missed
      ...Array.from({ length: 5 }, (_, i) => event('session_checkin', 5 + i)),
    ];
    const state = evaluateBadge(sevenDays, events);
    expect(state.earned).toBe(false);
    expect(state.progress).toEqual({ have: 5, need: 7 });
  });

  it('keeps a badge once earned, even after the streak breaks', () => {
    const events = [
      ...Array.from({ length: 7 }, (_, i) => event('session_checkin', i)),
      event('session_checkin', 30),
    ];
    const state = evaluateBadge(sevenDays, events);
    expect(state.earned).toBe(true);
    expect(state.earnedAt?.getTime()).toBe(T0 + 6 * DAY_MS);
  });

  it('counts only qualifying kinds towards a participation streak', () => {
    const weeks: BadgeDefinition = {
      slug: 'test_badge',
      group: 'participation',
      rule: { kind: 'streak', events: ['session_checkin'], unit: 'week', threshold: 2 },
    };
    // Contributions in the intervening week must not bridge the gap.
    const state = evaluateBadge(weeks, [
      event('session_checkin', 0),
      event('facility_verified', 7),
      event('session_checkin', 14),
    ]);
    expect(state.earned).toBe(false);
    expect(state.progress).toEqual({ have: 1, need: 2 });
  });
});

describe('passportStreaks', () => {
  it('reports days over everything and weeks over check-ins only', () => {
    const events = [
      event('facility_verified', 0),
      event('facility_verified', 1),
      event('session_checkin', 2),
    ];
    const streaks = passportStreaks(events, { now: new Date(T0 + 2 * DAY_MS + 3600_000) });
    expect(streaks.days.current).toBe(3);
    expect(streaks.weeks.current).toBe(1);
  });
});

describe('evaluateBadges over the launch catalogue', () => {
  it('returns one state per badge, in catalogue order', () => {
    const states = evaluateBadges(LAUNCH_BADGES, []);
    expect(states.map((state) => state.slug)).toEqual(LAUNCH_BADGE_SLUGS);
    expect(states.every((state) => !state.earned)).toBe(true);
  });

  it('grants the first-step badges to a member with one contribution and one game', () => {
    const states = evaluateBadges(LAUNCH_BADGES, [
      event('facility_added', 0),
      event('session_checkin', 0),
    ]);
    const earned = states.filter((state) => state.earned).map((state) => state.slug);
    expect(earned).toEqual(['first_contribution', 'first_game']);
  });

  it('never awards a comparative badge — nothing in the catalogue ranks members', () => {
    // Honoured structurally: a rule can only read the member's own stream, so
    // there is no shape in the grammar that could express "more than other
    // people" — a badge on a public passport therefore never publishes anybody
    // else's position.
    for (const badge of LAUNCH_BADGES) {
      expect(['count', 'distinct', 'streak']).toContain(badge.rule.kind);
    }
  });
});

describe('assertValidCatalog', () => {
  it('accepts the launch catalogue', () => {
    expect(() => assertValidCatalog(LAUNCH_BADGES)).not.toThrow();
  });

  it('has ten launch badges, mixing contribution and participation', () => {
    expect(LAUNCH_BADGES).toHaveLength(10);
    const groups = LAUNCH_BADGES.map((badge) => badge.group);
    expect(groups.filter((group) => group === 'contribution').length).toBeGreaterThan(0);
    expect(groups.filter((group) => group === 'participation').length).toBeGreaterThan(0);
  });

  it('rejects a duplicate slug', () => {
    expect(() =>
      assertValidCatalog([countBadge('session_checkin', 1), countBadge('facility_added', 1)]),
    ).toThrow(/duplicate badge slug/);
  });

  it('rejects a badge that can never be earned', () => {
    expect(() =>
      assertValidCatalog([
        {
          slug: 'nothing',
          group: 'contribution',
          rule: { kind: 'count', events: [], threshold: 1 },
        },
      ]),
    ).toThrow(/never be earned/);
  });

  it('rejects an unknown event kind arriving from config', () => {
    expect(() =>
      assertValidCatalog([
        {
          slug: 'bogus',
          group: 'contribution',
          rule: {
            kind: 'count',
            events: ['facility_deleted' as PassportEventKind],
            threshold: 1,
          },
        },
      ]),
    ).toThrow(/unknown event kind/);
  });

  it('rejects a non-positive or fractional threshold', () => {
    expect(() => assertValidCatalog([countBadge('session_checkin', 0)])).toThrow(/threshold/);
    expect(() => assertValidCatalog([countBadge('session_checkin', 2.5)])).toThrow(/threshold/);
  });

  it('rejects a slug that is not a stable identifier', () => {
    expect(() =>
      assertValidCatalog([{ ...countBadge('session_checkin', 1), slug: 'Първа крачка' }]),
    ).toThrow(/stable identifier/);
  });
});

describe('attendance is counted once (Stage 5.4)', () => {
  it('no catalogue rule scores the PAYMENT for attending, only the fact', () => {
    // A QR check-in writes both a play_session_checkins row (`session_checkin`)
    // and a points_ledger row (`session_attended`). A rule naming both would
    // count one evening twice; a rule naming only `session_attended` would
    // silently stop counting the attendances that hit the daily cap or came
    // from a member who declined the location prompt. Participation badges
    // count turning up.
    const offenders = LAUNCH_BADGES.filter((badge) =>
      'events' in badge.rule
        ? (badge.rule.events as readonly string[]).includes('session_attended')
        : false,
    ).map((badge) => badge.slug);
    expect(offenders).toEqual([]);
  });
});
