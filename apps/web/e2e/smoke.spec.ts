import { expect, test } from '@playwright/test';

import bg from '../messages/bg.json';

// The default locale (bg) is served unprefixed at "/" — Bulgarian-first.
test('home page renders in Bulgarian', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(bg.Metadata.title);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(bg.HomePage.title);
  await expect(page.getByRole('button', { name: bg.HomePage.cta })).toBeVisible();
});
