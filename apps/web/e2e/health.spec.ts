import { expect, test } from '@playwright/test';

// Requires the dev database (compose.dev.yml) to be up, migrated and seeded —
// this is the Stage 0 DoD smoke: PostGIS ST_DWithin via /api/health.
test('/api/health reports ok with PostGIS available', async ({ request }) => {
  const response = await request.get('/api/health');

  expect(response.status()).toBe(200);
  const body = (await response.json()) as { status: string; postgis: string };
  expect(body.status).toBe('ok');
  expect(body.postgis).toMatch(/^\d/);
});
