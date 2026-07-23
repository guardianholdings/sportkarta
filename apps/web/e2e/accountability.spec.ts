import { expect, test } from '@playwright/test';

import bg from '../messages/bg.json';

/**
 * Stage 3.4 — the parts of the municipality widget that only a real HTTP
 * response can prove.
 *
 * The unit tests cover the rendered document (no script, no external request,
 * attribution present, aggregates only). What they cannot see is the
 * ENVELOPE: the framing policy, and the promise that embedding us sets no
 * cookie on a municipality's visitors. Those live in next.config.ts and in the
 * route handler's headers, and both are exactly the kind of thing a later
 * refactor breaks silently.
 */

// Sofia is in the seed and in every real import; the dev DB always has it.
const CITY = 'sofia';

test.describe('municipality accountability', () => {
  test('the page reports the municipality and refuses to be framed', async ({ page }) => {
    const response = await page.goto(`/obshtina/${CITY}`);
    expect(response?.status()).toBe(200);

    // Clickjacking protection on our own pages is not incidental: the widget
    // made framing a supported thing, and this asserts it stayed scoped to the
    // widget alone.
    const headers = response?.headers() ?? {};
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");

    // The h1 is "<heading>: <municipality>" — assert the fixed part from the
    // catalogue rather than hardcoding Bulgarian copy into the test.
    const headingPrefix = bg.Accountability.h1.split('{')[0]?.trim() ?? '';
    await expect(page.getByRole('heading', { level: 1 })).toContainText(headingPrefix);
    // The methodology is part of the deliverable, not decoration — a figure a
    // municipality cannot reproduce is a figure it will dispute.
    await expect(
      page.getByRole('heading', { name: bg.Accountability.methodologyHeading }),
    ).toBeVisible();
    await expect(page.getByText(bg.Accountability.attribution)).toBeVisible();
  });

  test('the widget is framable, cookieless and script-free', async ({ request }) => {
    const response = await request.get(`/api/widget/obshtina/${CITY}?lang=bg`);
    expect(response.status()).toBe(200);

    const headers = response.headers();
    expect(headers['content-type']).toContain('text/html');
    expect(headers['content-security-policy']).toContain('frame-ancestors *');
    expect(headers['content-security-policy']).toContain("script-src 'none'");
    // The global deny must NOT have leaked onto the one route that needs to be
    // embedded — if it did, every municipal site embedding us shows a blank box.
    expect(headers['x-frame-options']).toBeUndefined();
    // Embedding us must not make a municipality's visitors our data subjects.
    expect(headers['set-cookie']).toBeUndefined();

    const html = await response.text();
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(bg.Accountability.attribution);
  });

  test('the JSON representation is open data and carries no personal field', async ({
    request,
  }) => {
    const response = await request.get(`/api/widget/obshtina/${CITY}?format=json`);
    expect(response.status()).toBe(200);
    expect(response.headers()['access-control-allow-origin']).toBe('*');

    const payload = (await response.json()) as Record<string, unknown>;
    const identifying = new Set([
      'nameBg',
      'nameEn',
      'slug',
      'ekatteCode',
      'generatedAt',
      'license',
    ]);
    // Same rule as the unit test, asserted against what actually goes over the
    // wire from a live database rather than a fixture.
    const offenders = Object.entries(payload)
      .filter(([key]) => !identifying.has(key))
      .filter(([, value]) => value !== null && typeof value !== 'number')
      .map(([key]) => key);
    expect(offenders).toEqual([]);
  });

  test('an unknown municipality 404s rather than rendering an empty widget', async ({
    request,
  }) => {
    const response = await request.get('/api/widget/obshtina/not-a-municipality');
    expect(response.status()).toBe(404);
  });
});
