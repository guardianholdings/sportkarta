import { expect, test, type Page } from '@playwright/test';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The analytics consent card (public/consent.js, on every page through
 * app/[locale]/layout.tsx) and Google's own tag behind it.
 *
 * This runs the REAL gtag.js for G-XRJS0YRT3Q from googletagmanager.com: its
 * response carries the stream's live settings, so a stub would prove nothing.
 * Every hit it tries to send — to google-analytics.com/g/collect, or to any
 * other Google host — is recorded here and aborted, so no test data reaches
 * Google Analytics. Each test attaches what it recorded (event, address,
 * referrer, and the tab's own address when the hit left).
 */

const GA = 'G-XRJS0YRT3Q';
const GTAG_URL = `https://www.googletagmanager.com/gtag/js?id=${GA}`;
const GOOGLE =
  /^https?:\/\/([a-z0-9-]+\.)*(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|doubleclick\.net|google\.[a-z.]+)(:\d+)?\//;
const KEY = 'hcc_v1';
const GA_COOKIE = /^_ga(_|$)/;
/** Made-up tokens and a made-up passport: none of them may reach Google. */
const TOKEN = 'abc123';
const HEX = '0123456789abcdef0123456789abcdef';
const HANDLE = 'test-handle';
const SECRET = new RegExp(`${TOKEN}|${HEX}|${HANDLE}|otmetka|pokana|otpisvane|pasport`);
/** consent.js's own list of personal pages. */
const PERSONAL =
  /^(\/en)?\/(admin(\/|$)|otmetka\/|sedmitsata\/otpisvane\/|pasport(\/|$)|profil(\/|$)|trenirovki(\/|$)|klasirane(\/|$)|kampanii\/[^/]+|sesiya\/|igra\/|klub(\/|$)|klubove\/(otmetka|otpisvane|pokana)\/|s\/|dobre-doshli(\/|$)|dev\/)/;

function personalAt(at: string) {
  return PERSONAL.test(at.split('?')[0] ?? at);
}

interface Hit {
  step: string;
  /** The tab's own address when the request left. */
  at: string;
  en: string;
  dl: string;
  dr: string;
  dt: string;
}

interface Google {
  step: string;
  /** Every script fetched from googletagmanager.com/gtag/, by step. */
  loads: { step: string; url: string }[];
  hits: Hit[];
  /** Any other request to a Google host. */
  other: string[];
}

function pathOf(url: string) {
  const u = new URL(url);
  return u.pathname + u.search;
}

/** Every event in one collect request: the shared query, then each line of the body. */
function eventsOf(url: string, body: string | null) {
  const shared = Object.fromEntries(new URL(url).searchParams.entries());
  const lines = (body ?? '').split(/\r?\n/).filter(Boolean);
  return (lines.length ? lines : ['']).map((line) => {
    const event: Record<string, string> = {
      ...shared,
      ...Object.fromEntries(new URLSearchParams(line).entries()),
    };
    return { en: event.en ?? '', dl: event.dl ?? '', dr: event.dr ?? '', dt: event.dt ?? '' };
  });
}

/** The test's Google record, attached after it whether it passed or not. */
let watched: Google | null = null;

test.afterEach(async () => {
  if (!watched) return;
  const google = watched;
  watched = null;
  await test.info().attach('google.json', {
    body: JSON.stringify(google, null, 1),
    contentType: 'application/json',
  });
  test.info().annotations.push({
    type: 'google',
    description: [
      `scripts: ${google.loads.map((load) => `${load.step}: ${load.url}`).join('; ') || 'none'}`,
      `other: ${google.other.join('; ') || 'none'}`,
      ...google.hits.map(
        (hit) => `${hit.step} | at ${hit.at} | en=${hit.en} | dl=${hit.dl} | dr=${hit.dr}`,
      ),
    ].join('\n'),
  });
});

/** Lets Google's tag script through; records and aborts everything else Google. */
async function watchGoogle(page: Page): Promise<Google> {
  const google: Google = { step: 'start', loads: [], hits: [], other: [] };
  watched = google;
  await page.context().route(GOOGLE, async (route) => {
    const request = route.request();
    const url = request.url();
    if (request.method() === 'GET' && url.startsWith('https://www.googletagmanager.com/gtag/')) {
      google.loads.push({ step: google.step, url });
      return route.continue();
    }
    if (/\/g\/collect/.test(url)) {
      const at = pathOf(page.url());
      for (const event of eventsOf(url, request.postData())) {
        google.hits.push({ step: google.step, at, ...event });
      }
    } else {
      google.other.push(`${google.step}: ${request.method()} ${url.slice(0, 160)}`);
    }
    return route.abort();
  });
  return google;
}

/** The steps that fetched gtag.js itself. */
function tagLoads(google: Google) {
  return google.loads.filter((load) => load.url === GTAG_URL).map((load) => load.step);
}

/** Waits for a page_view of this path (any host, port or query) in or after the given hit index. */
async function pageView(google: Google, path: string, from = 0) {
  const pathname = (url: string) => {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  };
  const views = () =>
    google.hits.slice(from).filter((hit) => hit.en === 'page_view' && pathname(hit.dl) === path);
  await expect.poll(() => views().length, { timeout: 15_000 }).toBeGreaterThan(0);
  return views()[0] as Hit;
}

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

function card(page: Page, lang: keyof typeof CARD = 'bg') {
  return page.getByRole('region', { name: CARD[lang].label });
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

/** A stored yes, as a visitor who said „Да“ before has it (an answer given since stays). */
async function storedYes(page: Page) {
  await page.context().addInitScript((key) => {
    if (!window.localStorage.getItem(key)) window.localStorage.setItem(key, 'y');
  }, KEY);
}

/** A change of page the way the router makes one (history.pushState); consent.js may load the page afresh. */
async function pushTo(page: Page, path: string) {
  const fresh = page.waitForEvent('domcontentloaded', { timeout: 8_000 }).catch(() => null);
  await page.evaluate((to) => window.history.pushState(null, '', to), path).catch(() => undefined);
  await fresh;
  await page.waitForLoadState('load');
  await page.waitForTimeout(2_500);
}

function cookiesOf(page: Page) {
  return page
    .context()
    .cookies()
    .then((all) => all.filter((c) => GA_COOKIE.test(c.name)));
}

/** A pan ends in onMoveEnd, which rewrites the address to ?z=…&lat=…&lng=… (map-explorer.tsx). */
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
  } else {
    await page.evaluate(() =>
      window.history.replaceState(null, '', '/karta?z=9.00&lat=42.69770&lng=23.32190'),
    );
  }
}

