import { describe, expect, it } from 'vitest';

import {
  cellCenter,
  cellMapHref,
  cellOf,
  DOT_GRID,
  dotRadius,
  dotTier,
  EMPTY_RADIUS,
  inGrid,
  PITCH,
} from '@/lib/home/dot-grid';
import { legacyMapHref } from '@/lib/home/legacy-map-link';

/** The municipalities' extent in the dev and production imports. */
const EXTENT = { minLon: 22.357, maxLon: 28.609, minLat: 41.235, maxLat: 44.216 };

describe('the dot grid', () => {
  it('covers the whole country', () => {
    for (const [lon, lat] of [
      [EXTENT.minLon, EXTENT.minLat],
      [EXTENT.maxLon, EXTENT.maxLat],
      [EXTENT.minLon, EXTENT.maxLat],
      [EXTENT.maxLon, EXTENT.minLat],
    ] as const) {
      const { i, j } = cellOf(lon, lat);
      expect(inGrid(i, j), `${lon},${lat}`).toBe(true);
    }
  });

  it('puts a cell centre back in its own cell', () => {
    for (const [i, j] of [
      [0, 0],
      [13, 21],
      [DOT_GRID.cols - 1, DOT_GRID.rows - 1],
    ] as const) {
      const { lon, lat } = cellCenter(i, j);
      expect(cellOf(lon, lat)).toEqual({ i, j });
    }
  });

  it('places Sofia in the west and Varna in the east', () => {
    const sofia = cellOf(23.32, 42.7);
    const varna = cellOf(27.91, 43.21);
    expect(sofia.i).toBeLessThan(DOT_GRID.cols / 4);
    expect(varna.i).toBeGreaterThan((DOT_GRID.cols * 3) / 4);
    // North is up: Varna (43.2° N) sits higher than Sofia (42.7° N).
    expect(varna.j).toBeLessThan(sofia.j);
  });

  it('keeps cells roughly square on the ground', () => {
    const kmPerDegLat = 111.2;
    const kmPerDegLon = kmPerDegLat * Math.cos((42.7 * Math.PI) / 180);
    expect(DOT_GRID.dx * kmPerDegLon).toBeCloseTo(DOT_GRID.dy * kmPerDegLat, 6);
  });

  it('grows dots with the count and never lets neighbours touch', () => {
    expect(dotRadius(0)).toBe(EMPTY_RADIUS);
    expect(dotRadius(1)).toBeGreaterThan(EMPTY_RADIUS);
    expect(dotRadius(8)).toBeGreaterThan(dotRadius(2));
    expect(dotRadius(10_000)).toBeLessThan(PITCH / 2);
  });

  it('steps colour by count', () => {
    expect([1, 2, 5, 15, 50, 500].map(dotTier)).toEqual([1, 2, 3, 4, 5, 5]);
  });

  it('opens the map on a cell, with the sport when one is chosen', () => {
    expect(cellMapHref(10, 20, null)).toMatch(/^\/karta\?z=12&lat=\d+\.\d{4}&lng=\d+\.\d{4}$/);
    expect(cellMapHref(10, 20, 'tennis')).toMatch(/^\/karta\?sport=tennis&z=12&/);
  });
});

describe('links from when the map was the front page', () => {
  it('sends a filtered or focused map link to /karta, query intact', () => {
    expect(legacyMapHref({ sport: 'football' })).toBe('/karta?sport=football');
    expect(
      legacyMapHref({ selected: 'park-zaimov', z: '16', lat: '42.7', lng: '23.3', utm: 'x' }),
    ).toBe('/karta?selected=park-zaimov&z=16&lat=42.7&lng=23.3&utm=x');
    expect(legacyMapHref({ sport: ['football', 'tennis'] })).toBe(
      '/karta?sport=football&sport=tennis',
    );
  });

  it('leaves the front page alone', () => {
    expect(legacyMapHref({})).toBeNull();
    expect(legacyMapHref({ utm_source: 'newsletter' })).toBeNull();
  });
});
