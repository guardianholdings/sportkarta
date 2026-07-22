import { expect, test, type Page } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';

// Repo-root .env: DATABASE_URL + ADMIN_TOKENS (e2e token; see ci.yml).
// Playwright runs with cwd = apps/web, so ../../.env is the repo root.
config({ path: '../../.env' });

const E2E_TOKEN = 'e2e-local-token-1234';
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
      ON CONFLICT (id) DO UPDATE SET status = 'needs_verification'
      `,
      [FACILITY_ID, FACILITY_NAME],
    );
  } finally {
    await client.end();
  }
}

async function login(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel(/токен|token/i).fill(E2E_TOKEN);
  await page.getByRole('button', { name: /влез|sign in/i }).click();
  await page.waitForURL(/\/admin$/);
}

test.describe('admin authz', () => {
  test('unauthenticated /admin redirects to login', async ({ page }) => {
    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('unauthenticated deep link redirects to login', async ({ page }) => {
    await page.goto('/admin/facilities');
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test('wrong token is rejected', async ({ page }) => {
    await page.goto('/admin/login');
    await page.getByLabel(/токен|token/i).fill('definitely-not-a-valid-token');
    await page.getByRole('button', { name: /влез|sign in/i }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/login/);
  });
});

test.describe('verify flow', () => {
  test.beforeEach(async () => {
    await seedFixture();
  });

  test('V keystroke verifies the facility and writes the audit row', async ({ page }) => {
    await login(page);
    // municipality=none: the fixture has no municipality; Latin name → first.
    await page.goto('/admin/verify?municipality=none');
    await expect(page.getByRole('heading', { name: FACILITY_NAME })).toBeVisible();

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
      expect(audit.rows[0]).toMatchObject({
        actor: 'e2e',
        source: 'crowd',
        old_value: 'needs_verification',
        new_value: 'active',
      });
    } finally {
      await client.end();
    }
  });
});
