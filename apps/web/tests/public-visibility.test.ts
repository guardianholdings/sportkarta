import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PUBLIC_FACILITY_PREDICATE } from '@sportkarta/lib/opendata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { municipalityAccountability } from '../lib/accountability';
import {
  LIST_PAGE_SIZE,
  listPageCount,
  listPagePath,
  MAP_POINT_LIMIT,
  parseListPage,
  scopedFacilities,
  scopedFacilityCount,
  scopedMapPoints,
} from '../lib/places';
import { getFacilityBySlug, VERIFICATION_EVIDENCE } from '../lib/public-data';

/**
 * Which facilities are public is decided ONCE (PUBLIC_FACILITY_PREDICATE, via
 * the `publicFacilityVisible` fragment), and every public reader must ask that
 * question rather than a copy of it.
 *
 * The copies are what went wrong. accountability.ts carried `status <> 'gone'
 * AND slug IS NOT NULL` from before the paid gate, so /obshtina/sofia and its
 * embeddable widget counted 1,730 facilities as "free sports infrastructure"
 * while /igrishta/sofia and /statistika said 1,615 — the difference being the
 * paid venues the map hides. getFacilityBySlug and the contribution/report id
 * lookups carried the same stale copy, so a business the operator had hidden
 * still had a live, shareable page that accepted edits. Each surface was
 * internally consistent, which is why nothing noticed.
 *
 * Statement-level here (no database): the queries are recorded and inspected.
 * tests/public-data-db.test.ts runs the same functions against Postgres.
 */

const recorded = vi.hoisted(() => ({
  statements: [] as { sql: string; params: unknown[] }[],
  responses: [] as Record<string, unknown>[][],
}));

vi.mock('@sportkarta/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sportkarta/db')>();
  return {
    ...actual,
    getDb: () => ({
      execute(query: Parameters<typeof actual.renderSql>[0]) {
        recorded.statements.push(actual.renderSql(query));
        return Promise.resolve({ rows: recorded.responses.shift() ?? [] });
      },
    }),
  };
});

beforeEach(() => {
  recorded.statements.length = 0;
  recorded.responses.length = 0;
});

const CITY = { id: 42, slug: 'sofia', nameBg: 'София', nameEn: 'Sofia' };

