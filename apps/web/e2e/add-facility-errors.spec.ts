import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
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

  // ── The verify and condition forms on /obekt/<slug> ──

  /** A facility added by somebody else (no author), so the verify form shows. */
  async function insertFacility(status: 'active' | 'needs_verification'): Promise<string> {
    const slug = `e2e-addfix-${status === 'active' ? 'condition' : 'verify'}-${Date.now()}`;
    const { lon, lat } = freshPoint();
    await query(
      `INSERT INTO facilities (geom, name, sport_types, access, status, source, slug)
       VALUES (ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326), 'E2E B формуляр',
               '{basketball}', 'free', $3, 'crowd', $4)`,
      [lon, lat, status, slug],
    );
    return slug;
  }

  const verifyForm = (page: Page) =>
    page.locator('form').filter({ has: page.locator('input[name="fields"]') });
  const conditionForm = (page: Page) =>
    page.locator('form').filter({ has: page.locator('input[name="state"]') });
  const staleIn = (form: Locator) =>
    form.getByRole('alert').filter({ hasText: bg.FormRecovery.staleForm });

  async function reloadFrom(page: Page, failure: Locator): Promise<void> {
    await Promise.all([
      page.waitForEvent('load'),
      failure.getByRole('button', { name: bg.FormRecovery.reload }).click(),
    ]);
  }

  test('the verify form keeps its checklist through the reload, with no photo line', async ({
    page,
  }, testInfo) => {
    await signIn(page, memberEmail(testInfo), /\/profil/);
    await page.goto(`/obekt/${await insertFacility('needs_verification')}`);
    const form = verifyForm(page);
    // Every answer differs from the record (free, no surface, lighting unknown,
    // not covered, basketball only), so a value seen after the reload was kept.
    await form.locator('select[name="access"]').selectOption('restricted');
    const surface =
      (await form.locator('select[name="surface"] option').nth(1).getAttribute('value')) ?? '';
    expect(surface).not.toBe('');
    await form.locator('select[name="surface"]').selectOption(surface);
    await form.locator('input[name="lighting"][value="yes"]').check({ force: true });
    await form.locator('input[name="covered"]').check({ force: true });
    await form.locator('input[name="sportTypes"][value="football"]').check({ force: true });

    const undo = await deployWhileOpen(page, '**/obekt/**');
    await form.getByRole('button', { name: bg.Contribute.verifySubmit, exact: true }).click();
    const failure = staleIn(form);
    await expect(failure).toBeVisible();
    // Line 10 is for a picked photo, and this form has no photo field.
    await expect(failure.getByText(bg.FormRecovery.photoAgain)).toHaveCount(0);
    await undo();
    await reloadFrom(page, failure);

    const kept = verifyForm(page);
    await expect(kept.locator('select[name="access"]')).toHaveValue('restricted');
    await expect(kept.locator('select[name="surface"]')).toHaveValue(surface);
    await expect(kept.locator('input[name="lighting"][value="yes"]')).toBeChecked();
    await expect(kept.locator('input[name="covered"]')).toBeChecked();
    await expect(kept.locator('input[name="sportTypes"][value="football"]')).toBeChecked();
    await expect(kept.locator('input[name="sportTypes"][value="basketball"]')).toBeChecked();
    await expect(page.getByText(bg.FormRecovery.staleForm)).toHaveCount(0);
  });

  test('a kept «не» brings the verify form back with its checklist hidden', async ({
    page,
  }, testInfo) => {
    await signIn(page, memberEmail(testInfo), /\/profil/);
    await page.goto(`/obekt/${await insertFacility('needs_verification')}`);
    const form = verifyForm(page);
    await form.locator('input[name="exists"][value="no"]').check({ force: true });
    await expect(form.locator('select[name="access"]')).toHaveCount(0);

    const undo = await deployWhileOpen(page, '**/obekt/**');
    await form.getByRole('button', { name: bg.Contribute.verifySubmit, exact: true }).click();
    const failure = staleIn(form);
    await expect(failure).toBeVisible();
    await undo();
    await reloadFrom(page, failure);

    const kept = verifyForm(page);
    await expect(kept.locator('input[name="exists"][value="no"]')).toBeChecked();
    await expect(kept.getByText(bg.Contribute.existsNoHint)).toBeVisible();
    await expect(kept.locator('select[name="access"]')).toHaveCount(0);
  });

  test('the condition form keeps state and tags; line 10 only once a photo is picked', async ({
    page,
  }, testInfo) => {
    await signIn(page, memberEmail(testInfo), /\/profil/);
    await page.goto(`/obekt/${await insertFacility('active')}`);
    const form = conditionForm(page);
    await form.locator('input[name="state"][value="poor"]').check({ force: true });
    await form.locator('input[name="tags"][value="litter"]').check({ force: true });

    const undo = await deployWhileOpen(page, '**/obekt/**');
    const submit = form.getByRole('button', { name: bg.Contribute.conditionSubmit, exact: true });
    await submit.click();
    const failure = staleIn(form);
    await expect(failure).toBeVisible();
    await expect(failure.getByText(bg.FormRecovery.photoAgain)).toHaveCount(0);

    // The same failure once a photo is picked: now line 10 is there.
    await form.locator('input[name="photo"]').setInputFiles({
      name: 'pitch.jpg',
      mimeType: 'image/jpeg',
      buffer: PIXEL_JPEG,
    });
    await submit.click();
    await expect(failure.getByText(bg.FormRecovery.photoAgain)).toBeVisible();
    await undo();
    await reloadFrom(page, failure);

    const kept = conditionForm(page);
    await expect(kept.locator('input[name="state"][value="poor"]')).toBeChecked();
    await expect(kept.locator('input[name="tags"][value="litter"]')).toBeChecked();
    expect(
      await kept
        .locator('input[name="photo"]')
        .evaluate((input: HTMLInputElement) => input.files?.length ?? 0),
    ).toBe(0);
  });

  // ── Failures the server answers, or that cut its answer off ──

  /** PIXEL_JPEG cut right after its scan header: it reads as a JPEG but cannot be decoded. */
  function truncatedJpeg(): Buffer {
    const sos = PIXEL_JPEG.indexOf(Buffer.from([0xff, 0xda]));
    return PIXEL_JPEG.subarray(0, sos + 2 + PIXEL_JPEG.readUInt16BE(sos + 2));
  }

  /** A paid place somebody else added: hidden while public_show_paid is not 'true'. */
  async function insertHiddenPaid(lon: string, lat: string): Promise<void> {
    await query(
      `INSERT INTO facilities (geom, name, sport_types, access, status, source, slug)
       VALUES (ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326), 'E2E B платено',
               '{basketball}', 'paid', 'active', 'crowd', $3)`,
      [lon, lat, `e2e-addfix-paid-${Date.now()}`],
    );
  }

  test('a connection cut after the save, then a resend: line 6, line 4, one facility', async ({
    page,
  }, testInfo) => {
    await signIn(page, memberEmail(testInfo), /\/profil/);
    const { lon, lat } = freshPoint();
    await page.goto(`/dobavi?lon=${lon}&lat=${lat}`);
    const name = `E2E B прекъсване ${Date.now()}`;
    await fillAddForm(page, name);

    // The server saves the facility; its answer never reaches the browser.
    const cutAfterSave = async (route: Route) => {
      const request = route.request();
      if (request.method() === 'POST' && request.headers()['next-action']) {
        await route.fetch({ maxRedirects: 0 });
        await route.abort('connectionreset');
        return;
      }
      await route.continue();
    };
    await page.route('**/dobavi**', cutAfterSave);
    await page.getByRole('button', { name: SUBMIT }).click();
    // Generous: the abort waits for the server's whole answer (under `next dev`
    // that includes compiling the facility page the action redirects to).
    await expect(
      page.getByRole('alert').filter({ hasText: bg.AddFacility.error_no_answer }),
    ).toBeVisible({ timeout: 30_000 });
    await page.unroute('**/dobavi**', cutAfterSave);
    await expectAddFormKept(page, name);

    // The resend finds the member's own facility instead of adding a second one.
    await page.getByRole('button', { name: SUBMIT }).click();
    const own = page.getByRole('alert').filter({ hasText: bg.AddFacility.error_duplicate_own });
    await expect(own).toBeVisible();
    await expect(own.getByRole('link', { name: bg.AddFacility.toFacility })).toHaveAttribute(
      'href',
      /\/obekt\/[^/?#]+$/,
    );
    expect(await query(`SELECT 1 FROM facilities WHERE name = $1`, [name])).toHaveLength(1);
  });

  test('a photo that cannot be decoded is refused as one, and the form stays filled in', async ({
    page,
  }, testInfo) => {
    await signIn(page, memberEmail(testInfo), /\/profil/);
    const { lon, lat } = freshPoint();
    await page.goto(`/dobavi?lon=${lon}&lat=${lat}`);
    const name = `E2E B снимка ${Date.now()}`;
    await fillAddForm(page, name);
    await page.locator('input[name="photo"]').setInputFiles({
      name: 'pitch.jpg',
      mimeType: 'image/jpeg',
      buffer: truncatedJpeg(),
    });
    await page.getByRole('button', { name: SUBMIT }).click();

    await expect(
      page.getByRole('alert').filter({ hasText: bg.AddFacility.error_invalid_photo }),
    ).toBeVisible();
    await expectAddFormKept(page, name);
    expect(await query(`SELECT 1 FROM facilities WHERE name = $1`, [name])).toHaveLength(0);
  });

  test('a pin on a hidden paid place says so, and „пишете ни“ goes to /kontakt', async ({
    page,
  }, testInfo) => {
    await signIn(page, memberEmail(testInfo), /\/profil/);
    const { lon, lat } = freshPoint();
    await insertHiddenPaid(lon, lat);
    await page.goto(`/dobavi?lon=${lon}&lat=${lat}`);
    const name = `E2E B скрито ${Date.now()}`;
    await fillAddForm(page, name);
    await page.getByRole('button', { name: SUBMIT }).click();

    const [before = '', linked = ''] = bg.AddFacility.error_duplicate_hidden.split(/<\/?contact>/);
    const hidden = page.getByRole('alert').filter({ hasText: before.trim() });
    await expect(hidden).toBeVisible();
    await expect(hidden.getByRole('link', { name: linked, exact: true })).toHaveAttribute(
      'href',
      /\/kontakt$/,
    );
    await expectAddFormKept(page, name);
  });

  test('a paid place is saved and the member lands on /dobavi told why it is not on the map', async ({
    page,
  }, testInfo) => {
    await signIn(page, memberEmail(testInfo), /\/profil/);
    const { lon, lat } = freshPoint();
    await page.goto(`/dobavi?lon=${lon}&lat=${lat}`);
    const name = `E2E B платено ${Date.now()}`;
    await fillAddForm(page, name);
    await page.locator('select[name="access"]').selectOption('paid');
    await page.getByRole('button', { name: SUBMIT }).click();

    await page.waitForURL(/\/dobavi\?saved=hidden/);
    await expect(
      page.getByRole('status').filter({ hasText: bg.AddFacility.savedHiddenBody }),
    ).toBeVisible();
    const rows = await query<{ access: string }>(`SELECT access FROM facilities WHERE name = $1`, [
      name,
    ]);
    expect(rows.map((row) => row.access)).toEqual(['paid']);
  });

  test('with „Платено“ picked the footer drops the map sentence and keeps the ODbL one', async ({
    page,
  }, testInfo) => {
    await signIn(page, memberEmail(testInfo), /\/profil/);
    const { lon, lat } = freshPoint();
    await page.goto(`/dobavi?lon=${lon}&lat=${lat}`);
    await expect(page.getByText(bg.AddFacility.moderationNoteMap)).toBeVisible();

    await page.locator('select[name="access"]').selectOption('paid');
    await expect(page.getByText(bg.AddFacility.paidHiddenHint)).toBeVisible();
    await expect(page.getByText(bg.AddFacility.moderationNoteMap)).toHaveCount(0);
    await expect(page.getByText(bg.AddFacility.moderationNoteData)).toBeVisible();
  });
});
