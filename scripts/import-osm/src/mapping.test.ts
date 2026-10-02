import { CANONICAL_SPORTS, CANONICAL_SURFACES } from '@sportkarta/lib';
import { describe, expect, it } from 'vitest';

import {
  lifecycleState,
  mapAccess,
  mapCovered,
  mapLighting,
  mapSports,
  mapSurface,
  PAID_BY_DEFAULT_LEISURE,
  SPORT_MAP,
  SURFACE_MAP,
} from './mapping.js';
import { normalizeFeature, parseOsmRef, preferCandidate, type OsmFeature } from './normalize.js';

function feature(
  id: string,
  tags: Record<string, string>,
  geometry: OsmFeature['geometry'] = { type: 'Point', coordinates: [23.32, 42.7] },
): OsmFeature {
  return { type: 'Feature', id, properties: tags, geometry };
}

describe('mapSports', () => {
  it('maps multi-values, dedupes, sorts, collects unmapped tokens', () => {
    expect(mapSports('soccer;basketball;soccer', undefined)).toEqual({
      sports: ['basketball', 'football'],
      unmapped: [],
    });
    expect(mapSports('tennis; motocross', undefined)).toEqual({
      sports: ['tennis'],
      unmapped: ['motocross'],
    });
  });

  it('implies fitness for sport-less fitness_station and fitness_centre only', () => {
    expect(mapSports(undefined, 'fitness_station').sports).toEqual(['fitness']);
    expect(mapSports(undefined, 'fitness_centre').sports).toEqual(['fitness']);
    expect(mapSports(undefined, 'pitch').sports).toEqual([]);
    expect(mapSports(undefined, 'track').sports).toEqual([]);
  });
});

describe('mapSurface / mapLighting', () => {
  it('normalizes surface families and reports unknowns', () => {
    expect(mapSurface('artificial_grass')).toEqual({ surface: 'artificial_turf' });
    expect(mapSurface('fine_gravel')).toEqual({ surface: 'unpaved' });
    expect(mapSurface(undefined)).toEqual({ surface: null });
    expect(mapSurface('lava')).toEqual({ surface: null, unmapped: 'lava' });
  });

  it('keeps lighting tri-state', () => {
    expect(mapLighting('yes')).toEqual({ lighting: true });
    expect(mapLighting('24/7')).toEqual({ lighting: true });
    expect(mapLighting('no')).toEqual({ lighting: false });
    expect(mapLighting(undefined)).toEqual({ lighting: null });
    expect(mapLighting('sunset-sunrise')).toEqual({ lighting: null, unusual: 'sunset-sunrise' });
  });
});

describe('mapCovered / mapAccess', () => {
  it('covered from covered/indoor/building', () => {
    expect(mapCovered({ covered: 'yes' })).toBe(true);
    expect(mapCovered({ indoor: 'yes' })).toBe(true);
    expect(mapCovered({ building: 'sports_hall' })).toBe(true);
    expect(mapCovered({ building: 'no' })).toBe(false);
    expect(mapCovered({})).toBe(false);
  });

  it('access rule order: restricted > paid > free; sports_centre defaults paid', () => {
    expect(mapAccess({ access: 'private', fee: 'no' })).toBe('restricted');
    expect(mapAccess({ fee: 'yes' })).toBe('paid');
    expect(mapAccess({ access: 'customers' })).toBe('paid');
    expect(mapAccess({ leisure: 'sports_centre' })).toBe('paid');
    expect(mapAccess({ leisure: 'sports_centre', fee: 'no' })).toBe('free');
    expect(mapAccess({ leisure: 'fitness_centre' })).toBe('paid');
    expect(mapAccess({ leisure: 'fitness_centre', fee: 'no' })).toBe('free');
    expect(mapAccess({ leisure: 'pitch' })).toBe('free');
  });

  // Audit finding 80: 137 pools, 6 ice rinks, 5 riding venues and 2 water
  // parks were published as free because nothing said otherwise.
  it.each([...PAID_BY_DEFAULT_LEISURE])('%s is paid unless OSM says it is free', (leisure) => {
    expect(mapAccess({ leisure })).toBe('paid');
    expect(mapAccess({ leisure, sport: 'swimming' })).toBe('paid');
    expect(mapAccess({ leisure, access: 'permissive' })).toBe('paid');
    expect(mapAccess({ leisure, fee: 'no' })).toBe('free');
    expect(mapAccess({ leisure, access: 'yes' })).toBe('free');
    expect(mapAccess({ leisure, access: 'public' })).toBe('free');
    expect(mapAccess({ leisure, access: 'Yes' })).toBe('free');
    // An explicit fee still beats an access claim, as for every other venue.
    expect(mapAccess({ leisure, access: 'yes', fee: 'yes' })).toBe('paid');
    // A private pool is restricted, not paid.
    expect(mapAccess({ leisure, access: 'private' })).toBe('restricted');
    expect(mapAccess({ leisure, access: 'no' })).toBe('restricted');
  });

  it('does not extend the access=yes exception to the older paid defaults', () => {
    // Unchanged by the 2026-09-29 amendment: a sports centre or a gym is paid
    // unless it says fee=no.
    expect(mapAccess({ leisure: 'sports_centre', access: 'yes' })).toBe('paid');
    expect(mapAccess({ leisure: 'fitness_centre', access: 'public' })).toBe('paid');
  });

  it('keeps a free-by-nature sport object free: a lake swimming spot is not a pool', () => {
    expect(mapAccess({ sport: 'swimming', natural: 'water' })).toBe('free');
    expect(mapAccess({ leisure: 'pitch', sport: 'equestrian' })).toBe('free');
  });
});