test.describe('Google Analytics behind the card', () => {
  test('a. nothing from Google before an answer, after „Не“, or after a reload', async ({
    page,
  }) => {
    const google = await watchGoogle(page);
    google.step = 'before an answer';
    await page.goto('/privacy');
    await expect(card(page).getByRole('button', { name: CARD.bg.yes })).toBeVisible({
      timeout: 10_000,
    });
    google.step = '„Не“';
    await answer(page, 'no');
    await page.waitForTimeout(1_000);
    google.step = 'reload after „Не“';
    await page.reload();
    await pastTheDelay(page);
    await expect(card(page)).toHaveCount(0);
    google.step = 'the map after „Не“';
    await page.goto('/karta');
    await panTheMap(page);
    await page.waitForTimeout(1_500);
    expect(google.loads).toEqual([]);
    expect(google.hits).toEqual([]);
    expect(google.other).toEqual([]);
    expect(await page.evaluate(() => typeof (window as { gtag?: unknown }).gtag)).toBe('undefined');
    expect(await cookiesOf(page)).toEqual([]);
  });

  test('b. „Да“ loads gtag.js once, the page_view goes out, and a move inside the site sends one', async ({
    page,
    baseURL,
  }) => {
    const google = await watchGoogle(page);
    const origin = new URL(baseURL ?? page.url()).origin;
    google.step = 'landing';
    await page.goto('/statistika?utm_source=nl&utm_medium=email');
    await pastTheDelay(page);
    expect(google.loads, 'nothing before the answer').toEqual([]);
    google.step = '„Да“';
    await answer(page, 'yes');
    const first = await pageView(google, '/statistika');
    expect(first.dt).toBe(await page.title());

    google.step = 'a footer link to /usloviya';
    const mark = google.hits.length;
    await page.locator('footer a[href="/usloviya"]').first().click();
    await expect(page).toHaveURL(`${origin}/usloviya`);
    await pageView(google, '/usloviya', mark);

    expect(tagLoads(google)).toEqual(['„Да“']);
    expect(google.other).toEqual([]);
  });

  test('c. personal pages: no gtag.js on them, nothing sent from them, no token or name later', async ({
    page,
    baseURL,
  }) => {
    const google = await watchGoogle(page);
    const origin = new URL(baseURL ?? page.url()).origin;
    await storedYes(page);
    // A club page needs a club: E2E_CLUB_SLUG names one in the database under test.
    const club = process.env.E2E_CLUB_SLUG;
    const pages = [
      `/otmetka/${TOKEN}`,
      `/klubove/pokana/${HEX}`,
      `/klubove/otmetka/${HEX}`,
      `/sedmitsata/otpisvane/${HEX}`,
      `/pasport/${HANDLE}`,
      '/profil',
      '/admin',
      '/klasirane',
      ...(club ? [`/klub/${club}`] : []),
      '/en/klasirane',
    ];
    const personalLoads: string[] = [];
    for (const path of pages) {
      google.step = `a page load of ${path}`;
      await page.goto(path);
      await page.waitForTimeout(2_500);
      const landed = pathOf(page.url());
      if (personalAt(landed)) personalLoads.push(google.step);
      test.info().annotations.push({ type: 'landed', description: `${path} → ${landed}` });
    }
    expect(
      google.loads.filter((load) => personalLoads.includes(load.step)),
      'no gtag.js on a page load of a personal page',
    ).toEqual([]);

    // Into a personal page while gtag.js runs: Google goes off and the page loads afresh, without it.
    google.step = 'a page load of /karta';
    await page.goto('/karta');
    await pageView(google, '/karta');
    google.step = `the router moves /karta → /otmetka/${TOKEN}`;
    await pushTo(page, `/otmetka/${TOKEN}`);
    expect(new URL(page.url()).pathname).toBe(`/otmetka/${TOKEN}`);
    expect(await page.evaluate(() => typeof (window as { gtag?: unknown }).gtag)).toBe('undefined');

    // Out of it by the router: the public page loads afresh and gtag.js starts there.
    google.step = `the router moves /otmetka/${TOKEN} → /statistika`;
    let mark = google.hits.length;
    await pushTo(page, '/statistika');
    const out = await pageView(google, '/statistika', mark);
    expect(out.dr).not.toMatch(SECRET);

    // Out of a personal page by a real link (the router).
    google.step = 'a page load of /en/klasirane';
    await page.goto('/en/klasirane');
    google.step = 'a link from /en/klasirane to /en/usloviya';
    mark = google.hits.length;
    await page.locator('footer a[href="/en/usloviya"]').first().click();
    await expect(page).toHaveURL(`${origin}/en/usloviya`);
    const link = await pageView(google, '/en/usloviya', mark);
    expect(link.dr).not.toContain('klasirane');

    expect(
      google.hits
        .filter((hit) => personalAt(hit.at))
        .map((hit) => `${hit.step}: ${hit.en} at ${hit.at}`),
      'nothing sent while on a personal page',
    ).toEqual([]);
    for (const hit of google.hits) {
      expect.soft(`${hit.dl} ${hit.dr}`, `${hit.step} ${hit.en}`).not.toMatch(SECRET);
    }
  });

  test('e. a full load after a token page or a passport carries no token in the referrer', async ({
    page,
    baseURL,
  }) => {
    const google = await watchGoogle(page);
    const origin = new URL(baseURL ?? page.url()).origin;
    await storedYes(page);
    const referers: string[] = [];
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        referers.push(`${pathOf(request.url())} ← ${request.headers()['referer'] ?? '(none)'}`);
      }
    });
    for (const path of [
      `/otmetka/${TOKEN}`,
      `/klubove/pokana/${HEX}`,
      `/sedmitsata/otpisvane/${HEX}`,
      `/pasport/${HANDLE}`,
    ]) {
      google.step = `a page load of ${path}`;
      await page.goto(path);
      google.step = `a full load of /statistika from ${path}`;
      const mark = google.hits.length;
      await page
        .evaluate(() => {
          window.location.href = '/statistika';
        })
        .catch(() => undefined);
      await expect(page).toHaveURL(`${origin}/statistika`);
      const view = await pageView(google, '/statistika', mark);
      expect(view.dr, path).toBe('');
    }
    test.info().annotations.push({ type: 'referer', description: referers.join('\n') });
    for (const line of referers.filter((l) => l.startsWith('/statistika'))) {
      expect.soft(line).toBe('/statistika ← (none)');
    }
    for (const hit of google.hits) {
      expect.soft(`${hit.dl} ${hit.dr}`, `${hit.step} ${hit.en}`).not.toMatch(SECRET);
    }
  });

  test('d. withdrawing: Google stops at once and every _ga cookie goes', async ({
    page,
    baseURL,
  }) => {
    const google = await watchGoogle(page);
    const origin = new URL(baseURL ?? page.url()).origin;
    await storedYes(page);
    google.step = 'a page load of /privacy, stored yes';
    await page.goto('/privacy');
    await pageView(google, '/privacy');
    await expect.poll(async () => (await cookiesOf(page)).length).toBeGreaterThanOrEqual(2);
    const set = (await cookiesOf(page)).map((c) => ({
      name: c.name,
      domain: c.domain,
      path: c.path,
      days: Math.round((c.expires - Date.now() / 1000) / 86_400),
    }));
    test.info().annotations.push({ type: 'cookies', description: JSON.stringify(set) });
    expect(set.map((c) => c.name).sort()).toEqual(['_ga', `_ga_${GA.slice(2)}`]);
    for (const c of set) expect(c.days, c.name).toBe(390);

    google.step = '„Не“ from the footer link';
    await page
      .getByRole('contentinfo')
      .getByRole('link', { name: bg.Footer.cookieSettings, exact: true })
      .click();
    await card(page).getByRole('button', { name: CARD.bg.no }).click();
    const before = google.hits.length;
    const off = await page.evaluate(
      (id) => (window as unknown as Record<string, unknown>)[`ga-disable-${id}`],
      GA,
    );
    expect(off).toBe(true);
    expect(await cookiesOf(page), 'no _ga cookie left').toEqual([]);

    google.step = 'after „Не“: a move inside the site';
    await page.locator('footer a[href="/usloviya"]').first().click();
    await expect(page).toHaveURL(`${origin}/usloviya`);
    await page.waitForTimeout(3_000);
    expect(await cookiesOf(page), 'no _ga cookie written again').toEqual([]);
    google.step = 'after „Не“: reload';
    await page.reload();
    await pastTheDelay(page);
    expect(google.hits.slice(before), 'nothing after „Не“').toEqual([]);
    expect(tagLoads(google)).toEqual(['a page load of /privacy, stored yes']);
    expect(await cookiesOf(page), 'no _ga cookie after the reload').toEqual([]);
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
  const google = await watchGoogle(page);
  await page.goto('/karta');
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
  expect(google.loads).toEqual([]);
  expect(google.hits).toEqual([]);
});