/** Source with comments removed, so a comment that QUOTES the old rule passes. */
function code(relative: string): string {
  return readFileSync(join(__dirname, '..', relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('public facility readers ask the shared visibility question', () => {
  const READERS = [
    'lib/accountability.ts',
    'lib/public-data.ts',
    'lib/places.ts',
    'app/[locale]/obekt/[slug]/contribution-actions.ts',
    'app/[locale]/obekt/[slug]/report-actions.ts',
  ];

  it.each(READERS)('%s never hand-rolls the predicate', (file) => {
    const source = code(file);
    expect(
      /status\s*<>\s*'gone'/.test(source),
      `${file} builds its own visibility literal. Use publicFacilityVisible from @sportkarta/db — a copy drifts the first time the rule changes (it already did once: the paid gate).`,
    ).toBe(false);
    expect(source).toContain('publicFacilityVisible');
  });
});

describe('municipality accountability counts what the map shows', () => {
  it('both facility statements carry the public predicate', async () => {
    recorded.responses.push([{ ekatte_code: 'SOF46', population: 1274290, total: 3, free: 2 }]);
    const data = await municipalityAccountability(CITY);

    const [counts, rank] = recorded.statements;
    expect(counts?.sql).toContain(PUBLIC_FACILITY_PREDICATE);
    expect(counts?.params).toContain(CITY.id);
    // The per-10k rank ranks every municipality on the same base as the count.
    expect(rank?.sql).toContain(PUBLIC_FACILITY_PREDICATE);
    expect(data.total).toBe(3);
    expect(data.free).toBe(2);
  });

  it('asks exactly the /igrishta count question for its municipality', async () => {
    await scopedFacilityCount(CITY.id);
    const [cityCount] = recorded.statements;
    expect(cityCount?.sql).toContain(PUBLIC_FACILITY_PREDICATE);
    expect(cityCount?.sql).toContain('f.municipality_id = $1');
    expect(cityCount?.params).toEqual([CITY.id]);
  });
});

describe('the facility page and its evidence', () => {
  it('looks a facility up under the public predicate', async () => {
    await getFacilityBySlug('2fit');
    const [detail] = recorded.statements;
    expect(detail?.sql).toContain(`WHERE f.slug = $`);
    expect(detail?.sql).toContain(PUBLIC_FACILITY_PREDICATE);
  });

  it('never queries for a malformed slug', async () => {
    expect(await getFacilityBySlug('../etc')).toBeNull();
    expect(recorded.statements).toHaveLength(0);
  });

  it('dates "last checked" from verification evidence only', async () => {
    await getFacilityBySlug('borisova-gradina');
    const params = recorded.statements[0]?.params ?? [];
    for (const field of VERIFICATION_EVIDENCE.fields) expect(params).toContain(field);
    // A claim, a complaint and a wear report are not checks.
    for (const notEvidence of ['created', 'reported_missing', 'condition', 'name', 'quarter']) {
      expect(params).not.toContain(notEvidence);
    }
  });

  it('reports covered as known only when the row says so', async () => {
    const row = {
      id: 'x',
      slug: 'x',
      sport_types: [],
      access: 'free',
      status: 'needs_verification',
      source: 'osm',
      lon: 23.3,
      lat: 42.7,
    };
    recorded.responses.push([{ ...row, covered: false, covered_known: false }]);
    const unknown = await getFacilityBySlug('x');
    expect(unknown?.covered).toBe(false);
    expect(unknown?.coveredKnown).toBe(false);
    expect(unknown?.status).toBe('needs_verification');

    recorded.responses.push([{ ...row, covered: false, covered_known: true }]);
    expect((await getFacilityBySlug('x'))?.coveredKnown).toBe(true);
  });
});

describe('place pages: the map gets everything, the list is paged', () => {
  it('feeds the map the whole scope, not the list slice', async () => {
    await scopedMapPoints(CITY.id);
    const [map] = recorded.statements;
    expect(map?.sql).toContain(PUBLIC_FACILITY_PREDICATE);
    // LIMIT, OFFSET: everything from the first row, up to the safety valve.
    expect(map?.params.slice(-2)).toEqual([MAP_POINT_LIMIT, 0]);
    // Comfortably above the largest municipality (Sofia, ~1.7k with paid rows).
    expect(MAP_POINT_LIMIT).toBeGreaterThan(1700 * 2);
  });

  it('pages the list with a total order', async () => {
    await scopedFacilities(CITY.id, { sport: 'football' }, 3);
    const [list] = recorded.statements;
    expect(list?.sql).toContain(PUBLIC_FACILITY_PREDICATE);
    expect(list?.sql).toContain('ORDER BY f.name NULLS LAST, f.id');
    expect(list?.params.slice(-2)).toEqual([LIST_PAGE_SIZE, 2 * LIST_PAGE_SIZE]);
  });

  it('starts page 1 (and anything below it) at the first row', async () => {
    await scopedFacilities(CITY.id);
    await scopedFacilities(CITY.id, {}, 0);
    for (const statement of recorded.statements) {
      expect(statement.params.slice(-2)).toEqual([LIST_PAGE_SIZE, 0]);
    }
  });

  it('counts pages so the last facility is always on one', () => {
    expect(listPageCount(0)).toBe(1);
    expect(listPageCount(LIST_PAGE_SIZE)).toBe(1);
    expect(listPageCount(LIST_PAGE_SIZE + 1)).toBe(2);
    // Sofia at audit time: 1,615 facilities → 27 pages of 60.
    expect(listPageCount(1615)).toBe(Math.ceil(1615 / LIST_PAGE_SIZE));
  });

  it('accepts only canonical page numbers from 2 up', () => {
    expect(parseListPage('2')).toBe(2);
    expect(parseListPage('27')).toBe(27);
    // Page 1 is the unpaged URL itself — one address per page.
    expect(parseListPage('1')).toBeNull();
    for (const bad of ['0', '02', '-1', '2.5', 'abc', '', '9999999']) {
      expect(parseListPage(bad)).toBeNull();
    }
  });

  it('builds page URLs under the listing path', () => {
    expect(listPagePath('/igrishta/sofia', 1)).toBe('/igrishta/sofia');
    expect(listPagePath('/igrishta/sofia', 2)).toBe('/igrishta/sofia/stranitsa/2');
    expect(listPagePath('/igrishta/sofia/football', 3)).toBe(
      '/igrishta/sofia/football/stranitsa/3',
    );
  });
});