describe('lifecycleState', () => {
  it('reads the plain lifecycle keys', () => {
    expect(lifecycleState({ leisure: 'pitch', abandoned: 'yes' })).toBe('abandoned');
    expect(lifecycleState({ leisure: 'pitch', disused: 'yes' })).toBe('disused');
    expect(lifecycleState({ leisure: 'pitch', disused: 'YES' })).toBe('disused');
    expect(lifecycleState({ leisure: 'pitch', disused: 'no' })).toBeUndefined();
    expect(lifecycleState({ leisure: 'pitch' })).toBeUndefined();
  });

  it('reads any lifecycle-prefixed key', () => {
    expect(lifecycleState({ sport: 'soccer', 'disused:leisure': 'pitch' })).toBe('disused');
    expect(lifecycleState({ sport: 'swimming', 'abandoned:leisure': 'swimming_pool' })).toBe(
      'abandoned',
    );
    expect(lifecycleState({ 'abandoned:sport': 'tennis' })).toBe('abandoned');
  });

  it('is not fooled by keys that merely contain the word', () => {
    expect(
      lifecycleState({ leisure: 'pitch', note: 'disused:leisure was removed' }),
    ).toBeUndefined();
    expect(lifecycleState({ leisure: 'pitch', 'name:disused': 'x' })).toBeUndefined();
  });
});

describe('parseOsmRef', () => {
  it('parses type_id ids and decodes libosmium area ids', () => {
    expect(parseOsmRef('n42')).toEqual({ type: 'node', id: 42 });
    expect(parseOsmRef('w42')).toEqual({ type: 'way', id: 42 });
    expect(parseOsmRef('r42')).toEqual({ type: 'relation', id: 42 });
    expect(parseOsmRef('a84')).toEqual({ type: 'way', id: 42 });
    expect(parseOsmRef('a85')).toEqual({ type: 'relation', id: 42 });
    expect(parseOsmRef('x1')).toBeNull();
    expect(parseOsmRef(undefined)).toBeNull();
  });
});

