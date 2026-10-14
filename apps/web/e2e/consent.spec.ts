import { expect, test, type Page } from '@playwright/test';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The analytics consent card: public/consent.js, on every page through
 * app/[locale]/layout.tsx. Cloudflare Zaraz, and Google Analytics with it,
 * loads only after a yes: no /cdn-cgi/zaraz/ request before „Да“, exactly one
 * loader after it, none after „Не“.
 *
 * No Cloudflare sits in front of the app here, so a stub with the shape of
 * Zaraz's consent API stands in for it: served as the loader when the card
 * injects one, or put on the page first, the way Cloudflare's own injection
 * would. The stub records every call in window.zarazCalls.
 */

const ZARAZ = /\/cdn-cgi\/zaraz\//;
const LOADER = '/cdn-cgi/zaraz/i.js';

const STUB = `(() => {
  const calls = (window.zarazCalls = []);
  window.zaraz = {
    consent: {
      APIReady: true,
      set: (purposes) => calls.push(['set', purposes]),
      sendQueuedEvents: () => calls.push(['sendQueuedEvents']),
    },
  };
  document.dispatchEvent(new Event('zarazConsentAPIReady'));
})();`;

// The card's own strings live in public/consent.js, not in the catalogues.
const CARD = {
  bg: {
    label: 'Съгласие за статистика',
    yes: 'Да, разбира се',
    no: 'Не, благодаря',
    more: 'Поверителност',
  },
  en: { label: 'Analytics consent', yes: 'Yes, sure', no: 'No, thanks', more: 'Privacy' },
} as const;

const GRANTED = [['set', { analytics: true }], ['sendQueuedEvents']];
const REFUSED = [['set', { analytics: false }]];

function card(page: Page, lang: keyof typeof CARD = 'bg') {
  return page.getByRole('region', { name: CARD[lang].label });
}

/** The path of every /cdn-cgi/zaraz/ request the page makes from now on. */
function zarazRequests(page: Page): string[] {
  const paths: string[] = [];
  page.on('request', (request) => {
    if (ZARAZ.test(request.url())) paths.push(new URL(request.url()).pathname);
  });
  return paths;
}

/** What the stub recorded, or null when no stub ran on the page. */
function zarazCalls(page: Page) {
  return page.evaluate(() => (window as unknown as { zarazCalls?: unknown[] }).zarazCalls ?? null);
}

/** Answers the card that opens by itself after its delay. */
async function answer(page: Page, choice: 'yes' | 'no') {
  const button = card(page).getByRole('button', { name: CARD.bg[choice] });
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();
  await expect(card(page)).toHaveCount(0);
}

/** Outwaits the card's 2.5 s delay, so "no card" means it chose not to open. */
async function pastTheDelay(page: Page) {
  await page.waitForTimeout(3_500);
}

/**
 * A pan ends in onMoveEnd, which rewrites the address to ?z=…&lat=…&lng=…
 * with history.replaceState (map-explorer.tsx). Where the browser has no
 * WebGL the map does not start (map-canvas.tsx); the test then makes that same
 * rewrite itself, and says so in the report.
 */
async function panTheMap(page: Page) {
  const canvas = page.getByTestId('map-canvas').locator('canvas');
  const noMap = page.getByRole('status').filter({ hasText: bg.Map.mapUnavailable });
  await expect(canvas.or(noMap)).toBeVisible({ timeout: 15_000 });
  if (await canvas.isVisible()) {
    const box = await canvas.boundingBox();
    if (!box) throw new Error('the map canvas has no box');
    const x = box.x + box.width * 0.75;
    const y = box.y + box.height * 0.3;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 120, y + 60, { steps: 8 });
    await page.mouse.up();
    await expect(page).toHaveURL(/[?&]lat=/);
    test.info().annotations.push({ type: 'pan', description: 'dragged the map' });
  } else {
    await page.evaluate(() =>
      window.history.replaceState(null, '', '/?z=9.00&lat=42.69770&lng=23.32190'),
    );
    test.info().annotations.push({
      type: 'pan',
      description: 'no WebGL here: made the address rewrite a pan makes',
    });
  }
}

test.describe('the consent card, with Zaraz not on the page', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(ZARAZ, (route) =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: STUB }),
    );
  });

  test('„Да“ loads Zaraz once, and a stored yes loads it on the next page', async ({ page }) => {
    const requests = zarazRequests(page);
    await page.goto('/privacy');
    const yes = card(page).getByRole('button', { name: CARD.bg.yes });
    await expect(yes).toBeVisible({ timeout: 10_000 });
    expect(requests).toEqual([]);

    await yes.click();
    await expect(card(page)).toHaveCount(0);
    await expect.poll(() => zarazCalls(page)).toEqual(GRANTED);
    expect(requests).toEqual([LOADER]);

    await page.reload();
    await expect.poll(() => zarazCalls(page)).toEqual(GRANTED);
    await pastTheDelay(page);
    await expect(card(page)).toHaveCount(0);
    expect(requests).toEqual([LOADER, LOADER]);
  });

  test('„Не“ loads nothing, then or on the next page', async ({ page }) => {
    const requests = zarazRequests(page);
    await page.goto('/privacy');
    await answer(page, 'no');

    await page.reload();
    await pastTheDelay(page);
    await expect(card(page)).toHaveCount(0);
    expect(requests).toEqual([]);
    expect(await zarazCalls(page)).toBeNull();
  });
});

