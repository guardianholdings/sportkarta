import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { E2E_ACCESS_TOKEN, E2E_CODE, TIKTOK_E2E_ENV, TikTokMock } from './tiktok-mock';

/**
 * The /tiktok demo end to end, the way a TikTok app reviewer walks it: sign in
 * with TikTok, see which account is connected, fill the post form under
 * TikTok's content-sharing guidelines, post a video (Direct Post,
 * FILE_UPLOAD), watch its status, disconnect.
 *
 * TikTok's API is a loopback mock (e2e/tiktok-mock.ts, wired in
 * playwright.config.ts). The one hop that happens in the browser — TikTok's
 * own authorization page — is answered below as a user approving both scopes,
 * so the suite never reaches TikTok.
 */

const VIDEO = readFileSync(join(__dirname, 'fixtures/tiktok-demo.webm'));

const mock = new TikTokMock();

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  await mock.start();
});

test.afterAll(async () => {
  await mock.stop();
});

test.beforeEach(async ({ request }) => {
  mock.reset();
  const probe = await request.get('/tiktok', { maxRedirects: 0 });
  test.skip(
    !process.env.CI && probe.status() === 404,
    'The server under test runs without the TikTok e2e env from playwright.config.ts.',
  );
});

/**
 * Stands in for TikTok's authorization page: the user approves both scopes.
 * Playwright does not intercept the hops of a redirect chain, so the redirect
 * to TikTok is caught where it starts: our /auth/tiktok/start runs for real
 * (its state cookie included) and its Location — TikTok's page — is swapped
 * for TikTok's answer, a redirect back to our callback with a code.
 */
async function approveOnTikTok(page: Page): Promise<URL[]> {
  const seen: URL[] = [];
  await page.route('**/auth/tiktok/start', async (route) => {
    const response = await route.fetch({ maxRedirects: 0 });
    const authorize = new URL(response.headers().location ?? '', 'http://invalid');
    seen.push(authorize);
    // Back to the server under test whatever redirect_uri says (the test below
    // checks it), so a wrong site URL can never send the browser elsewhere.
    const back = new URL('/auth/tiktok/callback', route.request().url());
    back.searchParams.set('code', E2E_CODE);
    back.searchParams.set('scopes', 'user.info.basic,video.publish');
    back.searchParams.set('state', authorize.searchParams.get('state') ?? '');
    await route.fulfill({
      response,
      headers: { ...response.headers(), location: back.toString() },
    });
  });
  return seen;
}

async function connect(page: Page): Promise<URL[]> {
  const seen = await approveOnTikTok(page);
  await page.goto('/tiktok');
  await page.getByTestId('tiktok-connect').click();
  await expect(page.getByTestId('tiktok-connected-as')).toBeVisible();
  return seen;
}

