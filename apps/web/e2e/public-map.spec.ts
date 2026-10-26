import { expect, test } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';

import bg from '../messages/bg.json';

// Repo-root .env: DATABASE_URL (Playwright runs with cwd = apps/web).
config({ path: '../../.env' });

// A free football pitch at a fixed rural coordinate. The test geolocates to
// exactly this point, so it is the nearest match by a wide margin regardless
// of the ~6.6k real facilities in the dev DB. Seeded `active` (not
// `needs_verification`) so it never lands in the admin verify queue that the
// admin e2e asserts against.
const PITCH = {
  id: '00000000-0000-4000-8000-0000000fb001',
  slug: 'e2e-nearest-football-pitch',
  name: 'E2E Nearest Football Pitch',
  lon: 27.41234,
  lat: 43.39876,
};

async function seedPitch(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the public-map e2e suite');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `
      INSERT INTO facilities (id, geom, name, slug, sport_types, access, status, source)
      VALUES ($1::uuid, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5,
              '{football}', 'free', 'active', 'crowd')
      ON CONFLICT (id) DO UPDATE SET
        geom = EXCLUDED.geom, name = EXCLUDED.name, slug = EXCLUDED.slug,
        sport_types = EXCLUDED.sport_types, access = 'free', status = 'active'
      `,
      [PITCH.id, PITCH.lon, PITCH.lat, PITCH.name, PITCH.slug],
    );
  } finally {
    await client.end();
  }
}

test.describe('public map — find nearest free football pitch', () => {
  // This journey is the MOBILE one: the redesign serves the results list and the
  // facility bottom sheet (`#facility-list-mobile`, testId `facility-sheet`) only below
  // the `lg` breakpoint; the desktop layout uses a side panel instead. Pin a
  // phone viewport so the bottom-sheet flow this test asserts actually renders.
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeAll(seedPitch);

  test('geolocate surfaces the nearest pitch → bottom sheet → facility page', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: PITCH.lat, longitude: PITCH.lon });

    // The map fetches the full filtered set; wait for it before geolocating so
    // the distance sort runs over every football facility, not just the SSR slice.
    const apiLoaded = page.waitForResponse(
      (r) => r.url().includes('/api/facilities') && r.url().includes('sport=football') && r.ok(),
    );
    await page.goto('/?sport=football');
    await apiLoaded;

    // Free access is ON by default (the URL only narrows by sport). The access
    // control now lives as a chip in the filter sheet rather than an inline
    // checkbox; the default is exercised by the flow itself — a *free* pitch is
    // the nearest result below, and its facility page states свободен (line ~80).
    await page.getByRole('button', { name: bg.Map.locate }).click();

    // Nearest-first: the pitch seeded at the geolocation tops the list. Results
    // are select-buttons (data-slug), not nav links. Both layouts are always in
    // the DOM with only one displayed, so this scopes to the VISIBLE panel. The
    // two used to share `id="facility-list"`, which also silently broke the skip
    // link on mobile; they are now `-desktop` and `-mobile`, matched by prefix so
    // this keeps working whichever breakpoint the run lands on.
    const firstItem = page.locator('[id^="facility-list"]:visible button[data-slug]').first();
    await expect(firstItem).toHaveAttribute('data-slug', PITCH.slug);

    // Tap → the facility preview opens in place as a bottom-sheet dialog, and
    // its "view details" link is what navigates to the facility page.
    await firstItem.click();
    const sheet = page.getByRole('dialog', { name: PITCH.name });
    await expect(sheet.getByRole('heading', { level: 2 })).toHaveText(PITCH.name);
    const detailsLink = sheet.getByRole('link', { name: bg.Map.viewDetails });
    await expect(detailsLink).toHaveAttribute('href', `/obekt/${PITCH.slug}`);
    await detailsLink.click();

    // App Router dev commits the URL only once the server responds, so a cold
    // first compile of /obekt/[slug] can be slow; give it room within the test budget.
    await page.waitForURL(new RegExp(`/obekt/${PITCH.slug}$`), { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(PITCH.name);
    // Free is stated on the facility page (access attribute).
    await expect(page.getByText(bg.Access.free, { exact: true })).toBeVisible();
  });
});

// The QR codes printed on facility stickers open the map with `?blizo=1` and
// campaign tags. The map locates the visitor on arrival, with no tap, through the
// same locate() as the button (lib/map/auto-locate.ts).
const STICKER_URL = '/?blizo=1&utm_source=sticker&utm_medium=offline&utm_content=s1';
const SOFIA = { latitude: 42.6977, longitude: 23.3219 };
const DISTANCE = new RegExp(bg.Map.distanceKm.replace('{km}', '([\\d,]+)'));

