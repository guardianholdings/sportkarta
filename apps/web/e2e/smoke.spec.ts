import { expect, test } from '@playwright/test';

import bg from '../messages/bg.json';

// The default locale (bg) is served unprefixed at "/" — Bulgarian-first.
// "/" is the front page; the public map lives at "/karta" (an accessible
// sr-only h1 + the geolocate control).
test('front page renders in Bulgarian', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveTitle(bg.Metadata.title);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(bg.Home.hero.title);
  // Both ways in work without JavaScript: a link and a GET form to the map.
  // `exact`: the «Как работи» card also mentions «Близо до мен» in its text.
  await expect(page.getByRole('link', { name: bg.Home.hero.nearMe, exact: true })).toHaveAttribute(
    'href',
    '/karta?blizo=1',
  );
  await expect(page.getByRole('search')).toHaveAttribute('action', '/karta');
});

test('the map renders in Bulgarian at /karta', async ({ page }) => {
  await page.goto('/karta');

  await expect(page).toHaveTitle(bg.Metadata.titleTemplate.replace('%s', bg.Map.title));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(bg.Map.title);
  await expect(page.getByRole('button', { name: bg.Map.locate })).toBeVisible();
});

test('a map link from before /karta still opens the map', async ({ page }) => {
  await page.goto('/?sport=football');

  await expect(page).toHaveURL(/\/karta\?sport=football$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(bg.Map.title);
});

test('an old map link is a permanent redirect, not a page', async ({ request }) => {
  // 308 from middleware, not a 200 with a meta refresh: link unfurlers and
  // crawlers read the status, and a refresh inside a stream is invisible to them.
  const bgResponse = await request.get('/?sport=football&z=10', { maxRedirects: 0 });
  expect(bgResponse.status()).toBe(308);
  expect(bgResponse.headers()['location']).toMatch(/\/karta\?sport=football&z=10$/);

  const enResponse = await request.get('/en?selected=park', { maxRedirects: 0 });
  expect(enResponse.status()).toBe(308);
  expect(enResponse.headers()['location']).toMatch(/\/en\/karta\?selected=park$/);

  // A parameter the map never read is still the front page.
  const home = await request.get('/?utm_source=newsletter', { maxRedirects: 0 });
  expect(home.status()).toBe(200);
});
