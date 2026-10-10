/**
 * B0 DIAGNOSTIC — draft PR only, not for merge as written.
 *
 * 2026-10-09: an add SAVED in production and then showed the error boundary
 * („Имаме временен проблем от наша страна“). The deploy swap is ruled out (the
 * add committed after it), and the existing add test passes. That test uses a
 * 1x1 JPEG, a desktop Chrome, a member, and blocks the service worker. This
 * spec drives the add the way it happens for real — a phone-sized photo with
 * EXIF orientation, a member AND an admin, the production service worker,
 * phone and Safari engines, English, no GPS fix — follows the redirect, and
 * records everything the browser saw: page errors, console errors, failed
 * requests, HTTP errors and the server action's own response. The server's
 * stderr lands in the job log under [WebServer].
 *
 * Round 2 runs it against the server the way production runs it (E2E_STANDALONE:
 * `node apps/web/server.js`, HOSTNAME=0.0.0.0, the app tree read-only except
 * .next/cache, as in the Docker image) instead of `next start`.
 */
import { devices, expect, test, type Page, type TestInfo } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';
import sharp from 'sharp';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

import { ADMIN_EMAIL, signIn } from './auth';

// Repo-root .env (Playwright runs with cwd = apps/web).
config({ path: '../../.env' });

const MESSAGES = { bg, en } as const;
type Locale = keyof typeof MESSAGES;
const SUBMIT = /добави съоръжението|add facility/i;

async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** 12 MP, 2.7 MB, EXIF orientation 6: what a phone camera hands the file input. */
let phonePhoto: Buffer | null = null;
async function realPhoto(): Promise<Buffer> {
  phonePhoto ??= await sharp({
    create: {
      width: 4032,
      height: 3024,
      channels: 3,
      background: { r: 96, g: 140, b: 72 },
      noise: { type: 'gaussian', mean: 118, sigma: 14 },
    },
  })
    .jpeg({ quality: 82 })
    .withMetadata({ orientation: 6 })
    .toBuffer();
  return phonePhoto;
}

interface Seen {
  pageErrors: string[];
  console: string[];
  failedRequests: string[];
  httpErrors: string[];
  action: string[];
}

function watch(page: Page): Seen {
  const seen: Seen = {
    pageErrors: [],
    console: [],
    failedRequests: [],
    httpErrors: [],
    action: [],
  };
  page.on('pageerror', (e) =>
    seen.pageErrors.push(
      `${e.name}: ${e.message}\n${(e.stack ?? '').split('\n').slice(1, 8).join('\n')}`,
    ),
  );
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      seen.console.push(`${m.type()}: ${m.text().slice(0, 600)}`);
    }
  });
  page.on('requestfailed', (r) => {
    const url = new URL(r.url());
    seen.failedRequests.push(
      `${r.method()} ${url.pathname}${url.search} ${r.failure()?.errorText ?? ''}`,
    );
  });
  page.on('response', (r) => {
    const req = r.request();
    const url = new URL(r.url());
    const headers = r.headers();
    if (req.method() === 'POST' && req.headers()['next-action']) {
      seen.action.push(
        `POST ${url.pathname} -> ${r.status()} x-action-redirect=${headers['x-action-redirect'] ?? '-'} ` +
          `content-type=${headers['content-type'] ?? '-'} x-nextjs-action-not-found=${headers['x-nextjs-action-not-found'] ?? '-'}`,
      );
    }
    if (r.status() >= 400) {
      seen.httpErrors.push(`${req.method()} ${url.pathname}${url.search} -> ${r.status()}`);
    }
  });
  return seen;
}

interface AddOptions {
  locale?: Locale;
  /** Grant a GPS fix at the pin (the usual phone case). Off = a desktop without one. */
  position?: boolean;
  access?: 'free' | 'paid';
  /**
   * Mechanism check: the server runs the action and commits, and the browser
   * never gets the answer (a phone switching networks, a proxy dropping the
   * stream). Today that shows the error page over a saved place.
   */
  loseResponse?: boolean;
}