test('/consent.js is served as JavaScript, and every page loads it but the widget', async ({
  request,
}) => {
  const script = await request.get('/consent.js');
  expect(script.status()).toBe(200);
  expect(script.headers()['content-type']).toMatch(/javascript/);
  const body = await script.text();
  expect(body).toContain('https://www.googletagmanager.com/gtag/js?id=');
  expect(body).toContain(GA);
  expect(body).not.toMatch(/zaraz|cdn-cgi/i);

  for (const path of ['/', '/en', '/privacy', '/en/privacy', '/karta']) {
    const html = await (await request.get(path)).text();
    expect(html, path).toMatch(/<script[^>]*\ssrc="\/consent\.js"/);
    // Nothing from Google is in the page itself: gtag.js comes only from the card.
    expect(html, path).not.toContain('googletagmanager.com');
  }
  // The embeddable widget renders outside the site's layout: no script at all
  // (accountability.spec.ts pins its headers), so no card for a municipality's
  // visitors either.
  const widget = await (await request.get('/api/widget/obshtina/sofia?lang=bg')).text();
  expect(widget).not.toContain('consent.js');
});

test('token pages and passports ask the browser to send no referrer', async ({ request }) => {
  for (const path of [`/otmetka/${TOKEN}`, `/pasport/${HANDLE}`]) {
    const html = await (await request.get(path)).text();
    expect(html, path).toMatch(/<meta name="referrer" content="no-referrer"/);
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
