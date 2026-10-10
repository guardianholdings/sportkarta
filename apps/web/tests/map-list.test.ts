import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { facilitySearchText, type LabelStrings } from '../components/map/facility-label';
import { matchRows, type ListQuery } from '../components/map/list-rows';
import type { MapPoint } from '../components/map/map-canvas';
import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The map list and the count above it. The audit found the header printing the
 * size of the FETCHED set whatever the member had typed — «Борисова» showed two
 * rows under «6060 съоръжения» — and the first paint printing «100 съоръжения»
 * over the server's alphabetical 100-row seed until the full set arrived.
 */

const tFacility = createTranslator({ locale: 'bg', messages: bg, namespace: 'Facility' });
const tSport = createTranslator({ locale: 'bg', messages: bg, namespace: 'Sport' });
const LABELS: LabelStrings = {
  locale: 'bg',
  unnamed: tFacility('unnamed'),
  sport: (sport) => tSport(sport as 'football'),
  unnamedAt: (what, place) => tFacility('unnamedAt', { what, place }),
};

const point = (slug: string, over: Partial<MapPoint> = {}): MapPoint => ({
  slug,
  name: null,
  sports: ['football'],
  lon: 23.32,
  lat: 42.7,
  place: 'София',
  ...over,
});

const POINTS: MapPoint[] = [
  point('borisova-1', { name: 'Борисова градина — игрище 1', lon: 23.34, lat: 42.68 }),
  point('borisova-2', { name: 'Борисова градина — игрище 2', lon: 23.35, lat: 42.68 }),
  point('mladost', { place: 'Младост, София', sports: ['basketball'], lon: 23.38, lat: 42.65 }),
  point('varna', { place: 'Варна', lon: 27.91, lat: 43.21 }),
  point('plovdiv', { place: 'Пловдив', sports: ['tennis'], lon: 24.75, lat: 42.14 }),
  // Enough unnamed filler to push the set past the list's 60-row cap.
  ...Array.from({ length: 80 }, (_, i) =>
    point(`filler-${String(i)}`, { place: 'Русе', lon: 25.97, lat: 43.85 }),
  ),
];

const BASE: ListQuery = {
  query: '',
  locale: 'bg',
  searchText: (p) => facilitySearchText(p, LABELS),
  userLocation: null,
  radiusKm: null,
  viewBounds: null,
};

