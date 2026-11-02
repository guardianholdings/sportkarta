import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

import { BULGARIA_BBOX } from '@sportkarta/lib/geo';
import type { LayerSpecification } from 'maplibre-gl';
import { describe, expect, it } from 'vitest';

import {
  ATTRIBUTION,
  buildMapStyle,
  mapAssetUrls,
  NATIONAL_FIRST_LAYER,
  UNDERLAY_LAYER_IDS,
  UNDERLAY_SOURCE,
  underlayStyle,
  underlayUrl,
} from '../lib/map/style';
import {
  nationalCovers,
  nationalRange,
  skipUnderlayTile,
  UNDERLAY_LAYER_MAXZOOM,
  UNDERLAY_MAXZOOM,
  UNDERLAY_PATH,
} from '../lib/map/underlay';

/**
 * The regional underlay (operator request 2026-11-02): on desktop the map around Bulgaria
 * showed the flat background past the national archive's tiles. A small
 * low-zoom archive of the region is now drawn under the national one.
 */

const WEB_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(WEB_ROOT, '..', '..');
const read = (rel: string) => readFileSync(path.join(WEB_ROOT, rel), 'utf8');
const BUILD_SH = readFileSync(path.join(REPO_ROOT, 'scripts/build-tiles/build.sh'), 'utf8');

function shellVar(name: string): string {
  const match = new RegExp(`^\\s*${name}="([^"]+)"`, 'm').exec(BUILD_SH);
  if (!match?.[1]) throw new Error(`${name} not set in build.sh`);
  return match[1];
}

