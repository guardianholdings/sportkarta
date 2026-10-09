/**
 * B0 DIAGNOSTIC — draft PR only, not for merge as written.
 *
 * 2026-10-09: an add SAVED in production and then showed the error boundary
 * („Имаме временен проблем от наша страна“). The deploy swap is ruled out (the
 * add committed after it), and the existing add test passes. That test uses a
 * 1x1 JPEG, a desktop Chrome, a member, and blocks the service worker. This
 * spec drives the add the way it happens for real — a phone-sized photo with
 * EXIF orientation, a member AND an admin, the production service worker, a
 * phone viewport — follows the redirect, and records everything the browser
 * saw: page errors, console errors, failed requests, HTTP errors and the
 * server action's own response. The server's stderr lands in the job log
 * under [WebServer].
 */
import { devices, expect, test, type Page, type TestInfo } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';
import sharp from 'sharp';

import bg from '../messages/bg.json';

import { ADMIN_EMAIL, signIn } from './auth';

// Repo-root .env (Playwright runs with cwd = apps/web).
config({ path: '../../.env' });

/** Both error.tsx and global-error.tsx render this title. */
const ERROR_BOUNDARY = bg.ErrorPage.title;
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
    if (r.status() >= 400)
      seen.httpErrors.push(`${req.method()} ${url.pathname}${url.search} -> ${r.status()}`);
  });
  return seen;
}

async function addAndFollow(page: Page, testInfo: TestInfo, email: string, label: string) {
  const seen = watch(page);
  await signIn(page, email, /\/profil/);

  // A fresh point per run, south-west of the seeded Sofia facilities and away
  // from the box contributions.spec.ts uses, so no duplicate guard can fire.
  const stamp = Date.now();
  const lon = (23.25 + (stamp % 4000) / 100000).toFixed(5);
  const lat = (42.62 + (Math.floor(stamp / 4000) % 3000) / 100000).toFixed(5);
  const name = `E2E B0 ${label} ${stamp}`;
  await page.context().setGeolocation({ longitude: Number(lon), latitude: Number(lat) });

  await page.goto(`/dobavi?lon=${lon}&lat=${lat}`);
  const swControlled = await page.evaluate(() => Boolean(navigator.serviceWorker?.controller));
  const photo = await realPhoto();
  await page.locator('input[name="photo"]').setInputFiles({
    name: 'IMG_4031.JPG',
    mimeType: 'image/jpeg',
    buffer: photo,
  });
  await page.getByRole('button', { name: /баскетбол|basketball/i }).click();
  await page.getByLabel(/име|name/i).fill(name);
  const form = page.locator('form').filter({ has: page.getByRole('button', { name: SUBMIT }) });
  await expect(form.getByText(bg.Contribute.locationGranted)).toBeVisible();
  await page.getByRole('button', { name: SUBMIT }).click();

  const outcome = await Promise.race([
    page.waitForURL(/\/obekt\/[a-z0-9-]+\?added=\d+$/, { timeout: 45_000 }).then(() => 'landed'),
    page
      .getByText(ERROR_BOUNDARY)
      .waitFor({ timeout: 45_000 })
      .then(() => 'error-boundary'),
  ]).catch((e: unknown) => `neither within 45 s: ${String(e).slice(0, 200)}`);
  // Let the page's client effects run (map, the forms' position fixes).
  await page.waitForTimeout(4_000);
  const errorAfterLanding = await page.getByText(ERROR_BOUNDARY).count();
  const reference = await page
    .getByText(/Код за справка|Reference/)
    .first()
    .textContent({ timeout: 500 })
    .catch(() => null);
  const landedUrl = new URL(page.url());

  // A fresh load of the same page as the same signed-in account. With the
  // service worker in control, reload() reports no network response (the
  // worker answers the navigation), so the status then comes from a direct GET
  // with the same cookies.
  const reload = await page.reload();
  const reloadStatus = reload?.status() ?? (await page.request.get(page.url())).status();
  await page.waitForTimeout(3_000);
  const errorAfterReload = await page.getByText(ERROR_BOUNDARY).count();

  const rows = await query<{ id: string; status: string; access: string }>(
    `SELECT id, status, access FROM facilities WHERE name = $1`,
    [name],
  );
  const report = {
    label,
    photoBytes: photo.byteLength,
    swControlled,
    outcome,
    landed: `${landedUrl.pathname.replace(/\/obekt\/.+$/, '/obekt/<slug>')}${landedUrl.search}`,
    errorAfterLanding,
    reference,
    reloadStatus,
    errorAfterReload,
    saved: rows.map((r) => `${r.status}/${r.access}`),
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
  expect.soft(outcome, 'the redirect landed on the new place').toBe('landed');
  expect.soft(errorAfterLanding, 'no error boundary after landing').toBe(0);
  expect.soft(reloadStatus, 'a fresh load answers 200').toBe(200);
  expect.soft(errorAfterReload, 'no error boundary after a fresh load').toBe(0);
  expect.soft(seen.pageErrors, 'no uncaught page errors').toEqual([]);
  const points = landedUrl.searchParams.get('added');
  if (outcome === 'landed' && points !== null) {
    await expect(
      page.getByText(
        Number(points) > 0
          ? bg.Contribute.thanksWithPoints.replace('{points}', points)
          : bg.Contribute.thanksNoPoints,
      ),
    ).toBeVisible();
  }
}

const memberEmail = (label: string) => `e2e-b0-${label}@example.org`;

test.describe('B0 diagnostic: add, then follow the redirect', () => {
  test.use({ permissions: ['geolocation'] });
  test.setTimeout(150_000);

  test.describe('desktop, service worker blocked (as the suite runs)', () => {
    test('member', async ({ page }, testInfo) => {
      await query(`DELETE FROM users WHERE email = $1`, [memberEmail('desktop-member')]);
      await addAndFollow(page, testInfo, memberEmail('desktop-member'), 'desktop-member');
    });
    test('admin', async ({ page }, testInfo) => {
      await addAndFollow(page, testInfo, ADMIN_EMAIL, 'desktop-admin');
    });
  });

  test.describe('desktop, service worker allowed (as production runs)', () => {
    test.use({ serviceWorkers: 'allow' });
    test('admin', async ({ page }, testInfo) => {
      await addAndFollow(page, testInfo, ADMIN_EMAIL, 'desktop-admin-sw');
    });
  });

  test.describe('phone viewport (iPhone 13 metrics on Chromium), service worker allowed', () => {
    const iphone = devices['iPhone 13'];
    test.use({
      serviceWorkers: 'allow',
      viewport: iphone.viewport,
      userAgent: iphone.userAgent,
      deviceScaleFactor: iphone.deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
    });
    test('member', async ({ page }, testInfo) => {
      await query(`DELETE FROM users WHERE email = $1`, [memberEmail('phone-member')]);
      await addAndFollow(page, testInfo, memberEmail('phone-member'), 'phone-member');
    });
    test('admin', async ({ page }, testInfo) => {
      await addAndFollow(page, testInfo, ADMIN_EMAIL, 'phone-admin');
    });
  });
});
