import { describe, expect, it } from 'vitest';

import {
  closedWeekStart,
  DIVISION_ACTIVE_WEEKS,
  DIVISION_ENTRY_TIER,
  DIVISION_MIN_MEMBERS,
  DIVISION_PROMOTE,
  DIVISION_RELEGATE,
  DIVISION_SIZE,
  DIVISION_TIER_COUNT,
  DIVISION_TIERS,
  divisionSections,
  divisionWeekStart,
  nextTier,
  planDivisions,
  tierFor,
  tierNumber,
  tierSlug,
  zoneCounts,
  zoneFor,
  type DivisionCandidate,
} from './index.js';

/**
 * The division rules, pinned.
 *
 * Every test here corresponds to a decision recorded in the module's own header
 * or in docs/ENGAGEMENT-IMPLEMENTATION.md §8. They exist because each rule is
 * individually plausible to "simplify" away six months from now — especially
 * inactivity protection, which looks like a missing relegation.
 */

const member = (over: Partial<DivisionCandidate> = {}): DivisionCandidate => ({
  userId: 'u1',
  previousTier: null,
  place: null,
  recentScore: 0,
  ...over,
});

describe('the tier catalogue', () => {
  it('is five Bulgarian mountains, entry first', () => {
    expect(DIVISION_TIERS).toEqual(['rodopi', 'vitosha', 'stara_planina', 'pirin', 'rila']);
    expect(DIVISION_TIER_COUNT).toBe(5);
  });

  it('round-trips slug and number', () => {
    for (const [index, slug] of DIVISION_TIERS.entries()) {
      expect(tierNumber(slug)).toBe(index + 1);
      expect(tierSlug(index + 1)).toBe(slug);
    }
  });

  it('clamps rather than throwing on an out-of-range tier — a tier is display', () => {
    expect(tierSlug(0)).toBe('rodopi');
    expect(tierSlug(99)).toBe('rila');
    expect(tierNumber('everest')).toBeNull();
  });
});

describe('zoneFor', () => {
  const mid = { tier: 3, size: DIVISION_SIZE };

  it('promotes the top seven', () => {
    expect(zoneFor({ rank: 1, score: 12 }, mid)).toBe('promote');
    expect(zoneFor({ rank: DIVISION_PROMOTE, score: 1 }, mid)).toBe('promote');
    expect(zoneFor({ rank: DIVISION_PROMOTE + 1, score: 1 }, mid)).toBe('hold');
  });

  it('relegates the bottom five', () => {
    expect(zoneFor({ rank: DIVISION_SIZE, score: 1 }, mid)).toBe('relegate');
    expect(zoneFor({ rank: DIVISION_SIZE - DIVISION_RELEGATE + 1, score: 1 }, mid)).toBe(
      'relegate',
    );
    expect(zoneFor({ rank: DIVISION_SIZE - DIVISION_RELEGATE, score: 1 }, mid)).toBe('hold');
  });

  it('holds the eighteen in the middle — the common outcome', () => {
    const held = Array.from({ length: DIVISION_SIZE }, (_, i) => i + 1)
      .map((rank) => zoneFor({ rank, score: 1 }, mid))
      .filter((zone) => zone === 'hold');
    expect(held).toHaveLength(DIVISION_SIZE - DIVISION_PROMOTE - DIVISION_RELEGATE);
  });

  /**
   * INACTIVITY PROTECTION. The rule ENGAGEMENT B2 names in three words and that
   * nothing else in the stack states. A member on zero holds from ANY rank.
   */
  it('never relegates a member who scored nothing, even in last place', () => {
    expect(zoneFor({ rank: DIVISION_SIZE, score: 0 }, mid)).toBe('hold');
    expect(zoneFor({ rank: DIVISION_SIZE, score: -1 }, mid)).toBe('hold');
  });

  it('never promotes a member who scored nothing either', () => {
    expect(zoneFor({ rank: 1, score: 0 }, mid)).toBe('hold');
  });

  /**
   * The bug this pins: applying 7 and 5 literally to a group of eight makes the
   * bands overlap (1..7 promote, 4..8 relegate) and promotes seven of eight.
   */
  it('scales the zones so a small group still has a hold band', () => {
    const { promote, relegate } = zoneCounts(8);
    expect(promote + relegate).toBeLessThan(8);
    expect(zoneFor({ rank: promote + 1, score: 1 }, { tier: 3, size: 8 })).toBe('hold');
    expect(zoneFor({ rank: 8, score: 1 }, { tier: 3, size: 8 })).toBe('relegate');
  });

  it('never lets the two bands overlap, at any group size', () => {
    for (let size = 1; size <= DIVISION_SIZE; size += 1) {
      const { promote, relegate } = zoneCounts(size);
      expect(promote + relegate).toBeLessThanOrEqual(size);
      const zones = Array.from({ length: size }, (_, i) =>
        zoneFor({ rank: i + 1, score: 1 }, { tier: 3, size }),
      );
      expect(zones.filter((z) => z === 'promote')).toHaveLength(promote);
      expect(zones.filter((z) => z === 'relegate')).toHaveLength(relegate);
    }
  });

  it('returns the operator numbers exactly at a full division', () => {
    expect(zoneCounts(DIVISION_SIZE)).toEqual({
      promote: DIVISION_PROMOTE,
      relegate: DIVISION_RELEGATE,
    });
  });

  it('makes both ends of the ladder terminal, so no screen must explain a missing move', () => {
    expect(zoneFor({ rank: 1, score: 9 }, { tier: DIVISION_TIER_COUNT })).toBe('hold');
    expect(zoneFor({ rank: DIVISION_SIZE, score: 9 }, { tier: DIVISION_ENTRY_TIER })).toBe('hold');
  });
});

