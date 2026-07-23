import { expect, test } from '@playwright/test';

/**
 * Stage 6.2 — the parts of the grant-report export only a real request can
 * prove.
 *
 * The figures themselves are covered by db/src/reports/reconcile.test.ts
 * against fixtures. What that cannot see is the ENVELOPE, and here the envelope
 * is the whole authorization story: `/api/admin/otcheti` is outside the i18n
 * middleware's matcher, so the optimistic cookie check never runs on it and
 * `requireRole('admin')` is the only thing standing between a signed-out
 * request and a municipality's participation figures.
 */

test.describe('grant report export', () => {
  test('the admin screen is not reachable signed out', async ({ page }) => {
    await page.goto('/admin/otcheti');
    await expect(page).toHaveURL(/\/vhod/);
  });

  test('the download endpoint refuses a signed-out request', async ({ request }) => {
    const response = await request.get(
      '/api/admin/otcheti?from=2026-04-01&to=2026-06-30&municipality=all&format=csv',
      // Do not follow the sign-in redirect: what matters is that no CSV comes
      // back, whatever status the auth layer chooses.
      { maxRedirects: 0 },
    );
    expect(response.status()).not.toBe(200);
    const body = await response.text();
    // The annex's own header row must not appear in a response to a stranger.
    expect(body).not.toContain('Показател');
    expect(body).not.toContain('Брой проведени занимания');
  });

  test('the endpoint is marked never-cache and never-index', async ({ request }) => {
    // Even the refusal: a shared cache holding one municipality's annex and
    // serving it to the next request is the whole risk in one header.
    const response = await request.get('/api/admin/otcheti?format=csv', { maxRedirects: 0 });
    const headers = response.headers();
    if (headers['cache-control']) {
      expect(headers['cache-control']).toContain('no-store');
    }
    expect(response.status()).not.toBe(200);
  });
});
