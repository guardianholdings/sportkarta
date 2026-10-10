import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/**
 * Every /igrishta page, every per-sport page and the sitemap they feed must ask
 * the SAME question about visibility that the map, /statistika and the open-data
 * export ask — `PUBLIC_FACILITY_PREDICATE`, via the `publicFacilityVisible`
 * fragment.
 *
 * This is a source gate because of what drifting apart actually cost: places.ts
 * carried its own `status <> 'gone' AND slug IS NOT NULL` literal, which is the
 * predicate as it stood BEFORE migration 0017 added the paid-access gate. The
 * map, the statistics and the export all picked up the new rule; the city pages
 * did not. The result on the live site was 544 commercial venues listed as free
 * public facilities on a map whose entire promise is that the places on it are
 * free — indexable, in the sitemap, and invisible to every reconciliation test,
 * because each surface was internally consistent.
 *
 * A runtime test would need a paid fixture in a seeded database and somebody
 * remembering to write it. This fails on the diff instead.
 */
describe('places.ts asks the shared visibility question', () => {
  const source = readFileSync(join(__dirname, '..', 'lib', 'places.ts'), 'utf8');
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('never hand-rolls the public-visibility predicate', () => {
    expect(
      /status\s*<>\s*'gone'/.test(withoutComments),
      'places.ts builds its own visibility literal. Use publicFacilityVisible from @sportkarta/db so the city pages, the map and the export cannot disagree about which facilities are public.',
    ).toBe(false);
  });

  it('uses the shared fragment for every facility query it runs', () => {
    const facilityQueries = (withoutComments.match(/FROM facilities/g) ?? []).length;
    const shared = (withoutComments.match(/publicFacilityVisible/g) ?? []).length;
    expect(facilityQueries).toBeGreaterThan(0);
    expect(
      shared,
      `${String(facilityQueries)} queries read facilities but only ${String(shared)} use publicFacilityVisible`,
    ).toBeGreaterThanOrEqual(facilityQueries);
  });
});

/**
 * A listing exists only from MIN_LISTING_FACILITIES up — below that the route
 * 404s as thin content. /obshtina/<city> linked every municipality back to its
 * listing regardless, so for the ones with one or two facilities its first link
 * was a 404 (UX audit 2026-10-10, M-15). The pages that decide and the page that
 * links now read one constant, and the link sits behind it.
 */
describe('the listing threshold is one number', () => {
  const read = (...parts: string[]) => readFileSync(join(__dirname, '..', ...parts), 'utf8');
  const city = read('app', '[locale]', 'igrishta', '[city]', 'page.tsx');
  const segment = read('app', '[locale]', 'igrishta', '[city]', '[segment]', 'page.tsx');
  const obshtina = read('app', '[locale]', 'obshtina', '[city]', 'page.tsx');

  it('the listings use the shared constant, not a literal of their own', () => {
    for (const source of [city, segment]) {
      expect(source).toContain('MIN_LISTING_FACILITIES');
      expect(source).not.toMatch(/const MIN_\w+\s*=\s*\d/);
    }
  });

  it('the municipality page links to its listing only when the listing exists', () => {
    expect(obshtina).toMatch(
      /data\.total >= MIN_LISTING_FACILITIES && \(\s*<Link\s+href=\{`\/igrishta\/\$\{city\.slug\}`\}/,
    );
    expect(obshtina.match(/href=\{`\/igrishta\//g)).toHaveLength(1);
  });
});
