import { describe, expect, it } from 'vitest';

import type { PublicPassport } from '../lib/passport';
import { toPassportShare, type PassportShare } from '../lib/share/passport-payload';

/**
 * The exact-key test for the passport SHARE payload (C4).
 *
 * Modelled on tests/passport-privacy.test.ts, and for the same reason: a
 * "does not contain X" assertion only catches leaks somebody already thought of,
 * whereas an EXACT key set fails on any field that arrives later — including one
 * added innocently upstream.
 *
 * This is not hypothetical here. In phase 4 the public passport reused the
 * owner's streak shape, and `weeksAtRisk` — "has not played yet this week" —
 * silently became part of a payload on a page anyone can open. The exact-key
 * test caught it on the first run. A share travels further than a page and
 * outlives the decision to publish, so it gets its own.
 */

const FULL: PublicPassport = {
  displayName: 'Иван Петров',
  homeCity: 'София',
  memberSince: '2025-03',
  totals: { points: 128, contributions: 14, checkins: 31 },
  badges: [
    { slug: 'first_game', earnedMonth: '2025-04' },
    { slug: 'regular_10', earnedMonth: '2025-08' },
  ],
  streaks: { currentDays: 2, longestDays: 9, currentWeeks: 3, longestWeeks: 11 },
  activity: [
    { month: '2025-08', checkins: 4, contributions: 2 },
    { month: '2025-09', checkins: 6, contributions: 1 },
  ],
};

describe('passport share payload', () => {
  it('exposes exactly the agreed fields and no others', () => {
    const share = toPassportShare(FULL);
    expect(Object.keys(share).sort()).toEqual(
      [
        'badgeCount',
        'checkins',
        'contributions',
        'displayName',
        'homeCity',
        'longestWeeks',
        'memberSince',
        'points',
      ].sort(),
    );
  });

  it('drops the month-by-month activity history', () => {
    // Fine on a page the member controls and can unpublish; a behavioural
    // history to hand a group chat, which is a copy that outlives the decision.
    const share = toPassportShare(FULL) as unknown as Record<string, unknown>;
    expect(share.activity).toBeUndefined();
    expect(JSON.stringify(share)).not.toContain('2025-09');
  });

  it('carries a badge COUNT, never the badge list', () => {
    const share = toPassportShare(FULL);
    expect(share.badgeCount).toBe(2);
    expect(JSON.stringify(share)).not.toContain('regular_10');
    expect(JSON.stringify(share)).not.toContain('first_game');
  });

  it('carries no live behavioural state', () => {
    // currentDays / currentWeeks say what a named person is doing RIGHT NOW.
    // longestWeeks is a durable achievement and may travel.
    const share = toPassportShare(FULL) as unknown as Record<string, unknown>;
    expect(share.currentDays).toBeUndefined();
    expect(share.currentWeeks).toBeUndefined();
    expect(share.longestWeeks).toBe(11);
  });

  it('coarsens membership to a MONTH, never a date', () => {
    const share = toPassportShare(FULL);
    expect(share.memberSince).toMatch(/^\d{4}-\d{2}$/);
  });

  it('never carries a facility, a day or a time', () => {
    const share = toPassportShare(FULL) as unknown as Record<string, unknown>;

    // Checked against the KEYS as whole words, not as substrings of the
    // serialised blob — "lon" is inside "longestWeeks", and a substring test
    // would have failed on a payload that is entirely correct. (It did.)
    const forbidden = ['facility', 'slug', 'lat', 'lon', 'startsat', 'checkedinat', 'handle'];
    for (const key of Object.keys(share)) {
      const lower = key.toLowerCase();
      for (const word of forbidden) {
        expect(lower === word, `key "${key}" must not be "${word}"`).toBe(false);
      }
    }

    // And no VALUE may look like a day, a time or a coordinate, which is how one
    // would arrive hidden inside a field with an innocent name.
    for (const [key, value] of Object.entries(share)) {
      if (typeof value !== 'string') continue;
      expect(value, `${key} looks like a full date`).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(value, `${key} looks like a time`).not.toMatch(/\d{2}:\d{2}/);
    }
  });

  it('is buildable only from an already-consented public passport', () => {
    // The type is the guarantee: `toPassportShare` takes a PublicPassport, which
    // only exists once publicPassportOwner's visibility predicate has passed. No
    // overload takes a handle or an id, so there is no path here that reaches
    // the database and therefore none that can bypass the consent view.
    const share: PassportShare = toPassportShare(FULL);
    expect(share.displayName).toBe('Иван Петров');
  });
});
