import { PUBLIC_FACILITY_PREDICATE } from '@sportkarta/lib/opendata';
import { renderSql, type SQL } from '@sportkarta/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PublicFilters } from '@/lib/filters';

/**
 * The map feed now says WHERE each facility is (`place`), because 91% have no
 * name and the list could not otherwise tell them apart. These pin it at the
 * statement level: the join must not replace the shared visibility predicate,
 * the municipality must read in the reader's locale (with «Столична» shown as
 * «София», as on the place pages), and an unknown place must cost the ~6k-row
 * feed nothing.
 */

const statements: { sql: string; params: unknown[] }[] = [];
let rows: Record<string, unknown>[] = [];

vi.mock('@sportkarta/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sportkarta/db')>();
  return {
    ...actual,
    getDb: () => ({
      execute(query: SQL) {
        statements.push(renderSql(query));
        return Promise.resolve({ rows });
      },
    }),
  };
});

const FILTERS: PublicFilters = { sports: [], access: ['free'], onlyLit: false, surfaces: [] };

const ROWS = [
  {
    slug: 'stolichna-1',
    name: null,
    sport_types: ['football'],
    quarter: 'Лозенец',
    municipality_bg: 'Столична',
    municipality_en: 'Stolichna',
    lon: 23.33,
    lat: 42.67,
  },
  {
    slug: 'varna-1',
    name: 'Морска градина',
    sport_types: ['tennis'],
    quarter: null,
    municipality_bg: 'Варна',
    municipality_en: 'Varna',
    lon: 27.93,
    lat: 43.2,
  },
  {
    slug: 'nowhere-1',
    name: null,
    sport_types: [],
    quarter: null,
    municipality_bg: null,
    municipality_en: null,
    lon: 25,
    lat: 42.5,
  },
];

async function subject() {
  return import('@/lib/public-data');
}

afterEach(() => {
  statements.length = 0;
  rows = [];
});

describe('facilitiesGeoJSON (the /api/facilities feed)', () => {
  it('joins the municipality without losing the public visibility predicate', async () => {
    rows = ROWS;
    const { facilitiesGeoJSON } = await subject();
    await facilitiesGeoJSON(FILTERS, 'bg');
    const sql = statements[0]?.sql ?? '';
    expect(sql).toContain('LEFT JOIN municipalities m ON m.id = f.municipality_id');
    expect(sql).toContain(PUBLIC_FACILITY_PREDICATE);
    // A LEFT join: a facility outside every municipality polygon stays on the map.
    expect(sql.split('JOIN municipalities').length).toBe(
      sql.split('LEFT JOIN municipalities').length,
    );
  });

  it('labels each feature with its place, in the reader’s locale', async () => {
    rows = ROWS;
    const { facilitiesGeoJSON } = await subject();
    const bgFeed = await facilitiesGeoJSON(FILTERS, 'bg');
    expect(bgFeed.features.map((f) => f.properties.place)).toEqual([
      'Лозенец, София',
      'Варна',
      undefined,
    ]);
    const enFeed = await facilitiesGeoJSON(FILTERS, 'en');
    expect(enFeed.features[0]?.properties.place).toBe('Лозенец, Sofia');
    expect(enFeed.features[1]?.properties.place).toBe('Varna');
  });

  it('omits an unknown place instead of shipping a null for every row', async () => {
    rows = ROWS;
    const { facilitiesGeoJSON } = await subject();
    const feed = await facilitiesGeoJSON(FILTERS);
    expect('place' in (feed.features[2]?.properties ?? {})).toBe(false);
  });
});

describe('listPublicFacilities (the first-paint seed)', () => {
  it('carries the same place as the feed it is replaced by', async () => {
    rows = ROWS;
    const { listPublicFacilities } = await subject();
    const seed = await listPublicFacilities(FILTERS, 100, 'bg');
    expect(seed.map((f) => f.place)).toEqual(['Лозенец, София', 'Варна', null]);
    const sql = statements[0]?.sql ?? '';
    expect(sql).toContain('LEFT JOIN municipalities m ON m.id = f.municipality_id');
    expect(sql).toContain(PUBLIC_FACILITY_PREDICATE);
  });
});
