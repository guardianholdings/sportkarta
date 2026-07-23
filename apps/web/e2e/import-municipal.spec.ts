import { expect, test } from '@playwright/test';

/**
 * Stage 6.3 — the admin gate on the municipal CSV inbox, which only a real
 * request can prove.
 *
 * The dedupe and merge behaviour is covered against a real database in
 * db/src/import-municipal.test.ts. What that cannot see is that the screen
 * itself is unreachable signed out. A registry import rewrites the canonical
 * facility dataset, so requireRole('admin') is the only thing between a
 * signed-out request and the ability to overwrite the map.
 */

test.describe('municipal CSV inbox', () => {
  test('the import screen is not reachable signed out', async ({ page }) => {
    await page.goto('/admin/obshtini');
    await expect(page).toHaveURL(/\/vhod/);
  });

  test('a signed-out visitor gets the sign-in form, not the import form', async ({ page }) => {
    await page.goto('/admin/obshtini');
    await expect(page).toHaveURL(/\/vhod/);
    // The import form's own controls must not be on the page — the "data
    // source" field and the file input render only for an admin. (The page
    // TITLE string is in next-intl's client message bundle, which ships on
    // every page, so it is not a signal; the interactive controls are.)
    await expect(page.getByLabel(/Източник|Data source/)).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  });
});