describe('divisionSections', () => {
  const group = (size: number) =>
    Array.from({ length: size }, (_, i) => ({ rank: i + 1, score: size - i }));

  it('splits a mid-ladder group into promote / hold / relegate, in order', () => {
    const sections = divisionSections(group(DIVISION_SIZE), { size: DIVISION_SIZE, tier: 3 });
    expect(sections.map((s) => s.zone)).toEqual(['promote', 'hold', 'relegate']);
    expect(sections.map((s) => s.rows.length)).toEqual([
      DIVISION_PROMOTE,
      DIVISION_SIZE - DIVISION_PROMOTE - DIVISION_RELEGATE,
      DIVISION_RELEGATE,
    ]);
  });

  /**
   * THE BUG THIS FUNCTION EXISTS TO PREVENT. At the entry tier the bottom rows
   * were being marked as a relegation zone on a ladder where relegation cannot
   * happen — a tint with no words beside it, saying something untrue.
   */
  it('has no relegation zone at the entry tier', () => {
    const sections = divisionSections(group(DIVISION_SIZE), {
      size: DIVISION_SIZE,
      tier: DIVISION_ENTRY_TIER,
    });
    expect(sections.map((s) => s.zone)).toEqual(['promote', 'hold']);
  });

  it('has no promotion zone at the top tier', () => {
    const sections = divisionSections(group(DIVISION_SIZE), {
      size: DIVISION_SIZE,
      tier: DIVISION_TIER_COUNT,
    });
    expect(sections.map((s) => s.zone)).toEqual(['hold', 'relegate']);
  });

  it('is one flat hold when nobody scored', () => {
    const idle = Array.from({ length: DIVISION_SIZE }, (_, i) => ({ rank: i + 1, score: 0 }));
    const sections = divisionSections(idle, { size: DIVISION_SIZE, tier: 3 });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.zone).toBe('hold');
  });

  it('returns nothing for an empty group — the ladder then renders nothing', () => {
    expect(divisionSections([], { size: DIVISION_SIZE, tier: 3 })).toEqual([]);
  });

  it('never splits one zone into two bands', () => {
    const sections = divisionSections(group(DIVISION_SIZE), { size: DIVISION_SIZE, tier: 3 });
    expect(new Set(sections.map((s) => s.zone)).size).toBe(sections.length);
  });
});

describe('nextTier', () => {
  it('moves one step and clamps at both ends', () => {
    expect(nextTier(2, 'promote')).toBe(3);
    expect(nextTier(2, 'relegate')).toBe(1);
    expect(nextTier(2, 'hold')).toBe(2);
    expect(nextTier(DIVISION_TIER_COUNT, 'promote')).toBe(DIVISION_TIER_COUNT);
    expect(nextTier(DIVISION_ENTRY_TIER, 'relegate')).toBe(DIVISION_ENTRY_TIER);
  });
});

describe('tierFor', () => {
  it('starts a member with no history at the entry tier', () => {
    expect(tierFor(member())).toBe(DIVISION_ENTRY_TIER);
  });

  it('keeps an absent member where they were — absence already cost them the weeks', () => {
    expect(tierFor(member({ previousTier: 4, place: null }))).toBe(4);
  });

  it('applies the zone for a member who played', () => {
    expect(tierFor(member({ previousTier: 2, place: { rank: 1, score: 8 } }))).toBe(3);
    expect(tierFor(member({ previousTier: 2, place: { rank: 30, score: 8 } }))).toBe(1);
  });

  it('does not relegate a member who was last on zero', () => {
    expect(tierFor(member({ previousTier: 2, place: { rank: 30, score: 0 } }))).toBe(2);
  });
});

