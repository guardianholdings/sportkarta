import { expect, test } from '@playwright/test';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * Pre-launch audit: the parts of "what a stranger sees" that only a real HTTP
 * response can prove.
 *
 * STATUS over HTTP, rendering in the browser. The PWA service worker handles
 * navigations, so page.goto() does not reliably report the network status;
 * `request` does. The page's own not-found tree is serialized into EVERY
 * response as a boundary fallback, so a body-text check alone proves nothing —
 * the status line is the assertion that a removed facility is not a live page.
 */

// Every kind of URL that resolves an entity, plus plain unmatched paths.
const MISSING = [
  '/obekt/nyama-takav-obekt-e2e',
  '/sesiya/00000000-0000-4000-8000-000000000000',
  '/sesiya/not-a-uuid',
  '/kampanii/nyama-takava-kampaniya-e2e',
  '/kampanii/nyama-takava-kampaniya-e2e/rezultati',
  '/pasport/nyama-takav-profil-e2e',
  '/igrishta/nyama-takav-grad',
  '/igrishta/sofia/nyama-takav-sport',
  '/obshtina/nyama-takava-obshtina',
  '/sedmitsata/nyama-takav-grad',
  '/nyama-takava-stranitsa',
  '/en/no-such-page',
  '/en/obekt/nyama-takav-obekt-e2e',
];

test.describe('missing pages are real 404s', () => {
  for (const path of MISSING) {
    test(`${path} answers 404`, async ({ request }) => {
      expect((await request.get(path)).status()).toBe(404);
    });
  }

  test('a missing facility renders the localized page inside the app', async ({ page }) => {
    await page.goto('/obekt/nyama-takav-obekt-e2e');
    await expect(page.locator('html')).toHaveAttribute('lang', 'bg');
    await expect(page.getByRole('heading', { level: 1, name: bg.NotFound.title })).toBeVisible();
    await page.getByRole('link', { name: bg.NotFound.toMap }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('an unmatched English path renders in English', async ({ page }) => {
    await page.goto('/en/no-such-page');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('heading', { level: 1, name: en.NotFound.title })).toBeVisible();
  });
});

test('the language switch keeps the page and changes the locale', async ({ page }) => {
  await page.goto('/statistika');
  await page
    .getByRole('contentinfo')
    .getByRole('link', { name: bg.LocaleSwitcher.switchTo })
    .click();
  await expect(page).toHaveURL(/\/en\/statistika$/);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  await page
    .getByRole('contentinfo')
    .getByRole('link', { name: en.LocaleSwitcher.switchTo })
    .click();
  await expect(page).toHaveURL(/\/statistika$/);
  await expect(page).not.toHaveURL(/\/en\//);
  await expect(page.locator('html')).toHaveAttribute('lang', 'bg');
});

test('pages without a card of their own still share with one', async ({ request }) => {
  for (const [path, card] of [
    ['/', '/og/bg/site/card.png'],
    ['/statistika', '/og/bg/site/card.png'],
    ['/en/sesii', '/og/en/site/card.png'],
  ] as const) {
    const html = await (await request.get(path)).text();
    expect(html, path).toMatch(new RegExp(`<meta property="og:image" content="[^"]*${card}"`));
    expect(html, path).toContain('<meta name="twitter:card" content="summary_large_image"');
  }
  const card = await request.get('/og/bg/site/card.png');
  expect(card.status()).toBe(200);
  expect(card.headers()['content-type']).toContain('image/png');
});

test('the static sitemap lists the transparency pages', async ({ request }) => {
  const xml = await (await request.get('/sitemaps/static.xml')).text();
  for (const path of ['/statistika', '/danni', '/sesii']) {
    expect(xml, path).toContain(`${path}</loc>`);
  }
  expect(xml).not.toContain('/design-system');
});

test('/danni does not scroll sideways on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/danni');
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
