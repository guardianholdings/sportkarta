import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import bg from '../messages/bg.json';

/**
 * Umami's tracker, run for real against the front page's «Близо до мен».
 *
 * The tracker (e2e/fixtures/umami-tracker.js, a byte-for-byte copy of the
 * production build) takes over a click on an <a> that carries
 * data-umami-event itself: it cancels the click, sends the event and then
 * loads the address as a full page. On any other element it only sends. So
 * the front page puts the event on a `contents` wrapper around the link
 * (components/home/place-search.tsx): one event per tap, and the map still
 * opens as a client-side navigation.
 *
 * Nothing leaves the runner. The server under test renders no tracker (no
 * UMAMI_* in its env), so the spec adds the fixture after hydration, from a
 * same-origin test path, and answers its sends itself.
 */

const TRACKER = readFileSync(join(process.cwd(), 'e2e', 'fixtures', 'umami-tracker.js'), 'utf8');
const TEST_PATH = '/__e2e/umami';
const WEBSITE_ID = '00000000-0000-4000-8000-000000000000';

interface Send {
  type: string;
  name?: string;
}

/** Serves the tracker on the test path and records every send it makes. */
async function serveTracker(page: Page): Promise<Send[]> {
  const sends: Send[] = [];
  await page.route(`**${TEST_PATH}/script.js`, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: TRACKER }),
  );
  await page.route(`**${TEST_PATH}/api/send`, async (route) => {
    const body = route.request().postDataJSON() as { type: string; payload?: { name?: string } };
    sends.push({ type: body.type, name: body.payload?.name });
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  return sends;
}

/**
 * Opens the front page, waits until the link has hydrated (a tap before that
 * is a plain page load, whatever the tracker does), starts the tracker, waits
 * for its pageview, and marks the document so a reload shows.
 */
async function openHomeWithTracker(page: Page, sends: Send[]): Promise<Locator> {
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  const link = page.getByRole('link', { name: bg.Home.hero.nearMe, exact: true });
  await expect
    .poll(() => link.evaluate((a) => Object.keys(a).some((k) => k.startsWith('__reactProps'))))
    .toBe(true);
  const before = sends.length;
  await page.evaluate(
    ({ src, websiteId }) => {
      const script = document.createElement('script');
      script.src = src;
      script.dataset.websiteId = websiteId;
      script.dataset.excludeSearch = 'true';
      document.head.appendChild(script);
    },
    { src: `${TEST_PATH}/script.js`, websiteId: WEBSITE_ID },
  );
  await expect.poll(() => sends.length).toBeGreaterThan(before);
  await page.evaluate(() => {
    (window as unknown as { e2eSameDocument?: boolean }).e2eSameDocument = true;
  });
  return link;
}

test('«Близо до мен» is counted once and the map opens without a reload', async ({ page }) => {
  const sends = await serveTracker(page);
  const documents: string[] = [];
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documents.push(request.url());
    }
  });
  const named = (name: string): number => sends.filter((s) => s.name === name).length;
  const sameDocument = (): Promise<boolean> =>
    page.evaluate(
      () => (window as unknown as { e2eSameDocument?: boolean }).e2eSameDocument === true,
    );

  // The front page as it ships: the event on the wrapper.
  let link = await openHomeWithTracker(page, sends);
  documents.length = 0;
  await link.click();
  await expect(page).toHaveURL(/\/karta(\?|$)/);
  await expect.poll(() => named('near_me_open')).toBe(1);
  await page.waitForTimeout(1_000);
  expect(named('near_me_open')).toBe(1);
  expect(await sameDocument()).toBe(true);
  expect(documents).toEqual([]);

  // Positive control: the same tap with the event moved onto the <a>, the
  // shape the tracker takes over. It must count once AND load a new page,
  // which shows the tracker is live and that the checks above see a reload.
  link = await openHomeWithTracker(page, sends);
  await link.evaluate((a) => {
    a.parentElement?.removeAttribute('data-umami-event');
    a.setAttribute('data-umami-event', 'e2e_control');
  });
  documents.length = 0;
  await link.click();
  await page.waitForURL(/\/karta(\?|$)/, { waitUntil: 'load' });
  expect(named('e2e_control')).toBe(1);
  expect(named('near_me_open')).toBe(1);
  expect(documents).toHaveLength(1);
  expect(await sameDocument()).toBe(false);
});
