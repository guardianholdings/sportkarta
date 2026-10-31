import { describe, expect, it } from 'vitest';

import {
  ELO_START,
  bracketSize,
  drawnSeeds,
  eliminationRounds,
  eloExpected,
  eloRatings,
  nextMatch,
  publicEntrantName,
  roundRobinDraw,
  scoreWinner,
  seedOrder,
  singleEliminationDraw,
  standings,
  type PlayedMatch,
} from './tournament.js';

describe('single elimination', () => {
  it('seeds 1 against the lowest seed, and keeps 1 and 2 apart until the final', () => {
    expect(seedOrder(4)).toEqual([1, 4, 2, 3]);
    expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
  });

  it('gives the byes to the top seeds, never two in one match', () => {
    for (let n = 2; n <= 64; n += 1) {
      const draw = singleEliminationDraw(n);
      const first = draw.filter((m) => m.round === 1);
      expect(first).toHaveLength(bracketSize(n) / 2);
      expect(first.every((m) => m.a !== null || m.b !== null)).toBe(true);
      const seen = first.flatMap((m) => [m.a, m.b]).filter((x): x is number => x !== null);
      expect(new Set(seen).size).toBe(n);
      const byes = first.filter((m) => m.a === null || m.b === null);
      expect(byes).toHaveLength(bracketSize(n) - n);
      // The players with a bye are exactly the top seeds.
      const bye = byes.map((m) => (m.a ?? m.b) as number).sort((x, y) => x - y);
      expect(bye).toEqual(Array.from({ length: bracketSize(n) - n }, (_, i) => i));
      expect(Math.max(...draw.map((m) => m.round))).toBe(eliminationRounds(n));
    }
  });

  it('sends the winner of a match to the next one, A side for even slots', () => {
    expect(nextMatch(1, 0)).toEqual({ round: 2, slot: 0, side: 'a' });
    expect(nextMatch(1, 3)).toEqual({ round: 2, slot: 1, side: 'b' });
    expect(nextMatch(2, 1)).toEqual({ round: 3, slot: 0, side: 'b' });
  });

  it('refuses a field of one, or one too big', () => {
    expect(() => singleEliminationDraw(1)).toThrow(RangeError);
    expect(() => singleEliminationDraw(129)).toThrow(RangeError);
  });
});

describe('round robin', () => {
  it('meets every pair exactly once, in rounds nobody plays twice in', () => {
    for (let n = 2; n <= 17; n += 1) {
      const draw = roundRobinDraw(n);
      expect(draw).toHaveLength((n * (n - 1)) / 2);
      const pairs = new Set(draw.map((m) => `${String(m.a)}-${String(m.b)}`));
      expect(pairs.size).toBe(draw.length);
      for (const round of new Set(draw.map((m) => m.round))) {
        const inRound = draw.filter((m) => m.round === round).flatMap((m) => [m.a, m.b]);
        expect(new Set(inRound).size).toBe(inRound.length);
      }
    }
  });
});

const played = (a: string, b: string, scoreA: number, scoreB: number): PlayedMatch => ({
  a,
  b,
  scoreA,
  scoreB,
  status: 'played',
  winner: null,
});

describe('drawn seeds', () => {
  it('reads every seed back from an elimination, byes included', () => {
    for (const size of [2, 3, 5, 8, 13, 128]) {
      const ids = Array.from({ length: size }, (_, i) => `p${String(i)}`);
      const rows = singleEliminationDraw(size).map((m) => ({
        round: m.round,
        slot: m.slot,
        a: m.a === null ? null : (ids[m.a] ?? null),
        b: m.b === null ? null : (ids[m.b] ?? null),
      }));
      const seeds = drawnSeeds('single_elimination', rows);
      expect(seeds.size).toBe(size);
      ids.forEach((id, i) => expect(seeds.get(id)).toBe(i + 1));
    }
  });

  it('reads every seed back from a round robin, odd fields included', () => {
    for (const size of [2, 3, 6, 9]) {
      const ids = Array.from({ length: size }, (_, i) => `p${String(i)}`);
      const rows = roundRobinDraw(size).map((m) => ({
        round: m.round,
        slot: m.slot,
        a: m.a === null ? null : (ids[m.a] ?? null),
        b: m.b === null ? null : (ids[m.b] ?? null),
      }));
      const seeds = drawnSeeds('round_robin', rows);
      ids.forEach((id, i) => expect(seeds.get(id)).toBe(i + 1));
    }
  });

  it('gives up on rows it did not draw', () => {
    expect(drawnSeeds('round_robin', [{ round: 1, slot: 0, a: 'x', b: null }]).size).toBe(0);
    expect(
      drawnSeeds('single_elimination', [
        { round: 1, slot: 0, a: 'x', b: 'y' },
        { round: 1, slot: 5, a: 'z', b: 'w' },
      ]).size,
    ).toBe(0);
  });
});

describe('standings', () => {
  it('ranks by points, then score difference, then score for, then seed', () => {
    const table = standings(
      ['A', 'B', 'C'],
      [
        played('A', 'B', 2, 1),
        played('B', 'C', 3, 0),
        played('A', 'C', 1, 1),
        { a: 'C', b: 'B', scoreA: null, scoreB: null, status: 'walkover', winner: 'C' },
      ],
    );
    expect(table.map((row) => [row.entrant, row.points])).toEqual([
      ['A', 4],
      ['C', 4],
      ['B', 3],
    ]);
    expect(table[0]).toMatchObject({ played: 2, won: 1, drawn: 1, lost: 0, scoreFor: 3 });
  });

  it('names the winner by score, and a draw by nobody', () => {
    expect(scoreWinner(played('A', 'B', 3, 1))).toBe('A');
    expect(scoreWinner(played('A', 'B', 1, 3))).toBe('B');
    expect(scoreWinner(played('A', 'B', 2, 2))).toBeNull();
  });
});

describe('ratings', () => {
  it('starts at 1500, moves the winner up and the loser down by the same amount', () => {
    const ratings = eloRatings([played('A', 'B', 2, 0)]);
    expect(ratings.get('A')).toBe(ELO_START + 16);
    expect(ratings.get('B')).toBe(ELO_START - 16);
  });

  it('expects the stronger player to win, and ignores walkovers', () => {
    expect(eloExpected(1700, 1500)).toBeGreaterThan(0.75);
    const ratings = eloRatings([
      { a: 'A', b: 'B', scoreA: null, scoreB: null, status: 'walkover', winner: 'A' },
    ]);
    expect(ratings.size).toBe(0);
  });

  it('is a fold: the order of results matters, and a correction re-folds everything after it', () => {
    const first = eloRatings([played('A', 'B', 1, 0), played('B', 'C', 1, 0)]);
    const second = eloRatings([played('B', 'C', 1, 0), played('A', 'B', 1, 0)]);
    expect(first.get('B')).not.toBe(second.get('B'));
  });
});

describe('public names', () => {
  it('shows a name only with the entrant’s own consent', () => {
    const anon = (n: number) => `Участник ${String(n)}`;
    expect(publicEntrantName({ name: 'Ана', namePublic: true, number: 3 }, anon)).toBe('Ана');
    expect(publicEntrantName({ name: 'Ана', namePublic: false, number: 3 }, anon)).toBe(
      'Участник 3',
    );
  });
});