/** A tile's edges in degrees (web Mercator, XYZ). */
function tileEdges(z: number, x: number, y: number) {
  const n = 2 ** z;
  const lat = (row: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return {
    west: (x / n) * 360 - 180,
    east: ((x + 1) / n) * 360 - 180,
    north: lat(y),
    south: lat(y + 1),
  };
}

/** Whether the national archive has tile z/x/y: it keeps every tile touching its box. */
function nationalHas(z: number, x: number, y: number): boolean {
  const t = tileEdges(z, x, y);
  const b = BULGARIA_BBOX;
  return t.west < b.maxLon && t.east > b.minLon && t.south < b.maxLat && t.north > b.minLat;
}

/** The PMTiles v3 header fields this test needs. */
function pmtilesHeader(file: string) {
  const fd = openSync(file, 'r');
  const buf = Buffer.alloc(127);
  readSync(fd, buf, 0, 127, 0);
  closeSync(fd);
  return {
    magic: buf.subarray(0, 7).toString('latin1'),
    version: buf[7],
    minZoom: buf[100],
    maxZoom: buf[101],
    bounds: [102, 106, 110, 114].map((at) => buf.readInt32LE(at) / 1e7),
  };
}

describe('the regional archive', () => {
  const file = path.join(WEB_ROOT, 'public', UNDERLAY_PATH);

  it('is the file the map asks for, built from the date pinned in build.sh', () => {
    expect(UNDERLAY_PATH).toBe(`/basemap/region-${shellVar('REGION_BUILD')}.pmtiles`);
    expect(statSync(file).isFile()).toBe(true);
  });

  it('stays small: zooms 0–7 over the region, not the 40 MB z8 build', () => {
    const size = statSync(file).size;
    expect(size).toBeGreaterThan(5_000_000);
    expect(size).toBeLessThan(20_000_000);
    const header = pmtilesHeader(file);
    expect(header.magic).toBe('PMTiles');
    expect(header.version).toBe(3);
    expect(header.minZoom).toBe(0);
    expect(header.maxZoom).toBe(UNDERLAY_MAXZOOM);
    expect(String(UNDERLAY_MAXZOOM)).toBe(shellVar('REGION_MAXZOOM'));
    expect(header.bounds).toEqual(shellVar('REGION_BBOX').split(',').map(Number));
  });

  it('shares its notion of the national archive with build.sh', () => {
    // The skip rule below is only right if the national archive's box is the
    // one the map's box is: both come from the facilities CHECK (lon 22..29,
    // lat 41..44.5).
    const b = BULGARIA_BBOX;
    expect(shellVar('BBOX').split(',').map(Number)).toEqual([
      b.minLon,
      b.minLat,
      b.maxLon,
      b.maxLat,
    ]);
  });
});

describe('underlay tiles the national archive covers', () => {
  it('match the archive’s edges: 45.09° N and 40.98° N at z6', () => {
    const r = nationalRange(6);
    expect(tileEdges(6, r.x0, r.y0).north).toBeCloseTo(45.09, 2);
    expect(tileEdges(6, r.x1, r.y1).south).toBeCloseTo(40.98, 2);
  });

  it('are skipped below the last zoom exactly where the national tile exists', () => {
    for (let z = 0; z < UNDERLAY_MAXZOOM; z++) {
      for (let x = 0; x < 2 ** z; x++) {
        for (let y = 0; y < 2 ** z; y++) {
          expect(nationalCovers(z, x, y), `${z}/${x}/${y}`).toBe(nationalHas(z, x, y));
        }
      }
    }
  });

  it('at the last zoom, only the two tiles over southern Bulgaria (Sofia, Plovdiv, Burgas)', () => {
    const covered: string[] = [];
    for (let x = 0; x < 2 ** UNDERLAY_MAXZOOM; x++) {
      for (let y = 0; y < 2 ** UNDERLAY_MAXZOOM; y++) {
        if (nationalCovers(UNDERLAY_MAXZOOM, x, y)) covered.push(`${x}/${y}`);
      }
    }
    expect(covered).toEqual(['72/47', '73/47']);
  });

  it('never leave a hole: every zoom that shows a skipped tile has national tiles over all of it', () => {
    // Below the last zoom a tile is shown from its own zoom to the next; the
    // last zoom's tiles are shown, enlarged, up to UNDERLAY_LAYER_MAXZOOM.
    for (let z = 0; z <= UNDERLAY_MAXZOOM; z++) {
      const deepest = z < UNDERLAY_MAXZOOM ? z : UNDERLAY_LAYER_MAXZOOM - 1;
      for (let x = 0; x < 2 ** z; x++) {
        for (let y = 0; y < 2 ** z; y++) {
          if (!nationalCovers(z, x, y)) continue;
          for (let t = z; t <= deepest; t++) {
            const k = 2 ** (t - z);
            for (let cx = x * k; cx < (x + 1) * k; cx++) {
              for (let cy = y * k; cy < (y + 1) * k; cy++) {
                expect(nationalHas(t, cx, cy), `${z}/${x}/${y} at ${t}/${cx}/${cy}`).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it('are answered empty by the protocol; TileJSON and national tiles pass through', () => {
    const underlay = `pmtiles://http://localhost:3000${UNDERLAY_PATH}`;
    const national = 'pmtiles://http://localhost:3000/tiles/bulgaria.pmtiles';
    expect(skipUnderlayTile(`${underlay}/7/72/47`)).toBe(true);
    expect(skipUnderlayTile(`${underlay}/6/36/23`)).toBe(true);
    expect(skipUnderlayTile(`${underlay}/7/72/46`)).toBe(false);
    expect(skipUnderlayTile(`${underlay}/6/34/23`)).toBe(false);
    expect(skipUnderlayTile(underlay)).toBe(false);
    expect(skipUnderlayTile(`${national}/7/72/47`)).toBe(false);
    expect(read('lib/map/pmtiles.ts')).toMatch(
      /skipUnderlayTile\(params\.url\)\s*\?\s*Promise\.resolve\(\{ data: new Uint8Array\(\) \}\)/,
    );
  });
});

describe('the underlay in the style', () => {
  const origin = 'http://localhost:3000';
  const plain = buildMapStyle(mapAssetUrls(origin));
  const withUnderlay = buildMapStyle({ ...mapAssetUrls(origin), underlayUrl: underlayUrl(origin) });
  const ids = (layers: LayerSpecification[]) => layers.map((layer) => layer.id);

  it('is absent unless asked for: the phone and the place listings keep one source', () => {
    expect(Object.keys(plain.sources)).toEqual(['protomaps']);
    expect(ids(plain.layers).some((id) => id.startsWith(`${UNDERLAY_SOURCE}-`))).toBe(false);
  });

  it('is a second source, same origin, with the same credit line', () => {
    expect(withUnderlay.sources[UNDERLAY_SOURCE]).toEqual({
      type: 'vector',
      url: `pmtiles://${origin}${UNDERLAY_PATH}`,
      attribution: ATTRIBUTION,
    });
    expect(withUnderlay.sources.protomaps).toEqual(plain.sources.protomaps);
  });

  it('draws under every national layer, with the same layers and paint', () => {
    const all = ids(withUnderlay.layers);
    const firstNational = all.indexOf(NATIONAL_FIRST_LAYER);
    const underlayIds = all.filter((id) => id.startsWith(`${UNDERLAY_SOURCE}-`));
    expect(underlayIds).toEqual([...UNDERLAY_LAYER_IDS]);
    expect(underlayIds.length).toBeGreaterThan(10);
    for (const id of underlayIds) expect(all.indexOf(id)).toBeLessThan(firstNational);
    expect(all[0]).toBe('background');

    const national = plain.layers.filter((layer) => layer.id !== 'background');
    const underlay = withUnderlay.layers.filter((layer) =>
      layer.id.startsWith(`${UNDERLAY_SOURCE}-`),
    );
    expect(underlay).toHaveLength(national.length);
    underlay.forEach((layer, i) => {
      const twin = national[i] as LayerSpecification & { source: string };
      expect(layer).toEqual({
        ...twin,
        id: `${UNDERLAY_SOURCE}-${twin.id}`,
        source: UNDERLAY_SOURCE,
        maxzoom: UNDERLAY_LAYER_MAXZOOM,
      });
    });
  });

  it('can be added after the map has started, under the national layers', () => {
    const late = underlayStyle(underlayUrl(origin));
    expect(late.source).toEqual(withUnderlay.sources[UNDERLAY_SOURCE]);
    expect(late.layers).toEqual(
      withUnderlay.layers.filter((layer) => layer.id.startsWith(`${UNDERLAY_SOURCE}-`)),
    );
    expect(read('components/map/map-canvas.tsx')).toMatch(
      /map\.addLayer\(layer, NATIONAL_FIRST_LAYER\)/,
    );
  });
});
