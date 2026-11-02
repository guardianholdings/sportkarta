import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { numbersFigures, numbersWideColumns } from '../lib/home/numbers';

/**
 * The front page's numbers band: «0 игри тази седмица» or «0 приноси за 30 дни»
 * on the most visited page reads as an empty platform, so the games figure
 * shows only while there are games this week, as on the clubs page, and the
 * contributions figure only while there were contributions in the last 30
 * days (operator, 2026-11-02).
 */
describe('the numbers band figures', () => {
  it('leaves out the games figure while there are none this week', () => {
    const rest = ['places', 'municipalities', 'contributions'];
    expect(numbersFigures(100, 20, 0, 7).map((f) => f.key)).toEqual(rest);
    expect(numbersFigures(100, 20, null, 7).map((f) => f.key)).toEqual(rest);
  });

  it('leaves out the contributions figure while there are none in the last 30 days', () => {
    const rest = ['places', 'municipalities', 'games'];
    expect(numbersFigures(100, 20, 4, 0).map((f) => f.key)).toEqual(rest);
    expect(numbersFigures(100, 20, 4, null).map((f) => f.key)).toEqual(rest);
  });

  it('with no games and no contributions, shows two figures in two columns', () => {
    const figures = numbersFigures(100, 20, 0, 0);
    expect(figures).toEqual([
      { key: 'places', value: 100 },
      { key: 'municipalities', value: 20 },
    ]);
    expect(numbersWideColumns(figures.length)).toBe('lg:grid-cols-2');
  });

  it('shows it, with its count, once there is a game', () => {
    expect(numbersFigures(100, 20, 4, 7)).toEqual([
      { key: 'places', value: 100 },
      { key: 'municipalities', value: 20 },
      { key: 'games', value: 4 },
      { key: 'contributions', value: 7 },
    ]);
  });

  it('leaves out a figure it has no number for', () => {
    expect(numbersFigures(null, null, 4, null)).toEqual([{ key: 'games', value: 4 }]);
    expect(numbersFigures(null, null, null, 3)).toEqual([{ key: 'contributions', value: 3 }]);
    expect(numbersFigures(null, null, 0, null)).toEqual([]);
    expect(numbersFigures(null, null, 0, 0)).toEqual([]);
  });

  it('puts every figure in one wide row', () => {
    expect(numbersWideColumns(4)).toBe('lg:grid-cols-4');
    expect(numbersWideColumns(3)).toBe('lg:grid-cols-3');
    expect(numbersWideColumns(2)).toBe('lg:grid-cols-2');
  });
});

describe('the band', () => {
  const band = readFileSync(
    new URL('../components/marketing/numbers-band.tsx', import.meta.url),
    'utf8',
  );

  it('takes its figures and its wide columns from lib/home/numbers.ts', () => {
    expect(band).toContain('numbersFigures(');
    expect(band).toContain('numbersWideColumns(figures.length)');
    expect(band).not.toContain('figures.push(');
    expect(band).not.toContain('lg:grid-cols-4');
  });
});
