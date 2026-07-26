import { describe, expect, it } from 'vitest';

import { BULGARIA_BBOX, BULGARIA_BOUNDS, BULGARIA_CENTER, insideBulgaria } from './index.js';

/**
 * Where Bulgaria is, pinned.
 *
 * The box previously existed as five separate literals — the add-facility
 * validator, the municipal normaliser, the OSM importer, the map's zoom floor
 * and the home page's URL parser — plus a sixth as a database CHECK. They agreed
 * by coincidence. These tests make the agreement structural, and the
 * `db/src/geo-bounds.test.ts` companion checks it against the CHECK that
 * actually enforces it.
 */

describe('BULGARIA_BBOX', () => {
  it('is the box the database CHECK enforces', () => {
    // facilities_geom_in_bulgaria, migration 0001. A change here that is not
    // also a migration produces rows the app accepts and Postgres refuses.
    expect(BULGARIA_BBOX).toEqual({ minLon: 22.0, maxLon: 29.0, minLat: 41.0, maxLat: 44.5 });
  });

  it('contains the whole country with slack on every side', () => {
    // Bulgaria's true extent, to two decimals.
    const extremes = {
      west: 22.36,
      east: 28.61,
      south: 41.24,
      north: 44.22,
    };
    expect(BULGARIA_BBOX.minLon).toBeLessThan(extremes.west);
    expect(BULGARIA_BBOX.maxLon).toBeGreaterThan(extremes.east);
    expect(BULGARIA_BBOX.minLat).toBeLessThan(extremes.south);
    expect(BULGARIA_BBOX.maxLat).toBeGreaterThan(extremes.north);
  });

  it('accepts real Bulgarian places, corner to corner', () => {
    const places = [
      { name: 'Sofia', lon: 23.32, lat: 42.7 },
      { name: 'Varna (east)', lon: 27.91, lat: 43.2 },
      { name: 'Vidin (north-west)', lon: 22.87, lat: 43.99 },
      { name: 'Svilengrad (south-east)', lon: 26.2, lat: 41.77 },
      { name: 'Kardzhali (south)', lon: 25.37, lat: 41.65 },
      { name: 'Musala summit', lon: 23.585, lat: 42.179 },
    ];
    for (const place of places) {
      expect(insideBulgaria(place), place.name).toBe(true);
    }
  });

  it('rejects places that are actually elsewhere', () => {
    const elsewhere = [
      { name: 'Thessaloniki', lon: 22.94, lat: 40.64 },
      { name: 'Belgrade', lon: 20.45, lat: 44.79 },
      { name: 'Skopje', lon: 21.43, lat: 41.99 },
      { name: 'Berlin', lon: 13.4, lat: 52.52 },
      { name: 'Cairo', lon: 31.24, lat: 30.04 },
      { name: 'null island', lon: 0, lat: 0 },
    ];
    for (const place of elsewhere) {
      expect(insideBulgaria(place), place.name).toBe(false);
    }
  });

  /**
   * THE COST OF THE SLACK, written down rather than discovered later.
   *
   * The box is a rectangle and Bulgaria is not, so its corners reach into the
   * neighbours: Bucharest and the European edge of Istanbul both fall inside it.
   * That is ACCEPTED and is the direct consequence of the slack the box needs
   * for border facilities — see the module header. It is safe because the box is
   * never the last word: `ST_Contains` against the municipality polygons is what
   * actually decides which municipality a facility belongs to, and a point in
   * Romania resolves to none.
   *
   * It also means the map's pan limit lets a member see a little of Romania and
   * Turkey at the edges, which is what any national map does at its borders. It
   * does NOT let them pan away from Bulgaria, which is the thing that matters.
   *
   * This test exists so that tightening the box "because Bucharest is in it"
   * fails loudly and sends the reader to the reasoning first.
   */
  it('deliberately includes some near-border foreign ground', () => {
    expect(insideBulgaria({ lon: 26.1, lat: 44.43 }), 'Bucharest').toBe(true);
    expect(insideBulgaria({ lon: 28.98, lat: 41.01 }), 'Istanbul').toBe(true);
  });

  /**
   * THE TRAP A NAIVE RANGE CHECK FALLS INTO. `NaN < 22` is false and so is
   * `NaN > 29`, so a chain of comparisons ACCEPTS NaN — which is how a missing
   * coordinate becomes a facility at the origin of the world.
   */
  it('rejects NaN and Infinity rather than letting them through', () => {
    for (const bad of [
      { lon: Number.NaN, lat: 42 },
      { lon: 25, lat: Number.NaN },
      { lon: Infinity, lat: 42 },
      { lon: 25, lat: -Infinity },
    ]) {
      expect(insideBulgaria(bad)).toBe(false);
    }
  });

  it('includes its own edges, so a border facility is enterable', () => {
    expect(insideBulgaria({ lon: BULGARIA_BBOX.minLon, lat: BULGARIA_BBOX.minLat })).toBe(true);
    expect(insideBulgaria({ lon: BULGARIA_BBOX.maxLon, lat: BULGARIA_BBOX.maxLat })).toBe(true);
  });
});

describe('BULGARIA_BOUNDS', () => {
  /**
   * MapLibre wants `[[west, south], [east, north]]`. Getting the order wrong
   * produces an inverted box that silently locks the map to nowhere, which
   * looks like a broken map rather than a wrong constant.
   */
  it('is the same box in MapLibre’s south-west / north-east order', () => {
    expect(BULGARIA_BOUNDS).toEqual([
      [BULGARIA_BBOX.minLon, BULGARIA_BBOX.minLat],
      [BULGARIA_BBOX.maxLon, BULGARIA_BBOX.maxLat],
    ]);
    const [[west, south], [east, north]] = BULGARIA_BOUNDS;
    expect(west).toBeLessThan(east);
    expect(south).toBeLessThan(north);
  });
});

describe('BULGARIA_CENTER', () => {
  it('sits inside the box it opens on', () => {
    expect(insideBulgaria({ lon: BULGARIA_CENTER.lng, lat: BULGARIA_CENTER.lat })).toBe(true);
  });
});