describe('matchRows (what the list shows and the count reports)', () => {
  it('counts the SEARCHED set, not the fetched one', () => {
    const rows = matchRows(POINTS, { ...BASE, query: '  Борисова ' });
    expect(rows.map((r) => r.point.slug)).toEqual(['borisova-1', 'borisova-2']);
    expect(rows.length).not.toBe(POINTS.length);
  });

  it('is uncapped, so the count is the real total while the list shows 60', () => {
    const rows = matchRows(POINTS, { ...BASE, query: 'русе' });
    expect(rows).toHaveLength(80);
  });

  it('finds an unnamed facility by its place or its sport', () => {
    expect(matchRows(POINTS, { ...BASE, query: 'младост' }).map((r) => r.point.slug)).toEqual([
      'mladost',
    ]);
    expect(matchRows(POINTS, { ...BASE, query: 'тенис' }).map((r) => r.point.slug)).toEqual([
      'plovdiv',
    ]);
  });

  it('matches Latin input against Cyrillic data, and the other way round', () => {
    // A Latin keyboard is the default on many Bulgarian phones (M-6).
    const slugs = (query: string) => matchRows(POINTS, { ...BASE, query }).map((r) => r.point.slug);
    expect(slugs('mladost')).toEqual(['mladost']);
    expect(slugs('Borisova gradina')).toEqual(['borisova-1', 'borisova-2']);
    expect(slugs('plovdiv')).toEqual(['plovdiv']);
    expect(slugs('sofia')).toEqual(['borisova-1', 'borisova-2', 'mladost']);
    // The sport's own key works on the Bulgarian site too.
    expect(slugs('basketball')).toEqual(['mladost']);
  });

  it('still matches a Cyrillic word half-typed', () => {
    // «Дия» transliterates as a word ending in «ия» («dia»), which is no prefix
    // of «diyan» — the Cyrillic half of the index is what finds it.
    const diyan = [point('diyan', { name: 'Игрище Диян', place: 'Пловдив' })];
    expect(matchRows(diyan, { ...BASE, query: 'Дия' })).toHaveLength(1);
    expect(matchRows(diyan, { ...BASE, query: 'diyan' })).toHaveLength(1);
  });

  it('finds an English place name from a Cyrillic query', () => {
    const tFacilityEn = createTranslator({ locale: 'en', messages: en, namespace: 'Facility' });
    const tSportEn = createTranslator({ locale: 'en', messages: en, namespace: 'Sport' });
    const LABELS_EN: LabelStrings = {
      locale: 'en',
      unnamed: tFacilityEn('unnamed'),
      sport: (sport) => tSportEn(sport as 'football'),
      unnamedAt: (what, place) => tFacilityEn('unnamedAt', { what, place }),
    };
    const sofia = [point('sofia-en', { place: 'Sofia' })];
    const rows = matchRows(sofia, {
      ...BASE,
      locale: 'en',
      query: 'софия',
      searchText: (p) => facilitySearchText(p, LABELS_EN),
    });
    expect(rows).toHaveLength(1);
  });

  it('applies the near-me radius only while near-me is on, nearest first', () => {
    const sofia = { lon: 23.32, lat: 42.7 };
    const near = matchRows(POINTS, { ...BASE, userLocation: sofia, radiusKm: 8 });
    expect(near.map((r) => r.point.slug)).toEqual(['borisova-1', 'borisova-2', 'mladost']);
    expect(near.every((r) => r.km !== null && r.km <= 8)).toBe(true);
    const all = matchRows(POINTS, { ...BASE, userLocation: sofia });
    expect(all).toHaveLength(POINTS.length);
  });

  it('puts what is on the map first without reordering within either half', () => {
    const varnaView = { west: 27.5, east: 28.2, south: 43, north: 43.4 };
    const rows = matchRows(POINTS.slice(0, 5), { ...BASE, viewBounds: varnaView });
    expect(rows.map((r) => r.point.slug)).toEqual([
      'varna',
      'borisova-1',
      'borisova-2',
      'mladost',
      'plovdiv',
    ]);
  });
});

describe('the count line', () => {
  const explorer = readFileSync(
    path.join(__dirname, '..', 'components', 'map', 'map-explorer.tsx'),
    'utf8',
  );

  it('reports the matched rows, never the size of the fetched set', () => {
    expect(explorer).toMatch(/t\('resultsCount', \{ count: matched\.length \}\)/);
    expect(explorer).not.toMatch(/count: points\.length/);
  });

  it('starts in the loading state, so the 100-row seed is never announced as the total', () => {
    expect(explorer).toMatch(/const \[loading, setLoading\] = useState\(true\)/);
    expect(explorer).toMatch(/loading\s*\?\s*t\('resultsLoading'\)/);
  });
});

/**
 * «Опитай пак» and «Сортирай» both called applyFilters with the filters already
 * applied. The fetch effect is keyed on the serialised filters, which had not
 * changed, so neither button did anything (UX audit 2026-10-10, M-3).
 */
describe('retrying a failed load', () => {
  const explorer = readFileSync(
    path.join(__dirname, '..', 'components', 'map', 'map-explorer.tsx'),
    'utf8',
  );

  it('re-runs the fetch through an attempt counter in its dependencies', () => {
    expect(explorer).toMatch(/\}, \[filterKey, locale, attempt\]\);/);
    expect(explorer).toMatch(
      /onClick=\{\(\) => setAttempt\(\(n\) => n \+ 1\)\}>\s*\{t\('retry'\)\}/,
    );
  });

  it('retries by itself when the connection comes back', () => {
    expect(explorer).toMatch(
      /const retry = \(\) => setAttempt\(\(n\) => n \+ 1\);\s*window\.addEventListener\('online', retry\)/,
    );
  });

  it('never re-applies the current filters as a way of doing something', () => {
    expect(explorer).not.toMatch(/applyFilters\(\{ \.\.\.filters \}\)/);
  });

  it('hands the canvas the searched set, so the pins follow the search', () => {
    expect(explorer).toMatch(/<MapCanvas\s+points=\{searchedPoints\}/);
    expect(explorer).toMatch(/const match = searchMatcher\(query, locale\);/);
  });

  it('offers no sort control, since there is no sort to choose', () => {
    expect(explorer).not.toMatch(/t\('sort'\)/);
    expect('sort' in bg.Map).toBe(false);
  });
});
