import { expect, test } from '@playwright/test';

import bg from '../messages/bg.json';

/**
 * Stage 6.1 — the parts of the open-data portal that only a real HTTP response
 * can prove.
 *
 * The unit tests cover the catalogue, the serializers, the compiled SQL and the
 * key format. What they cannot see is the ENVELOPE, and on this surface the
 * envelope is most of the security design: that the API answers a stranger with
 * no key at all, that it sets no cookie, that it is CORS-open WITHOUT being
 * credentialed, that every response carries the licence, and that a session
 * cookie buys nothing. Each of those is a header, and headers are exactly what
 * a later refactor breaks in silence.
 */

const API = '/api/opendata/v1';

test.describe('open-data API', () => {
  test('answers an anonymous stranger, with the licence attached', async ({ request }) => {
    const response = await request.get(`${API}/facilities?limit=5`);
    expect(response.status()).toBe(200);

    const headers = response.headers();
    // The point of the whole stage: no key, no account, no negotiation.
    expect(headers['content-type']).toContain('application/geo+json');
    expect(headers['x-license']).toBe('ODbL-1.0');
    // ASCII: an HTTP header value is latin-1, so the © form would arrive as
    // "Â©". The body below carries the authoritative string.
    expect(headers['x-attribution']).toBe('(c) OpenStreetMap contributors + SportKarta community');
    expect(headers['link']).toContain('rel="license"');

    // CORS-open, and deliberately NOT credentialed: a wildcard origin plus
    // credentials would let any page on the internet read this as whoever is
    // signed in here.
    expect(headers['access-control-allow-origin']).toBe('*');
    expect(headers['access-control-allow-credentials']).toBeUndefined();

    // No cookie, ever. A data API that sets one turns every consumer's server
    // into something that has to manage our session state.
    expect(headers['set-cookie']).toBeUndefined();

    // The budget is advertised before it is spent, not only when refused.
    expect(headers['ratelimit-limit']).toBeTruthy();
    expect(headers['ratelimit-remaining']).toBeTruthy();

    const body = (await response.json()) as {
      type: string;
      license: string;
      attribution: string;
      features: { properties: Record<string, unknown> }[];
    };
    expect(body.type).toBe('FeatureCollection');
    expect(body.license).toBe('ODbL-1.0');
    expect(body.attribution).toBe('© OpenStreetMap contributors + SportKarta community');

    // The declared catalogue and nothing else. A feature carrying an `email`
    // or an `uploaded_by` is the failure this whole stage exists to prevent,
    // and here it is checked on real rows from the real database.
    for (const feature of body.features) {
      for (const forbidden of ['email', 'user_id', 'uploaded_by', 'actor', 'attrs']) {
        expect(Object.keys(feature.properties)).not.toContain(forbidden);
      }
    }
  });

  test('serves CSV that Excel can open, with no licence line to break the parse', async ({
    request,
  }) => {
    const response = await request.get(`${API}/stats-sports?format=csv`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/csv');
    expect(response.headers()['content-disposition']).toContain('attachment');

    const text = await response.text();
    // BOM first — without it a Cyrillic export is mojibake in Excel.
    expect(text.charCodeAt(0)).toBe(0xfeff);
    // The header row is the FIRST row: the attribution travels in the Link
    // header precisely so it does not corrupt the file.
    expect(text.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe('sport,total');
    expect(response.headers()['x-attribution']).toContain('OpenStreetMap');
  });

  test('an unknown dataset is a 404, an unsupported format a 400', async ({ request }) => {
    const missing = await request.get(`${API}/pochivki`);
    expect(missing.status()).toBe(404);

    // facilities is not published as tabular JSON — it is a geometry dataset.
    const wrongFormat = await request.get(`${API}/facilities?format=json`);
    expect(wrongFormat.status()).toBe(400);
    // Even the errors carry the licence and the documentation pointer.
    expect(wrongFormat.headers()['x-license']).toBe('ODbL-1.0');
  });

  test('a garbage key costs the higher limit, not access', async ({ request }) => {
    // A revoked or mistyped key must never mean "no data": the caller is
    // entitled to this without any key at all.
    const response = await request.get(`${API}/stats-national?format=json`, {
      headers: { Authorization: 'Bearer skbg_not-a-real-key' },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()['ratelimit-limit']).toBeTruthy();
  });

  test('preflight succeeds without credentials', async ({ request }) => {
    const response = await request.fetch(`${API}/facilities`, { method: 'OPTIONS' });
    expect(response.status()).toBe(204);
    expect(response.headers()['access-control-allow-origin']).toBe('*');
  });

  test('the dump manifest is served and is not rate limited', async ({ request }) => {
    const response = await request.get(`${API}/dumps`);
    expect(response.status()).toBe(200);
    // UNMETERED: the exit route from the rate limit must not itself be metered.
    expect(response.headers()['ratelimit-limit']).toBeUndefined();

    const body = (await response.json()) as { license: string; versions: string[] };
    expect(body.license).toBe('ODbL-1.0');
    expect(Array.isArray(body.versions)).toBe(true);
  });

  test('a dump that was never published is a flat 404', async ({ request }) => {
    // The row decides, not the path — an unpublished version has no row.
    const response = await request.get(`${API}/dumps/1999-01-01/facilities.csv`);
    expect(response.status()).toBe(404);
  });

  test('the version directory serves the licence text', async ({ request }) => {
    const response = await request.get(`${API}/dumps/2026-07-23/LICENSE.txt`);
    expect(response.status()).toBe(200);
    const text = await response.text();
    expect(text).toContain('© OpenStreetMap contributors + SportKarta community');
    expect(text).toContain('ODbL-1.0');
  });
});

test.describe('open-data portal pages', () => {
  test('the portal documents the datasets and links the licence', async ({ page }) => {
    const response = await page.goto('/danni');
    expect(response?.status()).toBe(200);

    await expect(page.getByRole('heading', { level: 1 })).toContainText(bg.OpenData.title);
    // The dataset headings render FROM the catalogue — if the catalogue and the
    // message keys drift apart, this is where it shows.
    await expect(
      page.getByRole('heading', { name: bg.OpenData.datasets.facilities.title }),
    ).toBeVisible();
    // A documented field, proving the table rendered rather than collapsed.
    await expect(page.getByText('municipality_ekatte').first()).toBeVisible();
    await expect(page.getByRole('link', { name: bg.OpenData.licenseLink })).toBeVisible();
  });

  test('the licence page states the exact attribution string', async ({ page }) => {
    const response = await page.goto('/danni/litsenz');
    expect(response?.status()).toBe(200);
    await expect(
      page.getByText('© OpenStreetMap contributors + SportKarta community'),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: bg.OpenData.licenseShareAlikeTitle }),
    ).toBeVisible();
    // Photographs are outside the licence AND outside the exports — the one
    // question a reuser is most likely to get wrong.
    await expect(page.getByText(bg.OpenData.licensePhotosBody)).toBeVisible();
  });

  test('the keys page requires signing in', async ({ page }) => {
    await page.goto('/danni/klyuchove');
    // requireUser() redirects; a credentials page must never render to a
    // signed-out visitor.
    await expect(page).toHaveURL(/\/vhod/);
  });
});