describe('normalizeFeature', () => {
  it('imports a plain pitch and prefers name:bg', () => {
    const r = normalizeFeature(
      feature('w10', {
        leisure: 'pitch',
        sport: 'soccer',
        'name:bg': 'Игрище Юнак',
        name: 'Yunak pitch',
        surface: 'grass',
        lit: 'yes',
      }),
    );
    expect(r.kind).toBe('candidate');
    if (r.kind !== 'candidate') return;
    expect(r.candidate).toMatchObject({
      osmType: 'way',
      osmId: 10,
      name: 'Игрище Юнак',
      sportTypes: ['football'],
      surface: 'grass',
      lighting: true,
      covered: false,
      access: 'free',
    });
  });

  it('enforces the approved skip rules', () => {
    const cases: [OsmFeature, string][] = [
      [feature('n1', { leisure: 'playground' }), 'playground_without_sport'],
      [feature('n2', { sport: 'billiards', shop: 'sports' }), 'shop_not_facility'],
      [feature('n3', { sport: 'darts', amenity: 'pub' }), 'venue_not_facility'],
      [feature('n4', { sport: 'swimming', tourism: 'hotel' }), 'tourism_not_facility'],
      [feature('n5', { sport: 'chess', club: 'chess' }), 'club_not_facility'],
      [feature('r6', { sport: 'running', type: 'route' }), 'route_relation'],
      [feature('n7', { sport: 'motocross' }), 'unmapped_sport_only'],
      [feature('n8', { leisure: 'pitch', sport: 'soccer' }, null), 'no_geometry'],
      [
        feature('n9', { leisure: 'pitch' }, { type: 'Point', coordinates: [2.35, 48.86] }),
        'outside_bbox',
      ],
    ];
    for (const [f, reason] of cases) {
      const r = normalizeFeature(f);
      expect(r.kind, `expected skip for ${String(f.id)}`).toBe('skip');
      if (r.kind === 'skip') expect(r.reason).toBe(reason);
    }
  });

  it('playground WITH sport imports; sport-less pitch imports with report bucket', () => {
    const playground = normalizeFeature(
      feature('n20', { leisure: 'playground', sport: 'basketball' }),
    );
    expect(playground.kind).toBe('candidate');

    const barePitch = normalizeFeature(feature('w21', { leisure: 'pitch' }));
    expect(barePitch.kind).toBe('candidate');
    if (barePitch.kind === 'candidate') {
      expect(barePitch.candidate.sportTypes).toEqual([]);
      expect(barePitch.candidate.noSportBucket).toBe('pitch_no_sport');
    }
  });

  it('withdraws lifecycle-tagged objects with their ref, before any other rule', () => {
    expect(
      normalizeFeature(feature('w40', { leisure: 'pitch', sport: 'soccer', abandoned: 'yes' })),
    ).toEqual({ kind: 'withdrawn', osmType: 'way', osmId: 40, state: 'abandoned' });
    expect(
      normalizeFeature(feature('a82', { sport: 'swimming', 'disused:leisure': 'swimming_pool' })),
    ).toEqual({ kind: 'withdrawn', osmType: 'way', osmId: 41, state: 'disused' });
    // Even one a later rule would have skipped: the ref is what matters.
    expect(
      normalizeFeature(feature('n42', { sport: 'darts', amenity: 'pub', disused: 'yes' })),
    ).toMatchObject({ kind: 'withdrawn', osmId: 42 });
  });

  it('prices a pool from its own tags end to end', () => {
    const pool = normalizeFeature(
      feature('w50', { leisure: 'swimming_pool', sport: 'swimming', name: 'Плувен комплекс' }),
    );
    expect(pool.kind === 'candidate' && pool.candidate.access).toBe('paid');
    const publicPool = normalizeFeature(
      feature('w51', { leisure: 'swimming_pool', sport: 'swimming', access: 'yes' }),
    );
    expect(publicPool.kind === 'candidate' && publicPool.candidate.access).toBe('free');
  });

  it('lat/lon swap lands outside the bbox screen', () => {
    const r = normalizeFeature(
      feature('n30', { leisure: 'pitch' }, { type: 'Point', coordinates: [42.7, 23.32] }),
    );
    expect(r).toEqual({ kind: 'skip', reason: 'outside_bbox' });
  });
});

describe('preferCandidate', () => {
  const make = (geometryKind: string) =>
    ({ osmType: 'way', osmId: 1, geometryKind }) as Parameters<typeof preferCandidate>[0];

  it('polygon beats its perimeter-ring twin regardless of order', () => {
    expect(preferCandidate(make('LineString'), make('MultiPolygon')).geometryKind).toBe(
      'MultiPolygon',
    );
    expect(preferCandidate(make('MultiPolygon'), make('LineString')).geometryKind).toBe(
      'MultiPolygon',
    );
  });

  it('ties keep the first candidate seen', () => {
    const first = make('Point');
    expect(preferCandidate(first, make('Point'))).toBe(first);
  });
});

describe('canonical vocabulary (lib is the single source)', () => {
  it('every mapped sport and surface value is canonical', () => {
    for (const v of Object.values(SPORT_MAP)) expect(CANONICAL_SPORTS).toContain(v);
    for (const v of Object.values(SURFACE_MAP)) expect(CANONICAL_SURFACES).toContain(v);
  });
});
