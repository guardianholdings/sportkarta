import { POINTS_BY_EVENT } from '@sportkarta/lib/points';
import { expect, test } from '@playwright/test';
import { config } from 'dotenv';
import pg from 'pg';

import bg from '../messages/bg.json';

import { signIn } from './auth';

config({ path: '../../.env' });

async function query(sql: string, params: unknown[]): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required for the week-share e2e suite');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(sql, params);
  } finally {
    await client.end();
  }
}

/**
 * C3: the plain-text week is offered to EVERY member with something in it,
 * including one whose passport is private (operator decision 2026-07-26). That
 * is the property worth pinning — it is the only share artifact that does not
 * require the public opt-in, precisely because it names nobody.
 *
 * "With something in it" is the page's own rule (pasport/page.tsx shows the
 * share only when `week.activeDays > 0`): seven rest days are not worth
 * pasting. This spec used to sign up a brand-new member and expect the share at
 * once, so it failed for as long as that rule has existed — the empty week is
 * asserted first now, then one contribution makes the week worth sharing.
 */
test('the week share appears with the first activity, for a private passport, naming nobody', async ({
  page,
}) => {
  const email = `week-share-${String(Date.now())}@example.org`;
  await signIn(page, email, /\/profil/);

  await page.goto('/pasport');
  // Wait for the passport itself before asserting an absence on it.
  await expect(
    page.getByRole('heading', { name: bg.Passport.badgesTitle, exact: true }),
  ).toBeVisible();
  await expect(page.getByText(bg.Share.weekTitle)).toHaveCount(0);

  // One verified facility today: the commonest contribution there is, written
  // the way the ledger records it (lib/points.ts), so the week has one active
  // day. The row leaves with the account, like every ledger row.
  await query(
    `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key)
     SELECT u.id, 'facility_verified'::points_event, $2::int, f.id,
            'facility_verified:' || f.id || ':' || u.id
       FROM users u,
            (SELECT id FROM facilities WHERE status <> 'gone' ORDER BY created_at, id LIMIT 1) f
      WHERE u.email = $1`,
    [email, POINTS_BY_EVENT.facility_verified],
  );
  await page.reload();

  const share = page.locator('section').filter({
    has: page.getByRole('heading', { name: bg.Share.weekTitle }),
  });
  await expect(share).toBeVisible();

  // Seven glyphs, and no identifier of any kind in the pasteable block.
  const block = await share.locator('pre').innerText();
  expect(block).toContain(bg.Share.weekHeading);
  const gridLine = block.split('\n')[1] ?? '';
  expect([...gridLine]).toHaveLength(7);
  expect(gridLine).not.toMatch(/[A-Za-zА-Яа-я0-9]/);
  expect(block).not.toContain(email);

  // A brand-new member's passport is private by default, and the share is
  // still there — that is the decision under test.
  await expect(share.getByRole('button', { name: bg.Share.share })).toBeVisible();
});
