import { describe, expect, it } from 'vitest';

import { assignCitySlugs, type MunicipalityRow } from '../lib/places';

const rows = (...names: [number, string, string][]): MunicipalityRow[] =>
  names.map(([id, name_bg, name_en]) => ({ id, name_bg, name_en }));

describe('assignCitySlugs', () => {
  it('transliterates municipality names to slugs', () => {
    const cities = assignCitySlugs(rows([1, 'Варна', 'Varna'], [2, 'Пловдив', 'Plovdiv']));
    expect(cities.map((c) => c.slug)).toEqual(['varna', 'plovdiv']);
  });

  it('applies the city override (Столична → sofia / София)', () => {
    const sofia = assignCitySlugs(rows([1, 'Столична', 'Stolichna']))[0];
    expect(sofia?.slug).toBe('sofia');
    expect(sofia?.nameBg).toBe('София');
    expect(sofia?.nameEn).toBe('Sofia');
  });

  it('suffixes collisions deterministically by input order', () => {
    const cities = assignCitySlugs(
      rows([10, 'Бяла', 'Byala'], [20, 'Бяла', 'Byala'], [30, 'Варна', 'Varna']),
    );
    expect(cities.map((c) => c.slug)).toEqual(['byala', 'byala-2', 'varna']);
  });

  it('keeps the DB name when there is no override', () => {
    const c = assignCitySlugs(rows([5, 'Габрово', 'Gabrovo']))[0];
    expect(c?.nameBg).toBe('Габрово');
    expect(c?.nameEn).toBe('Gabrovo');
  });
});
