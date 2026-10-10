import { readFileSync } from 'node:fs';
import path from 'node:path';

import { BULGARIA_BOUNDS, insideBulgaria } from '@sportkarta/lib/geo';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clampCenter,
  FIT_MARGIN_PX,
  insideVisibleFrame,
  latitudeAt,
  mercatorY,
  southLimitLat,
  widthFitZoom,
} from '../components/map/camera';
import { createCluster, createPin } from '../components/map/markers';

/**
 * The map's camera rules, which an audit found broken on phones:
 *   - the first view was a fixed z6.8 that left Sofia, Varna and Burgas off a
 *     390px screen;
 *   - with the zoom floor lifted, the map had no pan limit at all, and two
 *     flicks reached Mali;
 *   - clusters were aria-hidden, so at the national view — every facility in a
 *     cluster — the map could not be expanded without a pointer.
 */

const WEB_ROOT = path.join(__dirname, '..');
const read = (rel: string) => readFileSync(path.join(WEB_ROOT, rel), 'utf8');

/** Web-mercator longitude span, in degrees, of `pixels` at `zoom`. */
function lonSpan(pixels: number, zoom: number): number {
  return (pixels / (512 * 2 ** zoom)) * 360;
}

describe('first view', () => {
  it('a fixed z6.8 camera cannot show the whole country on a phone', () => {
    // The regression, stated as arithmetic: 390px at z6.8 spans ~2.5° of
    // longitude, and Sofia (23.3 E) to Varna (27.9 E) is 4.6°.
    expect(lonSpan(390, 6.8)).toBeLessThan(27.9 - 23.3);
  });

  it('the width-fit zoom puts the whole box across the screen, margins included', () => {
    const [[west], [east]] = BULGARIA_BOUNDS;
    for (const width of [360, 390, 430, 768, 1280]) {
      const zoom = widthFitZoom(width, BULGARIA_BOUNDS);
      expect(lonSpan(width - 2 * FIT_MARGIN_PX, zoom)).toBeCloseTo(east - west, 6);
    }
  });

  it('the home page no longer hands the canvas a fixed camera when the URL has none', () => {
    const page = read('app/[locale]/(map)/page.tsx');
    expect(page).not.toMatch(/return \{ \.\.\.BULGARIA_CENTER \}/);
    expect(page).toMatch(/function parseView\(sp: SearchParams\): MapView \| null/);
    // …and the canvas fits the box for a null view instead.
    const canvas = read('components/map/map-canvas.tsx');
    expect(canvas).toMatch(/useRef\(initialView === null\)/);
    expect(canvas).toMatch(/cameraForBounds\(BG_BOUNDS/);
  });
});

describe('phone pan limit', () => {
  it('keeps a centre that is already in Bulgaria exactly where it is', () => {
    const sofia = { lng: 23.32, lat: 42.7 };
    expect(clampCenter(sofia, BULGARIA_BOUNDS)).toEqual(sofia);
  });

  it('pulls a centre dragged to Mali back to the country’s edge', () => {
    // The audit's own end point: lat 14.26, lng -8.43.
    const back = clampCenter({ lng: -8.43189, lat: 14.25522 }, BULGARIA_BOUNDS);
    expect(back).toEqual({ lng: BULGARIA_BOUNDS[0][0], lat: BULGARIA_BOUNDS[0][1] });
    expect(insideBulgaria({ lon: back.lng, lat: back.lat })).toBe(true);
  });

  it('clamps each axis on its own, so sliding along the border still works', () => {
    const north = clampCenter({ lng: 25, lat: 47 }, BULGARIA_BOUNDS);
    expect(north).toEqual({ lng: 25, lat: BULGARIA_BOUNDS[1][1] });
  });

  it('is installed on every layout, with the viewport box dropped', () => {
    const canvas = read('components/map/map-canvas.tsx');
    expect(canvas).toMatch(
      /map\.setMaxBounds\(null\);\s*map\.setTransformConstrain\(centreInBulgaria\);/,
    );
    // Desktop no longer goes back to the viewport box (see 'desktop fit').
    expect(canvas).not.toMatch(/setMaxBounds\(BG_BOUNDS\)/);
    expect(canvas).not.toMatch(/maxBounds: BG_BOUNDS/);
  });
});

/**
 * UX audit 2026-10-10: on desktop the first view never showed the whole
 * country — at 1440×900 Vidin and the coast were cut, at 1024×768 Sofia and
 * Varna were both off screen, and zooming out did nothing. `maxBounds` keeps
 * the whole VIEWPORT inside the box, and Bulgaria is wider than tall; a map
 * area narrower than the box can only zoom out until its HEIGHT fills the box,
 * by which point its width shows a slice of the country.
 */
describe('desktop fit', () => {
  const [[west, south], [east, north]] = BULGARIA_BOUNDS;
  // The country itself, west to east (BULGARIA_BOUNDS is a slightly larger box).
  const COUNTRY_WEST = 22.36;
  const COUNTRY_EAST = 28.61;
  /** Longitude span a viewport of `width` px shows at `zoom`. */
  const lonSpan = (width: number, zoom: number) => (width * 360) / (512 * 2 ** zoom);
  /** The lowest zoom `maxBounds` allowed: the viewport's height fills the box. */
  const viewportBoxFloor = (height: number) =>
    Math.log2(height / ((mercatorY(south) - mercatorY(north)) * 512));
  /** The floor now: the box fitted into the frame on BOTH axes. */
  const fittedFloor = (width: number, height: number) =>
    Math.min(
      widthFitZoom(width, BULGARIA_BOUNDS),
      Math.log2((height - 2 * FIT_MARGIN_PX) / ((mercatorY(south) - mercatorY(north)) * 512)),
    );

  // The map area beside the 460px list panel (nav rail + aside) on common screens.
  const TABLET = { name: '1024×768 tablet', width: 564, height: 768 };
  const CANVASES = [
    TABLET,
    { name: '1280×800 laptop', width: 820, height: 800 },
    { name: '1440×900 laptop', width: 980, height: 900 },
  ];

  it.each(CANVASES)('the viewport box cut the country on a $name', ({ width, height }) => {
    expect(lonSpan(width, viewportBoxFloor(height))).toBeLessThan(COUNTRY_EAST - COUNTRY_WEST);
  });

  it.each(CANVASES)('the fitted floor shows it side to side on a $name', ({ width, height }) => {
    expect(lonSpan(width, fittedFloor(width, height))).toBeGreaterThanOrEqual(east - west - 0.01);
  });

  it('keeps the frame on the tiles there too: the south limit applies to desktop frames', () => {
    // The fitted frame is taller than the country on these canvases, so the
    // spare room must go north (where the archive has map), not south.
    const { width, height } = TABLET;
    const zoom = fittedFloor(width, height);
    const centre = clampCenter({ lng: 25.3, lat: (south + north) / 2 }, BULGARIA_BOUNDS, {
      zoom,
      halfHeight: height / 2,
    });
    const bottom = latitudeAt(mercatorY(centre.lat) + height / 2 / (512 * 2 ** zoom));
    expect(bottom).toBeGreaterThanOrEqual(south - 1e-6);
  });

  it('computes the desktop floor from the fitted country, both axes', () => {
    const canvas = read('components/map/map-canvas.tsx');
    expect(canvas).toMatch(/const cam = unrestrictedRef\.current \? null : countryCamera\(\);/);
    expect(canvas).toMatch(/else if \(cam\?\.zoom !== undefined\)/);
  });
});

describe('a facility picked at the country view', () => {
  it('is shown, past the clustering, instead of left inside a number', () => {
    const canvas = read('components/map/map-canvas.tsx');
    const clusterMaxZoom = Number(/clusterMaxZoom: (\d+)/.exec(canvas)?.[1]);
    const revealZoom = Number(/const REVEAL_ZOOM = (\d+)/.exec(canvas)?.[1]);
    expect(revealZoom).toBeGreaterThan(clusterMaxZoom);
    // At the automatic fit the map goes to it; otherwise the member's zoom stays.
    expect(canvas).toMatch(
      /if \(autoFitRef\.current\) \{\s*autoFitRef\.current = false;\s*map\.easeTo\(\{ center: \[point\.lon, point\.lat\], zoom: REVEAL_ZOOM \}\);/,
    );
  });
});

describe('maps inside a scrolling page', () => {
  it('use cooperative gestures on the place listings, never on the home map', () => {
    expect(read('components/map/place-map.tsx')).toMatch(/\n\s*cooperative\n/);
    expect(read('components/map/map-canvas.tsx')).toMatch(/cooperativeGestures: cooperative/);
    expect(read('components/map/map-explorer.tsx')).not.toMatch(/\bcooperative\b/);
  });

  it('speak the reader’s language, not MapLibre’s English', () => {
    for (const file of ['components/map/map-canvas.tsx', 'components/map/mini-map.tsx']) {
      expect(read(file), file).toMatch(/locale: maplibreLocale/);
    }
  });
});

/**
 * Boss, 2026-10-09: on a phone the home map showed an empty beige band of about
 * 100px between Bulgaria and the list sheet. The basemap is a Bulgaria-only
 * extract with no tiles south of about 41°N, and the opening view centred the
 * country in a frame much taller than it, so the room below fell off the tiles.
 */
describe('phone south limit', () => {
  const [[, south], [, north]] = BULGARIA_BOUNDS;
  /** Latitude `offset` CSS px below (+) or above (−) a camera centre at `lat`. */
  const latAt = (lat: number, zoom: number, offset: number) =>
    latitudeAt(mercatorY(lat) + offset / (512 * 2 ** zoom));
  /** Edges of the tile row holding `lat` at tile zoom `z`: the archive keeps whole tiles. */
  const rowTop = (lat: number, z: number) =>
    latitudeAt(Math.floor(mercatorY(lat) * 2 ** z) / 2 ** z);
  const rowBottom = (lat: number, z: number) =>
    latitudeAt((Math.floor(mercatorY(lat) * 2 ** z) + 1) / 2 ** z);
  /** Half the visible map above the default half sheet and the 56px tab bar (map-explorer SNAP_PX). */
  const halfAboveSheet = (height: number) => (height - (0.4 * height + 56)) / 2;
  /** Where `cameraForBounds` puts the centre: the box's mercator middle. */
  const fitted = { lng: 25.5, lat: latitudeAt((mercatorY(south) + mercatorY(north)) / 2) };
  const PHONES = [
    [360, 780],
    [390, 844],
    [430, 932],
  ] as const;

  it('the regression, as arithmetic: centred, the frame ran ~100px off the tiles', () => {
    const zoom = widthFitZoom(390, BULGARIA_BOUNDS);
    const half = halfAboveSheet(844);
    const old = clampCenter(fitted, BULGARIA_BOUNDS);
    const tileEdge = rowBottom(south, Math.floor(zoom));
    const bandPx = (mercatorY(latAt(old.lat, zoom, half)) - mercatorY(tileEdge)) * 512 * 2 ** zoom;
    expect(bandPx).toBeGreaterThan(90);
    expect(bandPx).toBeLessThan(115);
  });

  it('opens with the bottom of the visible map on the southern edge, on every phone', () => {
    for (const [width, height] of [...PHONES, [768, 1024] as const]) {
      const zoom = widthFitZoom(width, BULGARIA_BOUNDS);
      const halfHeight = halfAboveSheet(height);
      const centre = clampCenter(fitted, BULGARIA_BOUNDS, { zoom, halfHeight });
      expect(latAt(centre.lat, zoom, halfHeight)).toBeCloseTo(south, 9);
      expect(centre.lng).toBe(fitted.lng);
    }
  });

  it('sends the spare room north, where the archive still has tiles', () => {
    for (const [width, height] of PHONES) {
      const fit = widthFitZoom(width, BULGARIA_BOUNDS);
      // The opening zoom and the zoom-out floor (`widthFit - 0.1`, map-canvas).
      for (const zoom of [fit, fit - 0.1]) {
        const halfHeight = halfAboveSheet(height);
        const centre = clampCenter(fitted, BULGARIA_BOUNDS, { zoom, halfHeight });
        expect(latAt(centre.lat, zoom, -halfHeight)).toBeLessThan(rowTop(north, Math.floor(zoom)));
      }
    }
  });

  it('a flick south at the opening zoom cannot reopen the band', () => {
    const zoom = widthFitZoom(390, BULGARIA_BOUNDS);
    const halfHeight = halfAboveSheet(844);
    // Where the old clamp let the centre go, and a flick far past it.
    for (const lat of [south, 14.26]) {
      const centre = clampCenter({ lng: 25.5, lat }, BULGARIA_BOUNDS, { zoom, halfHeight });
      expect(latAt(centre.lat, zoom, halfHeight)).toBeCloseTo(south, 9);
    }
  });

  it('zoomed in, it only trims the last half-frame above the edge', () => {
    const frame = { zoom: 14, halfHeight: 225 };
    const kulata = { lng: 23.37, lat: 41.39 };
    expect(clampCenter(kulata, BULGARIA_BOUNDS, frame)).toEqual(kulata);
    const atEdge = clampCenter({ lng: 23.37, lat: south }, BULGARIA_BOUNDS, frame);
    expect(atEdge.lat - south).toBeLessThan(0.01);
    expect(latAt(atEdge.lat, 14, 225)).toBeCloseTo(south, 9);
  });

  it('wins over the box’s northern edge when the sheet is collapsed', () => {
    // 390x844 with the sheet at `peek`: 168px plus the tab bar.
    const zoom = widthFitZoom(390, BULGARIA_BOUNDS);
    const halfHeight = (844 - 168 - 56) / 2;
    expect(southLimitLat(south, { zoom, halfHeight })).toBeGreaterThan(north);
    const centre = clampCenter(fitted, BULGARIA_BOUNDS, { zoom, halfHeight });
    expect(latAt(centre.lat, zoom, halfHeight)).toBeCloseTo(south, 9);
  });

  it('is wired into the phone constraint, and re-applied when only the padding changes', () => {
    const canvas = read('components/map/map-canvas.tsx');
    expect(canvas).toMatch(/clampCenter\(lngLat, BULGARIA_BOUNDS, \{\s*zoom: clampedZoom,/);
    // MapLibre does not re-run the constraint on setPadding (a sheet snap).
    expect(canvas).toMatch(/const held = centreInBulgaria\(now, map\.getZoom\(\)\)\.center;/);
  });
});

describe('insideVisibleFrame', () => {
  const size = { width: 390, height: 788 };
  // The phone's half preview sheet plus the tab bar.
  const padding = { bottom: 0.4 * 844 + 56 };

  it('treats a pin under the sheet as hidden', () => {
    expect(insideVisibleFrame({ x: 200, y: 700 }, size, padding, 48)).toBe(false);
  });

  it('treats a pin above the sheet as visible', () => {
    expect(insideVisibleFrame({ x: 200, y: 200 }, size, padding, 48)).toBe(true);
  });

  it('counts a pin hugging an edge as hidden, since its body is off screen', () => {
    expect(insideVisibleFrame({ x: 10, y: 200 }, size, padding, 48)).toBe(false);
  });
});

/** Just enough of an element for the marker builders. */
class FakeElement {
  className = '';
  textContent = '';
  innerHTML = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  private readonly attrs = new Map<string, string>();
  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
}

describe('cluster markers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('are focusable buttons named by their count, not hidden decoration', () => {
    vi.stubGlobal('document', { createElement: () => new FakeElement() });
    const el = createCluster(23, '23 съоръжения — приближи') as unknown as FakeElement;
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(el.getAttribute('aria-label')).toBe('23 съоръжения — приближи');
    expect(el.hasAttribute('aria-hidden')).toBe(false);
    expect(el.textContent).toBe('23');
  });

  it('share the pins’ tab order, so both can be reached from the keyboard', () => {
    vi.stubGlobal('document', { createElement: () => new FakeElement() });
    const pin = createPin({ slug: 'x', name: 'Футбол — София' }) as unknown as FakeElement;
    expect(pin.getAttribute('tabindex')).toBe('0');
    expect(pin.getAttribute('aria-label')).toBe('Футбол — София');
  });

  it('expand on Enter and Space exactly as they do on click', () => {
    const canvas = read('components/map/map-canvas.tsx');
    const start = canvas.indexOf('if (isCluster) {');
    const cluster = canvas.slice(start, canvas.indexOf('} else {', start));
    expect(cluster.length).toBeGreaterThan(0);
    expect(cluster).toMatch(/addEventListener\('click'/);
    expect(cluster).toMatch(/addEventListener\('keydown'/);
    expect(cluster).toMatch(/e\.key === 'Enter' \|\| e\.key === ' '/);
  });
});

describe('phone pin preview', () => {
  const explorer = read('components/map/map-explorer.tsx');

  it('opens as a half sheet, not a full-height cover over the pin it describes', () => {
    const start = explorer.indexOf('{selected ? (');
    const sheet = explorer.slice(start, explorer.indexOf('role="dialog"', start));
    expect(sheet.length).toBeGreaterThan(0);
    // The old sheet hard-coded the full height; the open state is now chosen.
    expect(sheet).not.toMatch(/h-\[calc\(100dvh-3\.5rem\)\]/);
    expect(sheet).toMatch(/PREVIEW_H\[previewFull \? 'full' : 'half'\]/);
    expect(explorer).toMatch(/const \[previewFull, setPreviewFull\] = useState\(false\)/);
  });

  it('frames the map above whichever sheet is actually on screen', () => {
    // The camera padding follows the preview while a facility is selected, so
    // the selected pin is revealed above the sheet rather than under it.
    expect(explorer).toMatch(/selectedSlug\s*\?\s*PREVIEW_PX\[previewFull \? 'full' : 'half'\]/);
  });

  it('expands to full height only on request, from a labelled control', () => {
    expect(explorer).toMatch(/aria-expanded=\{previewFull\}/);
    expect(explorer).toMatch(/t\('collapsePreview'\) : t\('expandPreview'\)/);
  });
});

describe('a device without WebGL', () => {
  it('is told the map is unavailable instead of shown an empty rectangle', () => {
    const canvas = read('components/map/map-canvas.tsx');
    const catchStart = canvas.indexOf("console.error('MapLibre init failed");
    const branch = canvas.slice(catchStart, canvas.indexOf('return;', catchStart));
    expect(branch).toMatch(/setUnavailable\(true\)/);
    expect(canvas).toMatch(/\{unavailable && \(/);
    expect(canvas).toMatch(/role="status"/);
    // Both canvases pass the copy in.
    for (const caller of ['components/map/map-explorer.tsx', 'components/map/place-map.tsx']) {
      expect(read(caller)).toMatch(/unavailableLabel=\{t\('mapUnavailable'\)\}/);
    }
  });
});