async function addAndFollow(
  page: Page,
  testInfo: TestInfo,
  email: string,
  label: string,
  { locale = 'bg', position = true, access = 'free', loseResponse = false }: AddOptions = {},
) {
  const m = MESSAGES[locale];
  const prefix = locale === 'bg' ? '' : `/${locale}`;
  const seen = watch(page);
  await signIn(page, email, /\/profil/);

  // A fresh point per add, south-west of the seeded Sofia facilities and away
  // from the box contributions.spec.ts uses. Round 2 placed points by
  // milliseconds and two adds could fall inside the 30 m duplicate radius;
  // now the point moves ~11 m north per second and ~400 m east every 10 min,
  // and no two adds in a run start within 3 s of each other.
  const stamp = Date.now();
  const seconds = Math.floor(stamp / 1000);
  const lon = (23.25 + (Math.floor(seconds / 600) % 10) * 0.005).toFixed(5);
  const lat = (42.62 + (seconds % 600) * 0.0001).toFixed(5);
  const name = `E2E B0 ${label} ${stamp}`;
  if (position) {
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({ longitude: Number(lon), latitude: Number(lat) });
  }

  await page.goto(`${prefix}/dobavi?lon=${lon}&lat=${lat}`);
  const swControlled = await page.evaluate(() => Boolean(navigator.serviceWorker?.controller));
  const photo = await realPhoto();
  await page.locator('input[name="photo"]').setInputFiles({
    name: 'IMG_4031.JPG',
    mimeType: 'image/jpeg',
    buffer: photo,
  });
  await page.getByRole('button', { name: /баскетбол|basketball/i }).click();
  await page.getByLabel(/име|name/i).fill(name);
  if (access !== 'free') await page.locator('select[name="access"]').selectOption(access);
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: SUBMIT }) });
  if (position) await expect(form.getByText(m.Contribute.locationGranted)).toBeVisible();
  else await page.waitForTimeout(1_500);
  // The photo field holds the submit natively (a custom validity message)
  // while the browser shrinks the photo; a tap before that is refused by the
  // browser and sends nothing. Wait it out, and record how long it took.
  const photoInput = page.locator('input[name="photo"]');
  const photoStart = Date.now();
  await expect
    .poll(() => photoInput.evaluate((el: HTMLInputElement) => el.validationMessage), {
      timeout: 90_000,
    })
    .toBe('');
  const photoReadyMs = Date.now() - photoStart;
  const sentPhotoBytes = await photoInput.evaluate(
    (el: HTMLInputElement) => el.files?.[0]?.size ?? 0,
  );
  let lostResponseStatus: number | null = null;
  let lostResponseNote: string | null = null;
  if (loseResponse) {
    await page.route(
      (url) => url.pathname.endsWith('/dobavi'),
      async (route) => {
        const req = route.request();
        if (req.method() !== 'POST' || !req.headers()['next-action']) return route.continue();
        try {
          const answered = await route.fetch({ maxRedirects: 0 });
          lostResponseStatus = answered.status();
        } catch (e: unknown) {
          lostResponseNote = String(e).slice(0, 200);
        }
        return route.abort('connectionreset');
      },
    );
  }
  await page.getByRole('button', { name: SUBMIT }).click();

  const outcome = await Promise.race([
    page.waitForURL(/\/obekt\/[a-z0-9-]+\?added=\d+$/, { timeout: 45_000 }).then(() => 'landed'),
    page
      .getByText(m.ErrorPage.title)
      .waitFor({ timeout: 45_000 })
      .then(() => 'error-boundary'),
  ]).catch((e: unknown) => `neither within 45 s: ${String(e).slice(0, 200)}`);
  // Let the page's client effects run (map, the forms' position fixes).
  await page.waitForTimeout(4_000);
  const inlineError = await form
    .getByRole('alert')
    .first()
    .textContent({ timeout: 500 })
    .catch(() => null);
  const errorAfterLanding = await page.getByText(m.ErrorPage.title).count();
  const reference = await page
    .getByText(/Код за справка|Reference/)
    .first()
    .textContent({ timeout: 500 })
    .catch(() => null);
  const landedUrl = new URL(page.url());
  const h1 = await page
    .locator('h1')
    .first()
    .textContent({ timeout: 500 })
    .catch(() => null);
  // What a direct request for the landed URL answers, as the same account.
  const directStatus = (await page.request.get(page.url())).status();

  // A fresh load of the same page as the same signed-in account.
  await page.reload();
  await page.waitForTimeout(3_000);
  const errorAfterReload = await page.getByText(m.ErrorPage.title).count();

  const rows = await query<{ id: string; status: string; access: string; municipality: boolean }>(
    `SELECT id, status, access, municipality_id IS NOT NULL AS municipality
       FROM facilities WHERE name = $1`,
    [name],
  );
  const awarded = landedUrl.searchParams.get('added');
  const report = {
    label,
    server: process.env.E2E_STANDALONE ? 'standalone (as production)' : 'next start',
    engine: page.context().browser()?.browserType().name() ?? null,
    locale,
    position,
    access,
    photoBytes: photo.byteLength,
    photoReadyMs,
    sentPhotoBytes,
    loseResponse,
    lostResponseStatus,
    lostResponseNote,
    swControlled,
    outcome,
    inlineError,
    landed: `${landedUrl.pathname.replace(/\/obekt\/.+$/, '/obekt/<slug>')}${landedUrl.search}`,
    h1: h1?.includes('E2E B0') ? '<the new place>' : h1,
    directStatus,
    errorAfterLanding,
    reference,
    errorAfterReload,
    saved: rows.map((r) => `${r.status}/${r.access}/municipality=${String(r.municipality)}`),
    ...seen,
  };
  console.log(`B0 DIAGNOSTIC ${JSON.stringify(report, null, 2)}`);
  await testInfo.attach(`b0-${label}.json`, {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });

  // Out of the moderation queue, as contributions.spec.ts does: facilities
  // cannot be deleted, and other suites read the verify deck.
  for (const row of rows) {
    await query(`UPDATE facilities SET status = 'active' WHERE id = $1::uuid`, [row.id]);
  }

  expect.soft(rows, 'the add was saved').toHaveLength(1);
  if (loseResponse) {
    // Today's behaviour, recorded rather than wished away: the place is
    // saved and the member sees the error page. B turns this into an inline
    // message that points to the saved place.
    expect.soft(lostResponseStatus, 'the server answered the action').toBe(303);
    expect.soft(outcome, 'mechanism: a lost answer after the save').toBe('error-boundary');
    return;
  }
  expect.soft(outcome, 'the redirect landed on the new place').toBe('landed');
  expect.soft(errorAfterLanding, 'no error boundary after landing').toBe(0);
  expect.soft(errorAfterReload, 'no error boundary after a fresh load').toBe(0);
  // WebKit reports a prefetch that a navigation cancelled as an uncaught
  // "… due to access control checks" error, and Next falls back to a full
  // load. Recorded in the report, not failed on.
  const pageErrors = seen.pageErrors.filter(
    (e) => !/Fetch API cannot load .*_rsc=.* due to access control checks/.test(e),
  );
  expect.soft(pageErrors, 'no uncaught page errors').toEqual([]);
  if (access === 'paid') {
    // Finding 1 (CEO, 2026-10-09): paid places are hidden while
    // public_show_paid is false, so the redirect lands on a 404. Recorded
    // here, fixed in B.
    expect.soft(directStatus, 'finding 1: a paid add lands on a 404').toBe(404);
    return;
  }
  expect.soft(directStatus, 'the new place answers 200').toBe(200);
  if (outcome === 'landed' && awarded !== null) {
    await expect(
      page.getByText(
        Number(awarded) > 0
          ? m.Contribute.thanksWithPoints.replace('{points}', awarded)
          : m.Contribute.thanksNoPoints,
      ),
    ).toBeVisible();
  }
}

