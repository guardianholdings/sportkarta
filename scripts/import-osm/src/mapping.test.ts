import { describe, expect, it } from 'vitest';

import { mapAccess, mapCovered, mapLighting, mapSports, mapSurface } from './mapping.js';
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

  it('implies fitness for sport-less fitness_station only', () => {
    expect(mapSports(undefined, 'fitness_station').sports).toEqual(['fitness']);
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
    expect(mapAccess({ leisure: 'pitch' })).toBe('free');
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