/** Chooses the video, again until the form takes it: before hydration the input holds the file but the form never hears of it. */
async function chooseVideo(page: Page) {
  await expect(async () => {
    await page.getByTestId('tiktok-video-input').setInputFiles({
      name: 'demo.webm',
      mimeType: 'video/webm',
      buffer: VIDEO,
    });
    await expect(page.getByTestId('tiktok-preview')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

test('the page is noindex and sends a signed-out visitor no cookie', async ({ request }) => {
  const response = await request.get('/tiktok', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()['x-robots-tag']).toBe('noindex, nofollow');
  const cookies = response.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie');
  expect(cookies).toEqual([]);
});

test('connect with TikTok, post a video, follow its status, disconnect', async ({
  page,
  baseURL,
}) => {
  const seen = await approveOnTikTok(page);
  const toTikTok: string[] = [];
  page.on('request', (request) => {
    if (/(^|\.)tiktok(apis)?\.com$/.test(new URL(request.url()).hostname))
      toTikTok.push(request.url());
  });
  await page.goto('/tiktok');
  await expect(page.getByTestId('tiktok-legal-links')).toBeVisible();
  await page.getByTestId('tiktok-connect').click();
  await expect(page.getByTestId('tiktok-connected-as')).toBeVisible();

  // TikTok was asked for exactly the two scopes, with our callback and a state.
  expect(seen).toHaveLength(1);
  const [authorize] = seen;
  expect(`${authorize?.origin}${authorize?.pathname}`).toBe(
    'https://www.tiktok.com/v2/auth/authorize/',
  );
  expect(authorize?.searchParams.get('client_key')).toBe('e2e-client-key');
  expect(authorize?.searchParams.get('response_type')).toBe('code');
  expect(authorize?.searchParams.get('scope')).toBe('user.info.basic,video.publish');
  expect(authorize?.searchParams.get('redirect_uri')).toBe(`${baseURL}/auth/tiktok/callback`);
  expect(authorize?.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // user.info.basic and video.publish, each visibly used.
  await expect(page).toHaveURL(`${baseURL}/tiktok`);
  await expect(page.getByTestId('tiktok-connected-as')).toHaveText(
    'Connected to TikTok as POPS e2e',
  );
  await expect(page.getByTestId('tiktok-posting-to')).toHaveText(
    'Videos you post here go to POPS e2e (@pops_e2e)',
  );

  // The code was exchanged server-side; the browser holds only an opaque id.
  expect(mock.callsTo('/v2/oauth/token/')).toHaveLength(1);
  const cookies = (await page.context().cookies()).filter((c) => c.name.startsWith('pops_'));
  expect(cookies.map((c) => c.name)).toEqual(['pops_tiktok_session']);
  expect(cookies[0]?.httpOnly).toBe(true);
  const html = await page.content();
  for (const secret of [E2E_ACCESS_TOKEN, TIKTOK_E2E_ENV.TIKTOK_CLIENT_SECRET]) {
    expect(JSON.stringify(cookies)).not.toContain(secret);
    expect(html).not.toContain(secret);
  }

  // Nothing is chosen for the user: no privacy default, interactions off,
  // Stitch greyed out because the account's TikTok settings turn it off.
  const post = page.getByTestId('tiktok-post');
  const privacy = page.getByTestId('tiktok-privacy');
  await expect(post).toBeDisabled();
  await expect(privacy).toHaveValue('');
  expect(
    await privacy
      .locator('option')
      .evaluateAll((options) => options.map((o) => (o as HTMLOptionElement).value)),
  ).toEqual(['', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']);
  await expect(page.getByTestId('tiktok-allow-comment')).not.toBeChecked();
  await expect(page.getByTestId('tiktok-allow-duet')).not.toBeChecked();
  await expect(page.getByTestId('tiktok-allow-stitch')).toBeDisabled();
  await expect(page.getByTestId('tiktok-disclose')).not.toBeChecked();
  await expect(page.getByTestId('tiktok-declaration')).toHaveText(
    'By posting, you agree to TikTok’s Music Usage Confirmation.',
  );

  // The video, previewed, with its length.
  await chooseVideo(page);
  await expect(page.getByTestId('tiktok-preview')).toBeVisible();
  await expect(page.getByTestId('tiktok-duration')).toHaveText('Length: 2 s');
  await expect(post).toBeDisabled();
  await expect(page.getByTestId('tiktok-blocker')).toBeVisible();

  // Commercial content: a choice is required once disclosure is on, and
  // branded content can never be private.
  await page.getByTestId('tiktok-disclose').check();
  await expect(page.getByTestId('tiktok-label-prompt')).toHaveText(
    'You need to indicate if your content promotes yourself, a third party, or both.',
  );
  await page.getByTestId('tiktok-branded').check();
  await expect(page.getByTestId('tiktok-label-prompt')).toHaveText(
    'Your video will be labeled as “Paid partnership”.',
  );
  await expect(privacy.locator('option[value="SELF_ONLY"]')).toHaveJSProperty('disabled', true);
  await expect(page.getByTestId('tiktok-declaration')).toContainText('Branded Content Policy');
  await page.getByTestId('tiktok-disclose').uncheck();
  await expect(privacy.locator('option[value="SELF_ONLY"]')).toHaveJSProperty('disabled', false);

  await page.getByTestId('tiktok-caption').fill('e2e caption');
  await privacy.selectOption('SELF_ONLY');
  await page.getByTestId('tiktok-allow-comment').check();
  await expect(post).toBeEnabled();
  await post.click();

  await expect(page.getByTestId('tiktok-status')).toBeVisible();
  await expect(page.getByTestId('tiktok-status-text')).toHaveText(
    'Posted to your TikTok profile.',
    { timeout: 30_000 },
  );

  // What reached TikTok: the user's own choices, and the file as one chunk.
  const [init] = mock.callsTo('/v2/post/publish/video/init/');
  expect(JSON.parse(init?.body.toString('utf8') ?? '{}')).toEqual({
    post_info: {
      title: 'e2e caption',
      privacy_level: 'SELF_ONLY',
      disable_comment: false,
      disable_duet: true,
      disable_stitch: true,
      brand_content_toggle: false,
      brand_organic_toggle: false,
      is_aigc: false,
    },
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: VIDEO.byteLength,
      chunk_size: VIDEO.byteLength,
      total_chunk_count: 1,
    },
  });
  const [upload] = mock.callsTo('/upload/e2e');
  expect(upload?.method).toBe('PUT');
  expect(upload?.headers['content-type']).toBe('video/webm');
  expect(upload?.headers['content-range']).toBe(
    `bytes 0-${VIDEO.byteLength - 1}/${VIDEO.byteLength}`,
  );
  expect(upload?.body.equals(VIDEO)).toBe(true);

  // Disconnecting revokes the token at TikTok and forgets the session.
  await page.getByTestId('tiktok-disconnect').click();
  await expect(page.getByTestId('tiktok-signed-out')).toBeVisible();
  await expect(page.getByTestId('tiktok-connect')).toBeVisible();
  expect(mock.callsTo('/v2/oauth/revoke/')).toHaveLength(1);
  // (next dev adds a cookie of its own; only ours are counted.)
  const left = (await page.context().cookies()).filter((c) => c.name.startsWith('pops_'));
  expect(left).toEqual([]);
  // And not one request of the run went to TikTok itself.
  expect(toTikTok).toEqual([]);
});

test('TikTok’s private-account rule for an unaudited app is shown in plain words', async ({
  page,
}) => {
  await connect(page);
  mock.initError = 'unaudited_client_can_only_post_to_private_accounts';
  await chooseVideo(page);
  await page.getByTestId('tiktok-privacy').selectOption('FOLLOWER_OF_CREATOR');
  await page.getByTestId('tiktok-post').click();
  await expect(page.getByTestId('tiktok-error')).toHaveText(
    'TikTok only lets this app post to private accounts until its review is complete. Set the TikTok account to private and try again.',
  );
  expect(mock.callsTo('/upload/e2e')).toEqual([]);
  // The form stays as it was, ready to try again.
  await expect(page.getByTestId('tiktok-post')).toBeEnabled();
});
