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
  // facility bottom sheet (`#facility-list`, testId `facility-sheet`) only below
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
    // are now select-buttons (data-slug), not nav links, and both the desktop
    // and mobile layouts carry an #facility-list — scope to the visible one.
    const firstItem = page.locator('#facility-list:visible button[data-slug]').first();
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
