import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';

import { signIn } from './auth';

// Repo-root .env (Playwright runs with cwd = apps/web).
config({ path: '../../.env' });

/** A distinct account per test: contributions are rate-limited per account. */
function contributorEmail(testInfo: { title: string }): string {
  const slug = testInfo.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  return `e2e-contrib-${slug}@example.org`;
}

function dbClient(): pg.Client {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the contributions e2e suite');
  return new pg.Client({ connectionString: url });
}

async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = dbClient();
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

/** A real 1×1 JPEG, so the photo pipeline (sharp) has something valid to chew. */
const PIXEL_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

test.describe('authenticated contributions', () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright passes testInfo second
  test.beforeEach(async ({}, testInfo) => {
    await query(`DELETE FROM users WHERE email = $1`, [contributorEmail(testInfo)]);
  });

  test('anonymous visitors are offered sign-in, not the forms', async ({ page }) => {
    const facility = (
      await query<{ slug: string }>(
        `SELECT slug FROM facilities WHERE slug IS NOT NULL ORDER BY created_at LIMIT 1`,
      )
    )[0];
    await page.goto(`/obekt/${facility?.slug ?? ''}`);

    await expect(page.getByRole('button', { name: /потвърди|confirm/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /влезте|sign in/i })).toBeVisible();

    // Adding a facility is gated before anything renders: the middleware sends
    // an anonymous visitor to sign in and carries the destination along.
    await page.goto('/dobavi');
    await expect(page).toHaveURL(/\/vhod/);

    // A hand-rolled POST cannot smuggle a contribution past the missing UI
    // either. (This posts a plain form, which Next does not dispatch as a
    // server action — the real `requireUser` boundary is asserted directly in
    // apps/web/tests/contribution-authz.test.ts.)
    const before = await query(`SELECT count(*)::int AS n FROM facility_condition_reports`);
    await page.request.post(`/obekt/${facility?.slug ?? ''}`, {
      form: { slug: facility?.slug ?? '', state: 'poor' },
    });
    const after = await query(`SELECT count(*)::int AS n FROM facility_condition_reports`);
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  test('adding a facility lands as needs_verification with a photo and an award', async ({
    page,
  }, testInfo) => {
    const email = contributorEmail(testInfo);
    await signIn(page, email, /\/profil/);

    // A unique name per run: a facility added here can never be cleaned up
    // afterwards, because facility_edits is append-only and references it
    // ON DELETE RESTRICT. CI databases are ephemeral; a dev one accumulates.
    const stamp = Date.now();
    const facilityName = `E2E тестово игрище ${stamp}`;
    // A fresh point per run, well away from the seeded Sofia facilities: the
    // duplicate guard would otherwise (correctly) reject a repeat run against
    // the facility the previous one created.
    const lon = (23.4 + (stamp % 5000) / 100000).toFixed(5);
    const lat = (42.6 + (Math.floor(stamp / 5000) % 5000) / 100000).toFixed(5);
    await page.goto(`/dobavi?lon=${lon}&lat=${lat}`);
    await page.locator('input[name="photo"]').setInputFiles({
      name: 'pitch.jpg',
      mimeType: 'image/jpeg',
      buffer: PIXEL_JPEG,
    });
    // Sports are selectable toggle chips (role=button, aria-pressed), not native checkboxes.
    await page.getByRole('button', { name: /баскетбол|basketball/i }).click();
    await page.getByLabel(/име|name/i).fill(facilityName);
    await page.getByRole('button', { name: /добави съоръжението|add facility/i }).click();

    // Redirected to the new facility page.
    await page.waitForURL(/\/obekt\/[a-z0-9-]+\?added=1/);

    const rows = await query<{ status: string; source: string; id: string }>(
      `SELECT id, status, source FROM facilities WHERE name = $1`,
      [facilityName],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('needs_verification');
    expect(rows[0]?.source).toBe('crowd');

    const facilityId = rows[0]?.id as string;
    // Photo attached and awaiting moderation.
    const photos = await query(`SELECT 1 FROM facility_photos WHERE facility_id = $1::uuid`, [
      facilityId,
    ]);
    expect(photos.length).toBe(1);
    // Audit row attributed to the account, and exactly one award.
    const edits = await query<{ field: string }>(
      `SELECT field FROM facility_edits WHERE facility_id = $1::uuid`,
      [facilityId],
    );
    expect(edits.map((e) => e.field)).toContain('created');
    const awards = await query<{ points: number }>(
      `SELECT points FROM points_ledger WHERE facility_id = $1::uuid`,
      [facilityId],
    );
    expect(awards).toHaveLength(1);
    expect(awards[0]?.points).toBe(10);

    // The facility cannot be deleted (facility_edits references it and is
    // append-only), so at least take it out of the moderation queue: leaving it
    // there would change what the admin verify deck shows other suites.
    await query(`UPDATE facilities SET status = 'active' WHERE id = $1::uuid`, [facilityId]);
  });

  test('a pin outside Bulgaria is refused', async ({ page }, testInfo) => {
    await signIn(page, contributorEmail(testInfo), /\/profil/);
    // Belgrade — a plausible-looking pin that is not in Bulgaria.
    await page.goto('/dobavi?lon=20.45&lat=44.79');
    await page.locator('input[name="photo"]').setInputFiles({
      name: 'pitch.jpg',
      mimeType: 'image/jpeg',
      buffer: PIXEL_JPEG,
    });
    // Sports are selectable toggle chips (role=button, aria-pressed), not native checkboxes.
    await page.getByRole('button', { name: /баскетбол|basketball/i }).click();
    await page.getByRole('button', { name: /добави съоръжението|add facility/i }).click();

    // Scope past Next's route announcer, which is also role=alert.
    await expect(page.getByRole('alert').filter({ hasText: /България|Bulgaria/i })).toBeVisible();
  });

  test('verifying activates the facility and records the audit trail', async ({
    page,
  }, testInfo) => {
    const email = contributorEmail(testInfo);
    await signIn(page, email, /\/profil/);

    // A facility awaiting verification, added by somebody else.
    const facility = (
      await query<{ slug: string; id: string }>(
        `INSERT INTO facilities (geom, name, sport_types, access, status, source, slug)
         VALUES (ST_SetSRID(ST_MakePoint(23.3401, 42.6901), 4326), 'E2E за потвърждение',
                 '{basketball}', 'free', 'needs_verification', 'crowd', $1)
         RETURNING id, slug`,
        [`e2e-verify-${Date.now()}`],
      )
    )[0];

    await page.goto(`/obekt/${facility?.slug ?? ''}`);
    await page.getByRole('button', { name: /^(потвърди|confirm)$/i }).click();
    await expect(page.getByRole('status')).toBeVisible();

    const rows = await query<{ status: string }>(`SELECT status FROM facilities WHERE id = $1`, [
      facility?.id,
    ]);
    expect(rows[0]?.status).toBe('active');

    const userId = (
      await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email])
    )[0]?.id;
    const edits = await query<{ field: string; actor: string }>(
      `SELECT field, actor FROM facility_edits WHERE facility_id = $1 AND actor = $2`,
      [facility?.id, userId],
    );
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((e) => e.actor === userId)).toBe(true);
  });

  test('a condition report updates the facility and pays only once a day', async ({
    page,
  }, testInfo) => {
    const email = contributorEmail(testInfo);
    await signIn(page, email, /\/profil/);

    const facility = (
      await query<{ slug: string; id: string }>(
        `INSERT INTO facilities (geom, name, sport_types, access, status, source, slug)
         VALUES (ST_SetSRID(ST_MakePoint(23.3501, 42.7001), 4326), 'E2E за състояние',
                 '{football}', 'free', 'active', 'crowd', $1)
         RETURNING id, slug`,
        [`e2e-condition-${Date.now()}`],
      )
    )[0];

    await page.goto(`/obekt/${facility?.slug ?? ''}`);
    // State/tag controls are label-wrapped sr-only inputs with a styled proxy
    // span, so the real user clicks the label — `force` checks the hidden input
    // directly instead of the span that intercepts the pointer.
    await page.getByRole('radio', { name: /^(лошо|poor)$/i }).check({ force: true });
    await page.getByRole('checkbox', { name: /замърсено|litter/i }).check({ force: true });
    await page.getByRole('button', { name: /^(изпрати|send)$/i }).click();
    await expect(page.getByRole('status')).toBeVisible();

    const rows = await query<{ condition: string; condition_reported_at: string }>(
      `SELECT condition, condition_reported_at FROM facilities WHERE id = $1`,
      [facility?.id],
    );
    expect(rows[0]?.condition).toBe('poor');
    expect(rows[0]?.condition_reported_at).not.toBeNull();

    const reports = await query<{ tags: string[] }>(
      `SELECT tags FROM facility_condition_reports WHERE facility_id = $1`,
      [facility?.id],
    );
    expect(reports[0]?.tags).toEqual(['litter']);

    // Report again the same day: recorded again, but paid only once.
    await page.reload();
    await page.getByRole('radio', { name: /^(добро|good)$/i }).check({ force: true });
    await page.getByRole('button', { name: /^(изпрати|send)$/i }).click();
    await expect(page.getByRole('status')).toBeVisible();

    const allReports = await query(
      `SELECT 1 FROM facility_condition_reports WHERE facility_id = $1`,
      [facility?.id],
    );
    expect(allReports.length).toBe(2);
    const awards = await query(`SELECT 1 FROM points_ledger WHERE facility_id = $1`, [
      facility?.id,
    ]);
    expect(awards.length).toBe(1);
  });

  test('points show up on the profile', async ({ page }, testInfo) => {
    const email = contributorEmail(testInfo);
    await signIn(page, email, /\/profil/);

    const facility = (
      await query<{ slug: string }>(
        `INSERT INTO facilities (geom, name, sport_types, access, status, source, slug)
         VALUES (ST_SetSRID(ST_MakePoint(23.3601, 42.7101), 4326), 'E2E за точки',
                 '{tennis}', 'free', 'needs_verification', 'crowd', $1)
         RETURNING slug`,
        [`e2e-points-${Date.now()}`],
      )
    )[0];

    await page.goto(`/obekt/${facility?.slug ?? ''}`);
    await page.getByRole('button', { name: /^(потвърди|confirm)$/i }).click();
    await expect(page.getByRole('status')).toBeVisible();

    await page.goto('/profil');
    // 3 points for a verification (lib/src/points.ts).
    await expect(page.getByText(/^3 (точки|points)$/)).toBeVisible();
  });
});

/** Guard against the fixture JPEG silently rotting. */
test('the e2e photo fixture is a real image', () => {
  expect(PIXEL_JPEG.subarray(0, 2).toString('hex')).toBe('ffd8');
  expect(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).toContain(
    '@sportkarta/web',
  );
});