test.describe('public map — a sticker link locates on arrival', () => {
  // The phone layout, as above: a sticker is scanned with a phone.
  test.use({ viewport: { width: 390, height: 844 } });
  test.beforeAll(seedPitch);

  test('the facility the visitor stands at heads the list, without a tap', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation({ latitude: PITCH.lat, longitude: PITCH.lon });

    const apiLoaded = page.waitForResponse((r) => r.url().includes('/api/facilities') && r.ok());
    await page.goto(STICKER_URL);
    await apiLoaded;

    // No click on the locate button anywhere in this test.
    const firstItem = page.locator('[id^="facility-list"]:visible button[data-slug]').first();
    await expect(firstItem).toHaveAttribute('data-slug', PITCH.slug);
    await expect(firstItem).toContainText(DISTANCE);
  });

  test('in Sofia the list reads nearest first', async ({ page, context }) => {
    await context.grantPermissions(['geolocation']);
    await context.setGeolocation(SOFIA);

    const apiLoaded = page.waitForResponse((r) => r.url().includes('/api/facilities') && r.ok());
    await page.goto(STICKER_URL);
    await apiLoaded;

    const list = page.locator('[id^="facility-list"]:visible');
    await expect(list.locator('button[data-slug]').first()).toContainText(DISTANCE);

    // The rows on the map come first, then, past a divider, the rest of the
    // country; each run is sorted nearest first (list-rows.ts). Read in one pass,
    // so the runs come from one render.
    const runs = await list.evaluate(
      (root, { distance, divider }) => {
        const re = new RegExp(distance);
        const out: number[][] = [[]];
        for (const li of Array.from(root.querySelectorAll('li'))) {
          const card = li.querySelector('button[data-slug]');
          if (!card) {
            if (li.textContent?.includes(divider)) out.push([]);
            continue;
          }
          const km = re.exec(card.textContent ?? '')?.[1];
          if (km) out[out.length - 1]?.push(Number(km.replace(',', '.')));
        }
        return out;
      },
      { distance: DISTANCE.source, divider: bg.Map.outsideMap },
    );

    expect(runs.flat().length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run).toEqual([...run].sort((a, b) => a - b));
    }
  });

  // After a locate the map's centre is where the visitor stands, so it stays out
  // of the address bar until they move the map by hand (map-canvas.tsx,
  // locatedRef). Reduced motion makes the map jump instead of fly: once the count
  // reads "N on the map · M in total", the camera has settled on the visitor.
  test.describe('the address bar never holds the located position', () => {
    test.use({ reducedMotion: 'reduce' });

    const PRECISE = /\d\.\d{3,}/;
    const ON_MAP = new RegExp(bg.Map.resultsOnMap.replace(/\{\w+, number\}/g, '[\\d\\s]+'));

    test('not on the printed address; a move by hand writes the view again', async ({
      page,
      context,
    }) => {
      await context.grantPermissions(['geolocation']);
      await context.setGeolocation(SOFIA);
      const query = () => new URL(page.url()).searchParams;

      await page.goto(STICKER_URL);
      await expect(page.locator('[role="status"]', { hasText: ON_MAP }).first()).toBeAttached({
        timeout: 15_000,
      });
      expect(page.url()).not.toMatch(PRECISE);
      expect(query().has('lat')).toBe(false);

      // An arrow key pans the map and carries its key event: a gesture.
      await page.locator('canvas.maplibregl-canvas').focus();
      await page.keyboard.press('ArrowUp');
      await expect
        .poll(() => query().get('lat') ?? '', { timeout: 10_000 })
        .toMatch(/^\d+\.\d{5}$/);
      expect(query().get('blizo')).toBe('1');
    });

    test('a saved view in the address is taken out once the map has located', async ({
      page,
      context,
    }) => {
      await context.grantPermissions(['geolocation']);
      await context.setGeolocation(SOFIA);
      const query = () => new URL(page.url()).searchParams;

      // A view far from the visitor (Varna), as an earlier pan writes it.
      await page.goto(`${STICKER_URL}&z=7.00&lat=43.20000&lng=27.90000`);
      await expect.poll(() => query().has('lat'), { timeout: 15_000 }).toBe(false);
      expect(query().has('lng')).toBe(false);
      expect(query().has('z')).toBe(false);
      expect(page.url()).not.toMatch(PRECISE);
      expect(query().get('blizo')).toBe('1');
      expect(query().get('utm_content')).toBe('s1');
    });
  });
});
