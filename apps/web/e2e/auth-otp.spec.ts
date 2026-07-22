import { expect, test } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';

import { ADMIN_EMAIL, clearOutbox, signIn } from './auth';

// Repo-root .env (Playwright runs with cwd = apps/web).
config({ path: '../../.env' });

// A distinct address per test: sign-in is rate-limited per email, and reusing
// one address across the suite would make the tests throttle each other.
function memberEmail(testInfo: { title: string }): string {
  const slug = testInfo.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  return `e2e-${slug}@example.org`;
}

function dbClient(): pg.Client {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the auth e2e suite');
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

test.describe('email OTP sign-in', () => {
  // eslint-disable-next-line no-empty-pattern -- Playwright passes testInfo second
  test.beforeEach(async ({}, testInfo) => {
    await clearOutbox();
    await query(`DELETE FROM users WHERE email = $1`, [memberEmail(testInfo)]);
  });

  test('a member signs in with a mailed code and lands on their profile', async ({
    page,
  }, testInfo) => {
    const MEMBER_EMAIL = memberEmail(testInfo);
    await signIn(page, MEMBER_EMAIL, /\/profil/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    const users = await query<{ role: string; is_minor: boolean }>(
      `SELECT role, is_minor FROM users WHERE email = $1`,
      [MEMBER_EMAIL],
    );
    // New accounts are plain members and adults-by-default until a DOB is given.
    expect(users).toHaveLength(1);
    expect(users[0]?.role).toBe('user');
    expect(users[0]?.is_minor).toBe(false);
  });

  test('no session IP is ever written', async ({ page }, testInfo) => {
    const MEMBER_EMAIL = memberEmail(testInfo);
    await signIn(page, MEMBER_EMAIL, /\/profil/);
    const sessions = await query<{ ip_address: string | null }>(
      `SELECT s.ip_address FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1`,
      [MEMBER_EMAIL],
    );
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.ip_address ?? '').toBe('');
    }
  });

  test('Google sign-in is not offered while the flag is off', async ({ page }) => {
    await page.goto('/vhod');
    await expect(page.getByRole('button', { name: /google/i })).toHaveCount(0);
  });

  test('a date of birth sets the age category without being stored', async ({ page }, testInfo) => {
    const MEMBER_EMAIL = memberEmail(testInfo);
    await signIn(page, MEMBER_EMAIL, /\/profil/);

    await page.getByLabel(/име за показване|display name/i).fill('E2E тест');
    await page.getByLabel(/дата на раждане|date of birth/i).fill('2015-06-01');
    await page.getByRole('button', { name: /запази|save/i }).click();
    await expect(page.getByRole('status')).toBeVisible();

    const users = await query<{ is_minor: boolean; display_name: string }>(
      `SELECT is_minor, display_name FROM users WHERE email = $1`,
      [MEMBER_EMAIL],
    );
    expect(users[0]?.is_minor).toBe(true);
    expect(users[0]?.display_name).toBe('E2E тест');

    // Nothing anywhere in the database holds the date itself.
    const columns = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name ~* '(dob|birth)'`,
    );
    expect(columns).toEqual([]);
  });

  test('signing out ends the session', async ({ page }, testInfo) => {
    await signIn(page, memberEmail(testInfo), /\/profil/);
    await page.getByRole('button', { name: /изход|sign out/i }).click();
    await page.waitForURL(/localhost:3000\/?$/);

    await page.goto('/profil');
    await expect(page).toHaveURL(/\/vhod/);
  });
});

test.describe('admin bootstrap', () => {
  test('an ADMIN_EMAILS address is promoted on sign-in', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, /\/profil/);
    const users = await query<{ role: string }>(`SELECT role FROM users WHERE email = $1`, [
      ADMIN_EMAIL,
    ]);
    expect(users[0]?.role).toBe('admin');
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin$/);
  });
});

test.describe('role boundaries', () => {
  /** Force a role the way an in-app grant would, then reload as that person. */
  async function setRole(email: string, role: string): Promise<void> {
    await query(`UPDATE users SET role = $2 WHERE email = $1`, [email, role]);
  }

  test('a signed-in member cannot reach the admin panel at all', async ({ page }, testInfo) => {
    const email = memberEmail(testInfo);
    await query(`DELETE FROM users WHERE email = $1`, [email]);
    await signIn(page, email, /\/profil/);
    await setRole(email, 'user');

    // Status is read over HTTP rather than from page.goto: the PWA service
    // worker handles navigations, so goto() reports no network response.
    // page.request shares the browser context's cookies, so this is the same
    // signed-in identity.
    for (const path of ['/admin', '/admin/facilities', '/admin/verify', '/admin/import']) {
      const response = await page.request.get(path);
      // 404, not a redirect to sign-in: an unprivileged member should not learn
      // which admin routes exist.
      expect(response.status(), path).toBe(404);
    }
  });

  test('an ambassador is still not an admin', async ({ page }, testInfo) => {
    const email = memberEmail(testInfo);
    await query(`DELETE FROM users WHERE email = $1`, [email]);
    await signIn(page, email, /\/profil/);
    await setRole(email, 'ambassador');

    expect((await page.request.get('/admin')).status()).toBe(404);
  });

  test('a moderator gets the review tools but not imports', async ({ page }, testInfo) => {
    const email = memberEmail(testInfo);
    await query(`DELETE FROM users WHERE email = $1`, [email]);
    await signIn(page, email, /\/profil/);
    await setRole(email, 'moderator');

    expect((await page.request.get('/admin')).status()).toBe(200);
    expect((await page.request.get('/admin/moderation')).status()).toBe(200);
    // Imports rewrite national data — admin only, page as well as action.
    expect((await page.request.get('/admin/import')).status()).toBe(404);
    // And the link is not dangled in front of them.
    await page.goto('/admin');
    await expect(page.getByRole('link', { name: /импорт|import/i })).toHaveCount(0);
  });
});

test.describe('GDPR self-service deletion', () => {
  test('erases the profile, anonymises contributions and keeps the audit log', async ({
    page,
  }, testInfo) => {
    const MEMBER_EMAIL = memberEmail(testInfo);
    await query(`DELETE FROM users WHERE email = $1`, [MEMBER_EMAIL]);
    await clearOutbox();
    await signIn(page, MEMBER_EMAIL, /\/profil/);
    const userId = (
      await query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [MEMBER_EMAIL])
    )[0]?.id as string;

    const facilityId = (
      await query<{ id: string }>(`SELECT id FROM facilities ORDER BY created_at, id LIMIT 1`)
    )[0]?.id as string;
    await query(
      `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
       VALUES ($1::uuid, $2, 'crowd', 'status', '"needs_verification"'::jsonb, '"active"'::jsonb)`,
      [facilityId, userId],
    );
    await query(
      `INSERT INTO facility_photos (facility_id, storage_path, uploaded_by)
       VALUES ($1::uuid, $2, $3)`,
      [facilityId, `photos/e2e-${userId}.webp`, userId],
    );
    // A pending one-time code: keyed by email, so no cascade reaches it and
    // only the erasure's own DELETE can clear it.
    await query(
      `INSERT INTO verifications (id, identifier, value, expires_at)
       VALUES ($1, $2, 'hash', now() + interval '10 minutes')`,
      [`e2e-verification-${userId}`, `sign-in-otp-${MEMBER_EMAIL}`],
    );

    await page.goto('/profil');
    await page.getByLabel(/напишете|type/i).fill('ИЗТРИЙ');
    await page.getByRole('button', { name: /изтрий профила|delete my account/i }).click();
    await page.waitForURL(/localhost:3000\/?$/);

    // The profile and everything identifying the person are gone.
    expect(await query(`SELECT 1 FROM users WHERE id = $1`, [userId])).toHaveLength(0);
    expect(await query(`SELECT 1 FROM sessions WHERE user_id = $1`, [userId])).toHaveLength(0);
    // Including pending sign-in codes, which hold the address itself.
    expect(
      await query(`SELECT 1 FROM verifications WHERE identifier LIKE $1`, [`%${MEMBER_EMAIL}`]),
    ).toHaveLength(0);

    // The contribution survives, anonymised.
    const photos = await query<{ uploaded_by: string | null }>(
      `SELECT uploaded_by FROM facility_photos WHERE storage_path = $1`,
      [`photos/e2e-${userId}.webp`],
    );
    expect(photos).toHaveLength(1);
    expect(photos[0]?.uploaded_by).toBeNull();

    // The audit trail is untouched, and a tombstone records the erasure.
    const edits = await query(`SELECT 1 FROM facility_edits WHERE actor = $1`, [userId]);
    expect(edits.length).toBeGreaterThan(0);
    const tombstones = await query<{ audit_rows_preserved: number }>(
      `SELECT audit_rows_preserved FROM account_deletions WHERE user_id = $1`,
      [userId],
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]?.audit_rows_preserved).toBeGreaterThan(0);

    // The session really is dead, not just redirected away from.
    await page.goto('/profil');
    await expect(page).toHaveURL(/\/vhod/);
  });
});
