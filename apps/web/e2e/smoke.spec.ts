import { expect, test } from '@playwright/test';

import bg from '../messages/bg.json';

// The default locale (bg) is served unprefixed at "/" — Bulgarian-first.
// "/" is the public map: an accessible (sr-only) h1 + the geolocate control.
test('home page (map) renders in Bulgarian', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(bg.Metadata.title);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(bg.Map.title);
  await expect(page.getByRole('button', { name: bg.Map.locate })).toBeVisible();
});
