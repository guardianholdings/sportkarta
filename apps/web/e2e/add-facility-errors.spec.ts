import { expect, test, type Page, type Route } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';

import bg from '../messages/bg.json';

import { signIn } from './auth';

// Repo-root .env (Playwright runs with cwd = apps/web).
config({ path: '../../.env' });

/**
 * B (add-facility errors): what a member sees when a contribution form gets no
 * usable answer or a refusal, and that nothing they filled in is lost on the
 * way. Strings come from messages/bg.json, never retyped.
 */

/** A distinct account per test: contributions are rate-limited per account. */
function memberEmail(testInfo: { title: string }): string {
  const slug = testInfo.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  return `e2e-addfix-${slug}@example.org`;
}

async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the add-facility errors e2e suite');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** A real 1×1 JPEG, the same fixture as contributions.spec.ts. */
const PIXEL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

/** A point inside Bulgaria, fresh per run, away from the seeded Sofia facilities. */
function freshPoint(): { lon: string; lat: string } {
  const stamp = Date.now();
  return {
    lon: (25.2 + (stamp % 5000) / 100000).toFixed(5),
    lat: (42.4 + (Math.floor(stamp / 5000) % 5000) / 100000).toFixed(5),
  };
}

/**
 * Answer the form's server-action calls the way a server redeployed while the
 * form was open does: 404 with Next's `x-nextjs-action-not-found` header (the
 * action id no longer exists). Everything else passes. Returns the undo.
 */
async function deployWhileOpen(page: Page, url: string): Promise<() => Promise<void>> {
  const handler = async (route: Route) => {
    const request = route.request();
    if (request.method() === 'POST' && request.headers()['next-action']) {
      await route.fulfill({
        status: 404,
        headers: { 'x-nextjs-action-not-found': '1', 'content-type': 'text/plain' },
        body: 'Server action not found.',
      });
      return;
    }
    await route.continue();
  };
  await page.route(url, handler);
  return () => page.unroute(url, handler);
}

const SUBMIT = bg.AddFacility.submit;
const SPORT = /баскетбол|basketball/i;

/** Fill every field the add form keeps, plus a photo (required on this form). */
async function fillAddForm(page: Page, name: string): Promise<void> {
  await page.locator('input[name="photo"]').setInputFiles({
    name: 'pitch.jpg',
    mimeType: 'image/jpeg',
    buffer: PIXEL_JPEG,
  });
  // Sports are toggle chips (role=button, aria-pressed), not native checkboxes.
  await page.getByRole('button', { name: SPORT }).click();
  await page.locator('select[name="access"]').selectOption('restricted');
  await page.getByLabel(bg.AddFacility.nameLabel).fill(name);
  await page.getByLabel(bg.AddFacility.quarterLabel).fill('Център');
}

async function expectAddFormKept(page: Page, name: string): Promise<void> {
  await expect(page.getByLabel(bg.AddFacility.nameLabel)).toHaveValue(name);
  await expect(page.getByLabel(bg.AddFacility.quarterLabel)).toHaveValue('Център');
  await expect(page.getByRole('button', { name: SPORT })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('select[name="access"]')).toHaveValue('restricted');
}

test.describe('add-facility errors (B)', () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright passes testInfo second
  test.beforeEach(async ({}, testInfo) => {
    await query(`DELETE FROM users WHERE email = $1`, [memberEmail(testInfo)]);
  });

  test('a form left open across a deploy keeps the pin, sports, access and text through the reload', async ({
    page,
  }, testInfo) => {
    await signIn(page, memberEmail(testInfo), /\/profil/);
    const { lon, lat } = freshPoint();
    await page.goto(`/dobavi?lon=${lon}&lat=${lat}`);
    const name = `E2E B форма ${Date.now()}`;
    await fillAddForm(page, name);

    const undo = await deployWhileOpen(page, '**/dobavi**');
    await page.getByRole('button', { name: SUBMIT }).click();
    const failure = page.getByRole('alert').filter({ hasText: bg.FormRecovery.staleForm });
    await expect(failure).toBeVisible();
    // Line 10: a picked photo cannot survive the reload, and the member is told.
    await expect(failure.getByText(bg.FormRecovery.photoAgain)).toBeVisible();
    await undo();

    // The pin must come back from the kept form, not from the address: drop the
    // ?lon=&lat= the page was opened with before reloading.
    await page.evaluate(() => window.history.replaceState(window.history.state, '', '/dobavi'));
    await Promise.all([
      page.waitForEvent('load'),
      failure.getByRole('button', { name: bg.FormRecovery.reload }).click(),
    ]);
    expect(new URL(page.url()).search).toBe('');

    await expectAddFormKept(page, name);
    await expect
      .poll(async () => Number(await page.locator('input[name="lon"]').inputValue()))
      .toBeCloseTo(Number(lon), 5);
    await expect
      .poll(async () => Number(await page.locator('input[name="lat"]').inputValue()))
      .toBeCloseTo(Number(lat), 5);
    // Never kept: the photo.
    expect(
      await page
        .locator('input[name="photo"]')
        .evaluate((input: HTMLInputElement) => input.files?.length ?? 0),
    ).toBe(0);
    await expect(page.getByText(bg.FormRecovery.staleForm)).toHaveCount(0);
  });

  test('a refusal from the server keeps what was filled in', async ({ page }, testInfo) => {
    await signIn(page, memberEmail(testInfo), /\/profil/);
    // Belgrade: a plausible-looking pin that is not in Bulgaria.
    await page.goto('/dobavi?lon=20.45&lat=44.79');
    const name = `E2E B отказ ${Date.now()}`;
    await fillAddForm(page, name);
    await page.getByRole('button', { name: SUBMIT }).click();

    // Scope past Next's route announcer, which is also role=alert.
    await expect(
      page.getByRole('alert').filter({ hasText: bg.AddFacility.error_outside_bulgaria }),
    ).toBeVisible();
    await expectAddFormKept(page, name);
  });
});