async function freshMember(label: string): Promise<string> {
  const email = `e2e-b0-${label}@example.org`;
  await query(`DELETE FROM users WHERE email = $1`, [email]);
  return email;
}

const iphone = devices['iPhone 13'];
const phone = {
  viewport: iphone.viewport,
  userAgent: iphone.userAgent,
  deviceScaleFactor: iphone.deviceScaleFactor,
  isMobile: true,
  hasTouch: true,
};
const safari = devices['Desktop Safari'];

test.describe('B0 diagnostic: add, then follow the redirect', () => {
  test.setTimeout(150_000);
  // One clean attempt per case: a retry hides exactly the flake we look for,
  // and its second add can trip the first one's duplicate guard.
  test.describe.configure({ retries: 0 });

  test.describe('Chromium', () => {
    test.skip(({ browserName }) => browserName !== 'chromium', 'the webkit project runs below');

    test.describe('desktop, service worker blocked (as the suite runs)', () => {
      test('member', async ({ page }, testInfo) => {
        await addAndFollow(page, testInfo, await freshMember('desktop-member'), 'desktop-member');
      });
      test('member, the answer is lost after the save (mechanism)', async ({ page }, testInfo) => {
        const email = await freshMember('desktop-member-lost');
        await addAndFollow(page, testInfo, email, 'desktop-member-lost', { loseResponse: true });
      });
      test('admin', async ({ page }, testInfo) => {
        await addAndFollow(page, testInfo, ADMIN_EMAIL, 'desktop-admin');
      });
      test('admin, English, no GPS fix', async ({ page }, testInfo) => {
        await addAndFollow(page, testInfo, ADMIN_EMAIL, 'desktop-admin-en-nogps', {
          locale: 'en',
          position: false,
        });
      });
      test('member, paid (finding 1)', async ({ page }, testInfo) => {
        const email = await freshMember('desktop-member-paid');
        await addAndFollow(page, testInfo, email, 'desktop-member-paid', { access: 'paid' });
      });
    });

    test.describe('desktop, service worker allowed (as production runs)', () => {
      test.use({ serviceWorkers: 'allow' });
      test('admin', async ({ page }, testInfo) => {
        await addAndFollow(page, testInfo, ADMIN_EMAIL, 'desktop-admin-sw');
      });
      test('admin, no GPS fix', async ({ page }, testInfo) => {
        await addAndFollow(page, testInfo, ADMIN_EMAIL, 'desktop-admin-sw-nogps', {
          position: false,
        });
      });
    });

    test.describe('phone viewport (iPhone 13 metrics), service worker allowed', () => {
      test.use({ serviceWorkers: 'allow', ...phone });
      test('member', async ({ page }, testInfo) => {
        await addAndFollow(page, testInfo, await freshMember('phone-member'), 'phone-member');
      });
      test('admin', async ({ page }, testInfo) => {
        await addAndFollow(page, testInfo, ADMIN_EMAIL, 'phone-admin');
      });
    });
  });

  // The `webkit` project exists only when E2E_WEBKIT is set (the diagnostic
  // workflow installs the browser); browserName cannot be switched per group.
  test.describe('WebKit (Safari engine)', () => {
    test.skip(({ browserName }) => browserName !== 'webkit', 'needs the webkit project');

    test.describe('desktop, service worker allowed', () => {
      test.use({
        serviceWorkers: 'allow',
        viewport: safari.viewport,
        userAgent: safari.userAgent,
        deviceScaleFactor: safari.deviceScaleFactor,
      });
      test('admin', async ({ page }, testInfo) => {
        await addAndFollow(page, testInfo, ADMIN_EMAIL, 'safari-admin');
      });
      test('admin, no GPS fix', async ({ page }, testInfo) => {
        await addAndFollow(page, testInfo, ADMIN_EMAIL, 'safari-admin-nogps', {
          position: false,
        });
      });
      test('member, English', async ({ page }, testInfo) => {
        const email = await freshMember('safari-member-en');
        await addAndFollow(page, testInfo, email, 'safari-member-en', { locale: 'en' });
      });
    });

    test.describe('iPhone 13, service worker allowed', () => {
      test.use({ serviceWorkers: 'allow', ...phone });
      test('member', async ({ page }, testInfo) => {
        await addAndFollow(page, testInfo, await freshMember('iphone-member'), 'iphone-member');
      });
      test('admin', async ({ page }, testInfo) => {
        await addAndFollow(page, testInfo, ADMIN_EMAIL, 'iphone-admin');
      });
    });

    // Request interception needs the service worker out of the way.
    test.describe('iPhone 13, service worker blocked', () => {
      test.use({ serviceWorkers: 'block', ...phone });
      test('member, the answer is lost after the save (mechanism)', async ({ page }, testInfo) => {
        const email = await freshMember('iphone-member-lost');
        await addAndFollow(page, testInfo, email, 'iphone-member-lost', { loseResponse: true });
      });
    });
  });
});
