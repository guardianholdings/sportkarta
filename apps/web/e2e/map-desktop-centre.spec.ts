import { expect, test, type Page } from '@playwright/test';

import bg from '../messages/bg.json';

/**
 * Desktop map, opening view (operator request 2026-11-02): the auto-fit puts
 * the whole country in the middle of the visible map, list open and closed.
 * From 10 Oct to 2 Nov a map area narrower than the box's shape (the list open
 * on a laptop) showed the country at the bottom, under an empty band.
 *
 * On desktop the list sits beside the map, not over it, so the visible map is
 * the canvas. The box's middle, 25.5° E 42.75° N, is projected through the
 * map itself, so the check is in screen pixels; the whole box must be inside
 * the visible map as well.
 */

const BOX = { west: 22, south: 41, east: 29, north: 44.5 };
const TOLERANCE_PX = 4;
const LIST_TOGGLE = 'button[aria-controls="facility-list-desktop"]';

interface MapForTests {
  project(lngLat: [number, number]): { x: number; y: number };
  getCanvas(): HTMLCanvasElement;
  getContainer(): HTMLElement;
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  isMoving(): boolean;
}

interface View {
  lng: number;
  lat: number;
  zoom: number;
}

/** The map, or a skip where the browser has no WebGL (the page then says the map is unavailable). */
async function mapOrSkip(page: Page) {
  const noMap = page.getByRole('status').filter({ hasText: bg.Map.mapUnavailable });
  const seen = { state: 'loading' };
  await expect
    .poll(
      async () => {
        if (await noMap.isVisible()) seen.state = 'no WebGL';
        else if (await page.evaluate(() => '__mapForTests' in window)) seen.state = 'map';
        return seen.state;
      },
      { timeout: 20_000 },
    )
    .not.toBe('loading');
  test.skip(seen.state === 'no WebGL', 'No WebGL in this browser: the page shows the notice.');
}

/**
 * Null until the map has resized to its container and stopped moving. A list
 * toggle moves the canvas's left edge at once, but MapLibre resizes a frame
 * later, and only then re-fits (or keeps) the camera.
 */
async function boxOffset(page: Page) {
  return page.evaluate(({ west, south, east, north }) => {
    const map = (window as unknown as { __mapForTests?: MapForTests }).__mapForTests;
    if (!map || map.isMoving()) return null;
    const canvas = map.getCanvas();
    if (canvas.clientWidth !== map.getContainer().clientWidth) return null;
    const middle = map.project([(west + east) / 2, (south + north) / 2]);
    const nw = map.project([west, north]);
    const se = map.project([east, south]);
    return {
      left: Math.round(canvas.getBoundingClientRect().left),
      dx: middle.x - canvas.clientWidth / 2,
      dy: middle.y - canvas.clientHeight / 2,
      inside: nw.x >= 0 && nw.y >= 0 && se.x <= canvas.clientWidth && se.y <= canvas.clientHeight,
    };
  }, BOX);
}

async function readView(page: Page) {
  return page.evaluate(() => {
    const map = (window as unknown as { __mapForTests?: MapForTests }).__mapForTests;
    if (!map || map.isMoving()) return null;
    const canvas = map.getCanvas();
    if (canvas.clientWidth !== map.getContainer().clientWidth) return null;
    const c = map.getCenter();
    return {
      left: Math.round(canvas.getBoundingClientRect().left),
      view: { lng: c.lng, lat: c.lat, zoom: map.getZoom() },
    };
  });
}

const sameView = (a: View, b: View) =>
  Math.abs(a.lng - b.lng) < 1e-6 &&
  Math.abs(a.lat - b.lat) < 1e-6 &&
  Math.abs(a.zoom - b.zoom) < 1e-6;

/** The camera once the map beside a list of `left` px has held still for two reads in a row. */
async function settledView(page: Page, left: number): Promise<View> {
  const seen: { last: View | null } = { last: null };
  await expect
    .poll(
      async () => {
        const read = await readView(page);
        const prev = seen.last;
        seen.last = read && read.left === left ? read.view : null;
        return prev && seen.last && sameView(prev, seen.last) ? 'still' : 'moving';
      },
      { timeout: 20_000, intervals: [250] },
    )
    .toBe('still');
  return seen.last as unknown as View;
}

/** Waits for the map beside a list of `left` px, then for the fit to centre the box's middle, box in view. */
async function expectCentred(page: Page, left: number) {
  await expect
    .poll(
      async () => {
        const o = await boxOffset(page);
        if (!o || o.left !== left) return 'not settled';
        const centred = Math.abs(o.dx) <= TOLERANCE_PX && Math.abs(o.dy) <= TOLERANCE_PX;
        if (!centred) return `off by ${o.dx.toFixed(1)}, ${o.dy.toFixed(1)} px`;
        return o.inside ? 'centred' : 'centred, but the box runs off the map';
      },
      { timeout: 20_000 },
    )
    .toBe('centred');
}

test.describe('desktop map — the country opens centred', () => {
  for (const size of [
    { width: 1280, height: 720 },
    { width: 1920, height: 937 },
  ]) {
    test(`${size.width}×${size.height}, list open and closed`, async ({ page }) => {
      await page.setViewportSize(size);
      await page.goto('/karta');
      await mapOrSkip(page);
      await expectCentred(page, 460);

      // No gesture yet, so closing the list re-fits the country into the wider map.
      await page.locator(`${LIST_TOGGLE}[aria-expanded="true"]`).click();
      await expectCentred(page, 76);

      await page.locator(`${LIST_TOGGLE}[aria-expanded="false"]`).click();
      await expectCentred(page, 460);
    });
  }

  // A wheel is the member's first gesture, as a drag already was: from then on
  // the list toggle keeps their centre and zoom (MapLibre's resize default),
  // and the view goes into the address. Until 2 Nov the next toggle re-fitted
  // the country over a wheel zoom.
  test('1280×720, after a wheel the list toggle keeps the member’s view', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/karta');
    await mapOrSkip(page);
    await expectCentred(page, 460);
    const fit = await settledView(page, 460);

    // Up and to the right of the middle of the visible map, on the map itself.
    const x = 460 + 820 * 0.7;
    const y = 720 * 0.35;
    const onMap = await page.evaluate(
      ({ px, py }) => !!document.elementFromPoint(px, py)?.closest('[data-testid="map-canvas"]'),
      { px: x, py: y },
    );
    expect(onMap, 'the wheel point is on the map').toBe(true);
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, -300);
    await expect
      .poll(async () => (await readView(page))?.view.zoom ?? fit.zoom, { timeout: 10_000 })
      .toBeGreaterThan(fit.zoom + 0.1);
    const zoomed = await settledView(page, 460);
    await expect(page).toHaveURL(/[?&]z=/);

    await page.locator(`${LIST_TOGGLE}[aria-expanded="true"]`).click();
    expect(sameView(await settledView(page, 76), zoomed), 'list closed: the view is kept').toBe(
      true,
    );

    await page.locator(`${LIST_TOGGLE}[aria-expanded="false"]`).click();
    expect(
      sameView(await settledView(page, 460), zoomed),
      'list open again: the view is kept',
    ).toBe(true);
  });
});
