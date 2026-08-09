import { expect, test } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';

import { ADMIN_EMAIL, signIn } from './auth';

// Repo-root .env (Playwright runs with cwd = apps/web).
config({ path: '../../.env' });

const AMBASSADOR_EMAIL = 'e2e-ambassador@example.org';

function dbClient(): pg.Client {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the ambassadors e2e suite');
  return new pg.Client({ connectionString: url });
}

/**
 * A hidden admin path must answer EXACTLY like a nonexistent one — same
 * status, same not-found body. The literal-404 assertion this replaces became
 * unrepresentable when the root loading boundary landed: Next streams the 200
 * shell first, so notFound() cannot change the status line — uniformly for
 * hidden and missing paths, which is the property that matters.
 */
async function expectHiddenLikeMissing(
  page: import('@playwright/test').Page,
  path: string,
): Promise<void> {
  const reference = await page.request.get(`/admin/nyama-takava-stranitsa-${String(Date.now())}`);
  expect(
    await reference.text(),
    'the reference missing path must render the not-found UI',
  ).toContain('This page could not be found');
  const response = await page.request.get(path);
  expect(response.status(), path).toBe(reference.status());
  expect(await response.text(), path).toContain('This page could not be found');
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

/** Two municipalities that actually contain a facility, for scope fixtures. */
async function twoMunicipalities(): Promise<{ mine: number; theirs: number }> {
  const rows = await query<{ municipality_id: number }>(
    `SELECT DISTINCT ON (municipality_id) municipality_id FROM facilities
      WHERE municipality_id IS NOT NULL ORDER BY municipality_id, id LIMIT 2`,
  );
  return { mine: rows[0]?.municipality_id as number, theirs: rows[1]?.municipality_id as number };
}

test.describe('ambassadors', () => {
  test.beforeEach(async () => {
    await query(`DELETE FROM users WHERE email = $1`, [AMBASSADOR_EMAIL]);
  });

  test('an admin grants the role and a municipality, and sees the activity', async ({ page }) => {
    // Sign-in plus three server actions; the default 30s is tight once the
    // whole suite is warming the same dev server.
    test.setTimeout(60_000);
    // The member must exist first — granting is not an invitation flow. The
    // account is seeded directly rather than signed into: this test is about
    // what the ADMIN can do, and a second interactive sign-in would only add a
    // sign-out race to it.
    await query(
      `INSERT INTO users (id, display_name, email, email_verified)
       VALUES ($1, 'E2E амбасадор', $2, true)`,
      [`e2e_amb_${Date.now()}`, AMBASSADOR_EMAIL],
    );

    await signIn(page, ADMIN_EMAIL, /\/profil/);
    await page.goto('/admin/ambasadori');

    await page.getByLabel(/имейл на потребител|member email/i).fill(AMBASSADOR_EMAIL);
    await page.getByRole('button', { name: /направи амбасадор|make ambassador/i }).click();
    await expect(page.getByRole('status')).toBeVisible();

    const roles = await query<{ role: string }>(`SELECT role FROM users WHERE email = $1`, [
      AMBASSADOR_EMAIL,
    ]);
    expect(roles[0]?.role).toBe('ambassador');

    // Other ambassadors from earlier suites share this page, so everything is
    // scoped to this account's own row.
    const row = page.getByRole('listitem').filter({ hasText: AMBASSADOR_EMAIL });
    // A freshly granted ambassador has no municipalities: visible warning, and
    // no power at all until scope is added.
    await expect(row.getByText(/без общини|no municipalities/i)).toBeVisible();

    await row.getByRole('button', { name: /добави община|add municipality/i }).click();
    // The grant is a server action; poll rather than racing its commit.
    await expect
      .poll(async () => {
        const scope = await query(
          `SELECT 1 FROM ambassador_municipalities am JOIN users u ON u.id = am.user_id
            WHERE u.email = $1`,
          [AMBASSADOR_EMAIL],
        );
        return scope.length;
      })
      .toBe(1);
  });

  test('an ambassador sees only their own municipalities in the queue', async ({ page }) => {
    await signIn(page, AMBASSADOR_EMAIL, /\/profil/);
    const { mine, theirs } = await twoMunicipalities();

    await query(`UPDATE users SET role = 'ambassador' WHERE email = $1`, [AMBASSADOR_EMAIL]);
    await query(
      `INSERT INTO ambassador_municipalities (user_id, municipality_id)
       SELECT id, $2 FROM users WHERE email = $1`,
      [AMBASSADOR_EMAIL, mine],
    );

    // A pending photo in each municipality.
    const facilities = await query<{ id: string; municipality_id: number }>(
      `SELECT DISTINCT ON (municipality_id) id, municipality_id FROM facilities
        WHERE municipality_id = ANY($1::int[]) ORDER BY municipality_id, id`,
      [[mine, theirs]],
    );
    const inScope = facilities.find((f) => f.municipality_id === mine)?.id as string;
    const outOfScope = facilities.find((f) => f.municipality_id === theirs)?.id as string;
    const stamp = Date.now();
    await query(
      `INSERT INTO facility_photos (facility_id, storage_path, status)
       VALUES ($1::uuid, $2, 'pending'), ($3::uuid, $4, 'pending')`,
      [
        inScope,
        `photos/e2e-scope-in-${stamp}.webp`,
        outOfScope,
        `photos/e2e-scope-out-${stamp}.webp`,
      ],
    );

    try {
      await page.goto('/admin/moderation');
      await expect(page.getByText(`photos/e2e-scope-in-${stamp}.webp`)).toBeVisible();
      await expect(page.getByText(`photos/e2e-scope-out-${stamp}.webp`)).toHaveCount(0);

      // Approving in scope works and is logged.
      await page
        .getByRole('listitem')
        .filter({ hasText: `photos/e2e-scope-in-${stamp}.webp` })
        .getByRole('button', { name: /одобри|approve/i })
        .click();

      await expect
        .poll(async () => {
          const rows = await query<{ status: string }>(
            `SELECT status FROM facility_photos WHERE storage_path = $1`,
            [`photos/e2e-scope-in-${stamp}.webp`],
          );
          return rows[0]?.status;
        })
        .toBe('approved');

      const decisions = await query<{ decision: string }>(
        `SELECT d.decision FROM moderation_decisions d
           JOIN users u ON u.id = d.actor_id
          WHERE u.email = $1 AND d.target_type = 'photo'`,
        [AMBASSADOR_EMAIL],
      );
      expect(decisions.map((d) => d.decision)).toContain('approved');

      // The out-of-scope photo is untouched.
      const untouched = await query<{ status: string }>(
        `SELECT status FROM facility_photos WHERE storage_path = $1`,
        [`photos/e2e-scope-out-${stamp}.webp`],
      );
      expect(untouched[0]?.status).toBe('pending');
    } finally {
      await query(`DELETE FROM facility_photos WHERE storage_path LIKE $1`, [
        `photos/e2e-scope-%-${stamp}.webp`,
      ]);
    }
  });

  test('an ambassador cannot edit a facility outside their municipalities', async ({ page }) => {
    await signIn(page, AMBASSADOR_EMAIL, /\/profil/);
    const { mine, theirs } = await twoMunicipalities();
    await query(`UPDATE users SET role = 'ambassador' WHERE email = $1`, [AMBASSADOR_EMAIL]);
    await query(
      `INSERT INTO ambassador_municipalities (user_id, municipality_id)
       SELECT id, $2 FROM users WHERE email = $1`,
      [AMBASSADOR_EMAIL, mine],
    );

    const outOfScope = (
      await query<{ id: string; name: string | null; status: string }>(
        `SELECT id, name, status FROM facilities WHERE municipality_id = $1 ORDER BY id LIMIT 1`,
        [theirs],
      )
    )[0];
    const inScope = (
      await query<{ id: string }>(
        `SELECT id FROM facilities WHERE municipality_id = $1 ORDER BY id LIMIT 1`,
        [mine],
      )
    )[0];

    // The editor can set status and rewrite every field, and it does not go
    // through the logged moderation path — so it must refuse out of scope.
    expect((await page.request.get(`/admin/facilities/${inScope?.id ?? ''}`)).status()).toBe(200);
    await expectHiddenLikeMissing(page, `/admin/facilities/${outOfScope?.id ?? ''}`);

    // And the list must not advertise what it cannot open.
    await page.goto('/admin/facilities');
    await expect(page.getByText(outOfScope?.name ?? '—', { exact: true })).toHaveCount(0);

    // The facility is untouched.
    const after = await query<{ status: string }>(`SELECT status FROM facilities WHERE id = $1`, [
      outOfScope?.id,
    ]);
    expect(after[0]?.status).toBe(outOfScope?.status);
  });

  test('an ambassador cannot reach the granting screen', async ({ page }, testInfo) => {
    await signIn(page, AMBASSADOR_EMAIL, /\/profil/);
    await query(`UPDATE users SET role = 'ambassador' WHERE email = $1`, [AMBASSADOR_EMAIL]);

    // Moderation yes, granting no — an ambassador widening their own scope
    // would make the municipality boundary decorative.
    expect((await page.request.get('/admin/moderation')).status(), testInfo.title).toBe(200);
    await expectHiddenLikeMissing(page, '/admin/ambasadori');
    await page.goto('/admin');
    await expect(page.getByRole('link', { name: /амбасадори|ambassadors/i })).toHaveCount(0);
  });
});
