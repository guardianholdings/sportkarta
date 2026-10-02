import { expect, test } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';

import { ADMIN_EMAIL, signIn } from './auth';

// Repo-root .env (Playwright runs with cwd = apps/web).
config({ path: '../../.env' });

/**
 * The operator's account controls (migration 0033), end to end.
 *
 * The unit tests prove the statements and the DB test proves the CHECKs. What
 * only a real request can prove is the GATE: that a member whose browser still
 * holds a valid session cookie — inside the five-minute cookie cache, which no
 * session DELETE can reach — is nonetheless signed out on the very next
 * request once suspended, because getCurrentUser() reads the row. And that the
 * two GDPR answers the audit found missing (a member's own export, an admin's
 * erasure on someone's behalf) work through the real routes.
 *
 * Note on fixtures: `admin_actions` and `account_access_log` are append-only,
 * so the rows these tests write stay behind — about an account that is then
 * deleted, which is exactly the "former user" state those logs exist to keep.
 */

const SUSPENDED_EMAIL = 'e2e-account-suspended@example.org';
const ERASED_EMAIL = 'e2e-account-erased@example.org';

function dbClient(): pg.Client {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the account-controls e2e suite');
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

test.describe('operator account controls', () => {
  test.beforeEach(async () => {
    await query(`DELETE FROM users WHERE email = ANY($1::text[])`, [
      [SUSPENDED_EMAIL, ERASED_EMAIL],
    ]);
  });

  test('a suspended member is signed out on their next request; the admin can still export', async ({
    page,
    browser,
  }) => {
    // Two interactive sign-ins and a server action on a dev server that may
    // still be compiling these routes.
    test.setTimeout(90_000);

    // The member, signed in, downloads their own record (Art. 15/20).
    await signIn(page, SUSPENDED_EMAIL, /\/profil/);
    const own = await page.request.get('/api/profil/eksport');
    expect(own.status()).toBe(200);
    expect(own.headers()['content-disposition']).toMatch(/^attachment;/);
    expect(own.headers()['cache-control']).toContain('no-store');
    const ownData = (await own.json()) as { account: { id: string; email: string } };
    expect(ownData.account.email).toBe(SUSPENDED_EMAIL);
    const memberId = ownData.account.id;

    const adminContext = await browser.newContext();
    try {
      const admin = await adminContext.newPage();
      await signIn(admin, ADMIN_EMAIL, /\/profil/);
      await admin.goto(`/admin/akaunti/${memberId}`);
      await admin.getByLabel(/^(причина|reason)$/i).fill('E2E: спам в редакциите');
      await admin.getByRole('button', { name: /^(спри акаунта|suspend)$/i }).click();

      await expect
        .poll(async () => {
          const rows = await query<{ suspended: boolean; visibility: string }>(
            `SELECT suspended_at IS NOT NULL AS suspended,
                    profile_visibility::text AS visibility
             FROM users WHERE id = $1`,
            [memberId],
          );
          return rows[0];
        })
        .toEqual({ suspended: true, visibility: 'private' });

      // Same transaction as the suspension: every session gone, one log row,
      // and the log row does not carry the reason.
      const sessions = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM sessions WHERE user_id = $1`,
        [memberId],
      );
      expect(sessions[0]?.n).toBe(0);
      const logged = await query<{ action: string; detail: unknown }>(
        `SELECT action::text AS action, detail FROM admin_actions WHERE subject_id = $1`,
        [memberId],
      );
      expect(logged.map((row) => row.action)).toEqual(['account_suspended']);
      expect(JSON.stringify(logged[0]?.detail)).not.toContain('спам');

      // The member's browser still holds its signed cookie — and is signed out.
      await page.goto('/profil');
      await expect(page).toHaveURL(/\/vhod/);
      // Not following the sign-in redirect: what matters is that no record
      // comes back, whatever status the auth layer chooses.
      const refused = await page.request.get('/api/profil/eksport', { maxRedirects: 0 });
      expect(refused.status()).not.toBe(200);
      expect(await refused.text()).not.toContain(SUSPENDED_EMAIL);

      // The operator can still answer an access request for them, and the
      // download is recorded as an 'export' read before any data leaves.
      const exported = await admin.request.get(`/api/admin/akaunti/${memberId}/eksport`);
      expect(exported.status()).toBe(200);
      const data = (await exported.json()) as {
        account: { id: string; suspension: { reason: string } | null };
      };
      expect(data.account.id).toBe(memberId);
      expect(data.account.suspension?.reason).toBe('E2E: спам в редакциите');
      const reads = await query<{ scope: string }>(
        `SELECT scope::text AS scope FROM account_access_log WHERE subject_id = $1`,
        [memberId],
      );
      expect(reads.map((row) => row.scope)).toContain('export');
    } finally {
      await adminContext.close();
    }
  });

  test('an admin erases an account behind a typed email, and the erasure is logged', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // Seeded directly: the person asking for erasure is, by premise, someone
    // who can no longer sign in.
    const memberId = `e2e_erase_${Date.now()}`;
    await query(
      `INSERT INTO users (id, display_name, email, email_verified)
       VALUES ($1, 'E2E за изтриване', $2, true)`,
      [memberId, ERASED_EMAIL],
    );

    await signIn(page, ADMIN_EMAIL, /\/profil/);
    await page.goto(`/admin/akaunti/${memberId}`);
    await page
      .locator('summary')
      .filter({ hasText: /чл\. 17|art\. 17/i })
      .click();
    const confirmation = page.getByLabel(/имейла на участника|member's email/i);

    // A wrong address changes nothing.
    await confirmation.fill('someone-else@example.org');
    await page
      .getByRole('button', { name: /изтрий акаунта окончателно|erase the account permanently/i })
      .click();
    await expect(
      page.getByRole('alert').filter({ hasText: /не съвпада|does not match/i }),
    ).toBeVisible();
    expect(await query(`SELECT 1 FROM users WHERE id = $1`, [memberId])).toHaveLength(1);

    await confirmation.fill(ERASED_EMAIL);
    await page
      .getByRole('button', { name: /изтрий акаунта окончателно|erase the account permanently/i })
      .click();
    await page.waitForURL(/\/admin\/akaunti\?iztrit=1$/);

    expect(await query(`SELECT 1 FROM users WHERE id = $1`, [memberId])).toHaveLength(0);
    // Who erased it outlives the account: no foreign key on subject_id.
    const logged = await query<{ action: string; actor: string | null }>(
      `SELECT a.action::text AS action, u.email AS actor
       FROM admin_actions a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.subject_id = $1`,
      [memberId],
    );
    expect(logged).toEqual([{ action: 'account_erased', actor: ADMIN_EMAIL }]);
  });
});
