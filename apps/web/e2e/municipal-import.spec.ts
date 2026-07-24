import { expect, test } from '@playwright/test';

import { ADMIN_EMAIL, signIn } from './auth';

/**
 * Municipal CSV inbox (Stage 6.3) — the two regressions from the 2026-07-24
 * audit, driven through the real wizard as the admin.
 *
 * AUDIT-F4: a malformed CSV must be REFUSED WITH FEEDBACK. The refusal always
 * worked; the feedback didn't — pickState let the never-dispatched preview/
 * commit states (still the initial EMPTY) displace the failed parse state, so
 * no error rendered and React 19's post-action form reset wiped the operator's
 * pasted CSV.
 *
 * AUDIT-F3: a registry written in Bulgarian (спорт=футбол) must survive the
 * preview instead of dying as "unknown sport" on every row.
 */

test.describe('municipal CSV inbox', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, /\/profil/);
    await page.goto('/admin/obshtini');
  });

  test('a corrupt CSV is refused with a visible error and the paste survives (AUDIT-F4)', async ({
    page,
  }) => {
    const corrupt = 'име,спорт,достъп,дължина,ширина\n"Площадка без край,футбол,свободен,23.36,42.67';
    await page.getByLabel(/източник на данните|data source/i).fill('Одит e2e регистър');
    await page.getByLabel(/постави съдържанието|paste/i).fill(corrupt);
    await page.getByRole('button', { name: /^(напред|next)$/i }).click();

    // Refused: still on step 1 (no mapping step), with a visible explanation.
    // Scope past Next's route announcer, which is also role=alert.
    await expect(page.getByRole('alert').filter({ hasText: /кавичк|quote/i })).toBeVisible();
    // The operator's work is not silently thrown away.
    await expect(page.getByLabel(/постави съдържанието|paste/i)).toHaveValue(corrupt);
    await expect(page.getByLabel(/източник на данните|data source/i)).toHaveValue(
      'Одит e2e регистър',
    );
  });

  test('a registry written in Bulgarian previews as valid rows (AUDIT-F3)', async ({ page }) => {
    // Remote rural coordinates so the row classifies as NEW, not match/conflict.
    const csv =
      'име,спорт,достъп,дължина,ширина\nПлощадка Одит БГ,"футбол, баскетбол",свободен,23.1042,41.9538';
    await page.getByLabel(/източник на данните|data source/i).fill('Одит e2e регистър');
    await page.getByLabel(/постави съдържанието|paste/i).fill(csv);
    await page.getByRole('button', { name: /^(напред|next)$/i }).click();

    // Mapping step guessed the columns; continue to the preview.
    await page.getByRole('button', { name: /^(преглед|preview)$/i }).click();

    // The Bulgarian sports cell parsed: one NEW row, zero invalid. The test
    // deliberately stops at the preview — it must never commit an import.
    await expect(page.getByText(/нови: 1|new: 1/i)).toBeVisible();
    await expect(page.getByText(/невалидни: 0|invalid: 0/i)).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Площадка Одит БГ' })).toBeVisible();
  });
});
