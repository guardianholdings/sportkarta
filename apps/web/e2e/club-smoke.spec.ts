import { expect, test } from '@playwright/test';

import bg from '../messages/bg.json';

/**
 * The club module's HTTP envelope with the add-on ON (CLUBS_ENABLED=true in
 * playwright.config.ts) and no club in the database: what a stranger, a
 * crawler, an API client or a flyer's short link gets. STATUS over HTTP
 * (`request`, like not-found.spec.ts): the service worker handles page
 * navigations, so page.goto() does not reliably report the network status.
 */

const SLUG = 'nyama-takav-klub-e2e';

test('the club directory renders in Bulgarian', async ({ page }) => {
  await page.goto('/klubove');
  await expect(page.locator('html')).toHaveAttribute('lang', 'bg');
  await expect(page).toHaveTitle(new RegExp(bg.ClubPublic.directoryTitle));
});

test.describe('an unknown club is a real 404 on every public surface', () => {
  for (const path of [
    `/klub/${SLUG}`,
    `/klub/${SLUG}/zapitvane`,
    `/klub/${SLUG}/manifest.webmanifest`,
    `/api/widget/klub/${SLUG}/grafik`,
    `/en/klub/${SLUG}`,
  ]) {
    test(`${path} answers 404`, async ({ request }) => {
      expect((await request.get(path)).status()).toBe(404);
    });
  }
});

test.describe('signed-in surfaces send a stranger to sign in', () => {
  for (const path of [`/klub/${SLUG}/tablo`, `/klub/${SLUG}/az`, '/klub', '/klubove/zayavka']) {
    test(`${path} redirects to /vhod`, async ({ request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(307);
      expect(response.headers()['location']).toMatch(/\/vhod\?next=/);
    });
  }
});

test('the short link is a permanent redirect to the club page', async ({ request }) => {
  const response = await request.get(`/k/${SLUG}`, { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers()['location']).toMatch(new RegExp(`/klub/${SLUG}$`));
});

test('the club API is Bearer-only and never CORS-open', async ({ request }) => {
  const response = await request.get('/api/clubs/v1/club', {
    maxRedirects: 0,
    headers: { Origin: 'https://evil.example' },
  });
  expect(response.status()).toBe(401);
  expect(response.headers()['www-authenticate']).toMatch(/^Bearer/);
  expect(response.headers()['access-control-allow-origin']).toBeUndefined();
  expect(response.headers()['cache-control']).toContain('no-store');
});

test('the Stripe webhook is closed while no keys are configured', async ({ request }) => {
  const response = await request.post('/api/clubs/stripe/webhook', {
    data: '{}',
    headers: { 'content-type': 'application/json' },
  });
  expect(response.status()).toBe(404);
});
