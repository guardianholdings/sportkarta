import { expect, test } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';

import { ADMIN_EMAIL, signIn } from './auth';

// Repo-root .env: DATABASE_URL. The admin account is bootstrapped from
// ADMIN_EMAILS (see ci.yml); Playwright runs with cwd = apps/web, so ../../.env
// is the repo root.
config({ path: '../../.env' });
// Fixed UUID: idempotent re-seeding via ON CONFLICT; audit rows from previous
// runs accumulate by design (facility_edits is append-only).
const FACILITY_ID = '00000000-0000-4000-8000-00000000ad01';
// Latin name sorts before Cyrillic in the queue → deterministically first card.
const FACILITY_NAME = 'E2E verify fixture';

function dbClient(): pg.Client {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the admin e2e suite');
  return new pg.Client({ connectionString: url });
}

async function seedFixture(): Promise<void> {
  const client = dbClient();
  await client.connect();
  try {
    await client.query(
      `
      INSERT INTO facilities (id, geom, name, sport_types, access, status, source, quarter)
      VALUES ($1::uuid, ST_SetSRID(ST_MakePoint(23.3219, 42.6977), 4326), $2,
              '{basketball}', 'free', 'needs_verification', 'crowd', 'Тест')
      ON CONFLICT (id) DO UPDATE
        SET status = 'needs_verification', municipality_id = NULL
      `,
      [FACILITY_ID, FACILITY_NAME],
    );
  } finally {
    await client.end();
  }
}

async function adminId(): Promise<string> {
  const client = dbClient();
  await client.connect();
  try {
    const result = await client.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
      ADMIN_EMAIL,
    ]);
    return result.rows[0]?.id ?? '';
  } finally {
    await client.end();
  }
}

test.describe('admin authz', () => {
  test('unauthenticated /admin redirects to sign-in', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/vhod/);
  });

  test('unauthenticated deep link redirects to sign-in', async ({ page }) => {
    await page.goto('/admin/facilities');
    await expect(page).toHaveURL(/\/vhod/);
  });

  test('the retired token login now points at the shared sign-in', async ({ page }) => {
    await page.goto('/admin/login');
    await expect(page).toHaveURL(/\/vhod/);
  });

  test('a wrong code never creates a session', async ({ page }) => {
    await page.goto('/vhod');
    await page.getByLabel(/имейл|email/i).fill(ADMIN_EMAIL);
    await page.getByRole('button', { name: /изпрати код|send code/i }).click();
    await page.getByLabel(/код|code/i).fill('000000');
    await page.getByRole('button', { name: /^(влез|sign in)$/i }).click();

    await expect(page.getByRole('alert')).toBeVisible();
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/vhod/);
  });
});

test.describe('verify flow', () => {
  test.beforeEach(async () => {
    await seedFixture();
  });

  test('V keystroke verifies the facility and writes the audit row', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, /\/profil/);
    // municipality=none: the fixture has no municipality; Latin name → first.
    await page.goto('/admin/verify?municipality=none');
    await expect(page.getByRole('heading', { name: FACILITY_NAME })).toBeVisible();

    // The heading is server-rendered, so it is visible before React attaches the
    // deck's keydown listener; pressing straight away can land in that gap and
    // be swallowed. Wait for the page to settle first.
    await page.waitForLoadState('networkidle');
    await page.keyboard.press('v');

    // Optimistic advance: the fixture card leaves the deck immediately.
    await expect(page.getByRole('heading', { name: FACILITY_NAME })).toBeHidden();

    // The status-guarded action landed: status flipped + audit row written.
    const client = dbClient();
    await client.connect();
    try {
      await expect
        .poll(async () => {
          const r = await client.query(`SELECT status FROM facilities WHERE id = $1`, [
            FACILITY_ID,
          ]);
          return r.rows[0]?.status as string | undefined;
        })
        .toBe('active');
      const audit = await client.query(
        `
        SELECT actor, source, old_value, new_value FROM facility_edits
        WHERE facility_id = $1 AND field = 'status'
        ORDER BY id DESC LIMIT 1
        `,
        [FACILITY_ID],
      );
      // The audit actor is the signed-in account's opaque id — not a name,
      // and not anything supplied by the form.
      expect(audit.rows[0]).toMatchObject({
        actor: await adminId(),
        source: 'crowd',
        old_value: 'needs_verification',
        new_value: 'active',
      });
    } finally {
      await client.end();
    }
  });
});