describe('planDivisions', () => {
  const roster = (count: number, over: (i: number) => Partial<DivisionCandidate> = () => ({})) =>
    Array.from({ length: count }, (_, i) =>
      member({ userId: `u${String(i).padStart(3, '0')}`, recentScore: count - i, ...over(i) }),
    );

  it('writes nothing below the floor — the floor IS the empty plan', () => {
    expect(planDivisions(roster(DIVISION_MIN_MEMBERS - 1))).toEqual([]);
    expect(planDivisions(roster(DIVISION_MIN_MEMBERS))).toHaveLength(DIVISION_MIN_MEMBERS);
  });

  /**
   * Balanced, not filled-then-remainder: 65 members are 22/22/21, never
   * 30/30/5. A five-member "division" would be the most volatile field on the
   * ladder, made up of the least active members — the people it exists to keep.
   */
  it('balances group sizes rather than leaving a ragged remainder', () => {
    for (const n of [10, 31, 59, 65, 90, 121]) {
      const plan = planDivisions(roster(n));
      const sizes = new Map<number, number>();
      for (const a of plan) sizes.set(a.ordinal, (sizes.get(a.ordinal) ?? 0) + 1);
      const counts = [...sizes.values()];
      expect(plan).toHaveLength(n);
      expect(counts).toHaveLength(Math.ceil(n / DIVISION_SIZE));
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      expect(Math.max(...counts)).toBeLessThanOrEqual(DIVISION_SIZE);
    }
  });

  it('slices groups contiguously by activity, so one group is of similar activity', () => {
    const plan = planDivisions(roster(65));
    const byUser = new Map(plan.map((a) => [a.userId, a]));
    // roster() gives u000 the highest recentScore and u064 the lowest.
    expect(byUser.get('u000')?.ordinal).toBe(1);
    expect(byUser.get('u064')?.ordinal).toBe(3);
  });

  it('separates tiers — a promoted member never shares a group with an entry-tier one', () => {
    const plan = planDivisions([
      ...roster(6, () => ({ previousTier: 1, place: { rank: 1, score: 5 } })),
      ...roster(6, (i) => ({ userId: `low${i}`, previousTier: 1, place: null })),
    ]);
    const tiers = new Set(plan.map((a) => a.tier));
    expect(tiers).toEqual(new Set([1, 2]));
    for (const a of plan) expect(a.tier).toBe(a.userId.startsWith('low') ? 1 : 2);
  });

  it('is deterministic, which is what makes the write idempotent rather than merely retry-safe', () => {
    // Every candidate on the same recentScore: only the userId tiebreak orders them.
    const flat = roster(40, () => ({ recentScore: 3 }));
    const a = planDivisions(flat);
    const b = planDivisions([...flat].reverse());
    expect(b).toEqual(a);
  });

  it('reports the zone that produced the move, and null for a member who was not in a group', () => {
    const plan = planDivisions([
      ...roster(9, () => ({ previousTier: 2, place: { rank: 1, score: 5 } })),
      ...roster(3, (i) => ({ userId: `new${i}`, previousTier: null, place: null })),
    ]);
    const byUser = new Map(plan.map((a) => [a.userId, a]));
    expect(byUser.get('u000')?.zone).toBe('promote');
    expect(byUser.get('new0')?.zone).toBeNull();
  });
});

describe('week boundaries', () => {
  /**
   * The one case worth pinning: 21:30Z on a Sunday in summer is already Monday
   * in Sofia, so it belongs to the NEW week. Getting this wrong would run the
   * rollover against a week that has not closed.
   */
  it('reads Sunday 21:30Z in summer as the new Sofia week', () => {
    expect(divisionWeekStart(new Date('2026-07-19T21:30:00Z'))).toBe('2026-07-20');
    expect(divisionWeekStart(new Date('2026-07-19T20:30:00Z'))).toBe('2026-07-13');
  });

  it('scores the week that just closed', () => {
    expect(closedWeekStart(new Date('2026-07-20T04:40:00Z'))).toBe('2026-07-13');
  });

  it('always returns a Monday, across a DST transition', () => {
    for (const iso of [
      '2026-03-29T00:30:00Z', // spring forward
      '2026-10-25T00:30:00Z', // fall back
      '2026-01-01T12:00:00Z',
    ]) {
      const key = divisionWeekStart(new Date(iso));
      expect(new Date(`${key}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });
});

describe('the constants are the operator decision of 2026-07-26', () => {
  it('is 30 / top 7 / bottom 5, with a floor of 10 and a 4-week activity window', () => {
    expect(DIVISION_SIZE).toBe(30);
    expect(DIVISION_PROMOTE).toBe(7);
    expect(DIVISION_RELEGATE).toBe(5);
    expect(DIVISION_MIN_MEMBERS).toBe(10);
    expect(DIVISION_ACTIVE_WEEKS).toBe(4);
  });

  it('leaves a majority holding, which is the anti-demoralisation argument in numbers', () => {
    expect(DIVISION_PROMOTE + DIVISION_RELEGATE).toBeLessThan(DIVISION_SIZE / 2);
  });
});
