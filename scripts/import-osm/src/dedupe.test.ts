import { describe, expect, it } from 'vitest';

import { findDuplicates, haversineM, type DedupeInput } from './dedupe.js';

// A Sofia park; offsets below are in metres, converted at this latitude.
const LON = 23.3389;
const LAT = 42.6839;
const M_PER_DEG_LAT = 111_132;
const M_PER_DEG_LON = 111_320 * Math.cos((LAT * Math.PI) / 180);

function at(
  key: string,
  eastM: number,
  northM: number,
  overrides: Partial<DedupeInput> = {},
): DedupeInput {
  const [type] = key.split(':');
  const osmType = type as DedupeInput['osmType'];
  return {
    key,
    osmType,
    geometryKind: osmType === 'node' ? 'Point' : 'MultiPolygon',
    sportTypes: ['fitness'],
    lon: LON + eastM / M_PER_DEG_LON,
    lat: LAT + northM / M_PER_DEG_LAT,
    existing: false,
    ...overrides,
  };
}

describe('haversineM', () => {
  it('measures metres at Bulgarian latitudes', () => {
    const a = at('node:1', 0, 0);
    const b = at('node:2', 3, 4);
    expect(haversineM(a.lon, a.lat, b.lon, b.lat)).toBeCloseTo(5, 1);
  });
});

describe('findDuplicates', () => {
  it('keeps the polygon and drops the node mapped on top of it (the production case)', () => {
    const result = findDuplicates([at('node:1', 0, 0), at('way:2', 2, 1)]);
    expect(result.dropped).toEqual([
      { keep: 'way:2', drop: 'node:1', distanceM: expect.any(Number) },
    ]);
    expect(result.dropped[0]?.distanceM).toBeCloseTo(Math.hypot(2, 1), 1);
    expect(result.existingPairs).toEqual([]);
  });

  it('prefers relation over way when both are polygons', () => {
    const result = findDuplicates([at('way:2', 0, 0), at('relation:3', 1, 0)]);
    expect(result.dropped.map((d) => [d.keep, d.drop])).toEqual([['relation:3', 'way:2']]);
  });

  it('prefers a polygon over a line whatever the element type', () => {
    const result = findDuplicates([
      at('relation:3', 0, 0, { geometryKind: 'LineString' }),
      at('way:2', 1, 0),
    ]);
    expect(result.dropped.map((d) => [d.keep, d.drop])).toEqual([['way:2', 'relation:3']]);
  });

  it('never folds same-type objects: two tables side by side are two tables', () => {
    const result = findDuplicates([
      at('node:1', 0, 0, { sportTypes: ['table_tennis'] }),
      at('node:2', 1, 0, { sportTypes: ['table_tennis'] }),
      at('way:3', 0, 0, { sportTypes: ['tennis'] }),
      at('way:4', 1, 0, { sportTypes: ['tennis'] }),
    ]);
    expect(result).toEqual({ dropped: [], existingPairs: [] });
  });

  it('needs a shared sport — a sport-less pitch never swallows anything', () => {
    expect(
      findDuplicates([at('node:1', 0, 0, { sportTypes: ['chess'] }), at('way:2', 1, 0)]).dropped,
    ).toEqual([]);
    expect(
      findDuplicates([at('node:1', 0, 0), at('way:2', 1, 0, { sportTypes: [] })]).dropped,
    ).toEqual([]);
    expect(
      findDuplicates([
        at('node:1', 0, 0, { sportTypes: ['basketball', 'fitness'] }),
        at('way:2', 1, 0, { sportTypes: ['fitness', 'football'] }),
      ]).dropped,
    ).toHaveLength(1);
  });

  it('stops at the radius', () => {
    expect(findDuplicates([at('node:1', 0, 0), at('way:2', 4.9, 0)]).dropped).toHaveLength(1);
    expect(findDuplicates([at('node:1', 0, 0), at('way:2', 5.2, 0)]).dropped).toEqual([]);
    // Across a grid-cell boundary in both axes, still found.
    const edge = at('node:1', 0, 0);
    const snapped = { ...edge, lon: Math.floor(LON / 0.0001) * 0.0001 - 1e-7 };
    const across = { ...at('way:2', 0, 0), lon: snapped.lon + 3 / M_PER_DEG_LON };
    expect(findDuplicates([snapped, across]).dropped).toHaveLength(1);
  });

  it('never drops a row that already exists — the new one yields', () => {
    const result = findDuplicates([at('node:1', 0, 0, { existing: true }), at('way:2', 1, 0)]);
    expect(result.dropped.map((d) => [d.keep, d.drop])).toEqual([['node:1', 'way:2']]);
  });

  it('reports two existing rows instead of deciding between them', () => {
    const result = findDuplicates([
      at('node:1', 0, 0, { existing: true }),
      at('way:2', 1, 0, { existing: true }),
    ]);
    expect(result.dropped).toEqual([]);
    expect(result.existingPairs.map((d) => [d.keep, d.drop])).toEqual([['way:2', 'node:1']]);
  });

  it('only drops in favour of a row that really stays', () => {
    // A table-tennis area (new way) sits between two tables; the one on the
    // left was imported long ago. The area yields to it, and the right-hand
    // table must NOT then be dropped as a duplicate of the area that is not
    // there — it is a separate table.
    const result = findDuplicates([
      at('node:1', -3, 0, { existing: true, sportTypes: ['table_tennis'] }),
      at('way:2', 0, 0, { sportTypes: ['table_tennis'] }),
      at('node:3', 3, 0, { sportTypes: ['table_tennis'] }),
    ]);
    expect(result.dropped.map((d) => [d.keep, d.drop])).toEqual([['node:1', 'way:2']]);
  });

  it('folds a node, way and relation of one place into the relation', () => {
    const result = findDuplicates([at('node:1', 0, 0), at('way:2', 1, 0), at('relation:3', 0, 1)]);
    expect(result.dropped.map((d) => [d.keep, d.drop])).toEqual([
      ['relation:3', 'node:1'],
      ['relation:3', 'way:2'],
    ]);
  });

  it('is independent of input order', () => {
    const inputs = [
      at('node:1', 0, 0),
      at('way:2', 1, 0),
      at('node:5', 2, 2, { existing: true }),
      at('relation:9', 30, 0),
      at('node:10', 31, 0),
    ];
    const forward = findDuplicates(inputs);
    const backward = findDuplicates([...inputs].reverse());
    expect(backward).toEqual(forward);
  });
});