test.describe('the consent card, with Zaraz already on the page', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(STUB);
  });

  test('„Да“ grants consent with no second loader, then and from the stored yes', async ({
    page,
  }) => {
    const requests = zarazRequests(page);
    await page.goto('/privacy');
    await answer(page, 'yes');
    await expect.poll(() => zarazCalls(page)).toEqual(GRANTED);

    await page.reload();
    await expect.poll(() => zarazCalls(page)).toEqual(GRANTED);
    expect(requests).toEqual([]);
  });

  test('„Не“ withdraws consent and loads nothing', async ({ page }) => {
    const requests = zarazRequests(page);
    await page.goto('/privacy');
    await answer(page, 'no');
    await expect.poll(() => zarazCalls(page)).toEqual(REFUSED);
    expect(requests).toEqual([]);
  });
});

test('the card speaks the page’s language and links that language’s privacy notice', async ({
  page,
}) => {
  await page.goto('/privacy');
  await expect(card(page).getByRole('link', { name: CARD.bg.more })).toHaveAttribute(
    'href',
    '/privacy',
    { timeout: 10_000 },
  );
  await page.goto('/en/privacy');
  await expect(card(page, 'en').getByRole('link', { name: CARD.en.more })).toHaveAttribute(
    'href',
    '/en/privacy',
    { timeout: 10_000 },
  );
});

test('the footer’s cookie-settings link reopens the card', async ({ page }) => {
  await page.goto('/privacy');
  await answer(page, 'no');

  const link = page
    .getByRole('contentinfo')
    .getByRole('link', { name: bg.Footer.cookieSettings, exact: true });
  await expect(link).toHaveAttribute('href', '#cookie-settings');
  await link.click();
  await expect(card(page).getByRole('button', { name: CARD.bg.no })).toBeVisible();
  // The card opens in place; #cookie-settings never lands in the address.
  expect(new URL(page.url()).hash).toBe('');
});

test('the map’s cookie-settings link reopens the card twice in a row, and after a pan', async ({
  page,
}) => {
  const requests = zarazRequests(page);
  await page.goto('/');
  await answer(page, 'no');

  // The full-screen map hides the footer; its results panel ends with the same
  // links. Both layouts are in the DOM, so this scopes to the visible one.
  const link = page
    .locator('[id^="facility-list"]:visible')
    .getByRole('link', { name: bg.Footer.cookieSettings, exact: true });
  const no = card(page).getByRole('button', { name: CARD.bg.no });
  for (let click = 1; click <= 2; click++) {
    await link.click();
    await expect(no).toBeVisible();
    await no.click();
    await expect(card(page)).toHaveCount(0);
  }

  await panTheMap(page);
  await link.click();
  await expect(no).toBeVisible();
  expect(requests).toEqual([]);
});

test('/consent.js is served as JavaScript, and every page loads it but the widget', async ({
  request,
}) => {
  const script = await request.get('/consent.js');
  expect(script.status()).toBe(200);
  expect(script.headers()['content-type']).toMatch(/javascript/);

  for (const path of ['/', '/en', '/privacy', '/en/privacy']) {
    const html = await (await request.get(path)).text();
    expect(html, path).toMatch(/<script[^>]*\ssrc="\/consent\.js"/);
  }
  // The embeddable widget renders outside the site's layout: no script at all
  // (accountability.spec.ts pins its headers), so no card for a municipality's
  // visitors either.
  const widget = await (await request.get('/api/widget/obshtina/sofia?lang=bg')).text();
  expect(widget).not.toContain('consent.js');
});

test('the site’s CSP is unchanged: frame-ancestors only', async ({ request }) => {
  for (const path of ['/', '/en', '/privacy']) {
    const response = await request.get(path);
    expect(response.headers()['content-security-policy'], path).toBe("frame-ancestors 'none'");
  }
});

test('/privacy names Google Analytics, with consent, in bg and en', async ({ page }) => {
  await page.goto('/privacy');
  await expect(
    page.getByText(bg.Privacy.processing.googleAnalytics.title, { exact: true }),
  ).toBeVisible();
  await page.goto('/en/privacy');
  await expect(
    page.getByText(en.Privacy.processing.googleAnalytics.title, { exact: true }),
  ).toBeVisible();
});
