import { expect, test } from '@playwright/test';
import { config } from 'dotenv';

import bg from '../messages/bg.json';

import { signIn } from './auth';

config({ path: '../../.env' });

/**
 * C3: the plain-text week is offered to EVERY member, including one whose
 * passport is private (operator decision 2026-07-26). That is the property
 * worth pinning — it is the only share artifact that does not require the
 * public opt-in, precisely because it names nobody.
 */
test('the week share is offered on the passport and names nobody', async ({ page }) => {
  await signIn(page, `week-share-${String(Date.now())}@example.org`, /\/profil/);
  await page.goto('/pasport');

  await expect(page.getByText(bg.Share.weekTitle)).toBeVisible();

  // Seven glyphs, and no identifier of any kind in the pasteable block.
  const block = await page.locator('pre').first().innerText();
  expect(block).toContain(bg.Share.weekHeading);
  const gridLine = block.split('\n')[1] ?? '';
  expect([...gridLine]).toHaveLength(7);
  expect(gridLine).not.toMatch(/[A-Za-zА-Яа-я0-9]/);

  // A brand-new member's passport is private by default, and the share is
  // still there — that is the decision under test.
  await expect(page.getByRole('button', { name: bg.Share.share })).toBeVisible();
});
