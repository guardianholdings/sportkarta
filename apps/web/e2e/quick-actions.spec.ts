import { expect, test, type Locator, type Page } from '@playwright/test';

import bg from '../messages/bg.json';

/**
 * The «+» of the tab bar (components/shell/quick-actions.tsx): three actions,
 * a modal that keeps focus inside, closes on Escape and gives focus back. The
 * unit test pins the source; this drives it in a browser, on a phone.
 */

test.use({ viewport: { width: 390, height: 844 } });

/**
 * The «+» is a client island: a tap before the page hydrates does nothing,
 * and a production build hands Playwright the page before that. Wait for the
 * network to settle, then press until the menu is there (one press opens it;
 * the retry only covers a press that landed before hydration).
 */
async function openMenu(page: Page): Promise<{ plus: Locator; dialog: Locator }> {
  await page.waitForLoadState('networkidle');
  const plus = page.getByRole('button', { name: bg.Nav.quick.title }).last();
  const dialog = page.getByRole('dialog', { name: bg.Nav.quick.title });
  await expect(async () => {
    if (!(await dialog.isVisible())) await plus.click();
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return { plus, dialog };
}

test('the «+» opens three actions and closes on Escape', async ({ page }) => {
  await page.goto('/sesii');
  const { plus, dialog } = await openMenu(page);
  await expect(dialog.getByRole('link')).toHaveCount(3);
  await expect(
    dialog.getByRole('link', { name: new RegExp(bg.Nav.quick.addFacility.title) }),
  ).toHaveAttribute('href', '/dobavi');
  await expect(
    dialog.getByRole('link', { name: new RegExp(bg.Nav.quick.logTraining.title) }),
  ).toHaveAttribute('href', '/trenirovki?nova=1');
  await expect(
    dialog.getByRole('link', { name: new RegExp(bg.Nav.quick.scanQr.title) }),
  ).toHaveAttribute('href', '/skenirai');

  // Focus starts on the first action and stays inside the dialog.
  await expect(dialog.getByRole('link').first()).toBeFocused();
  for (let i = 0; i < 5; i += 1) await page.keyboard.press('Tab');
  await expect(dialog.locator(':focus')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(plus).toBeFocused();
  await expect(plus).toHaveAttribute('aria-expanded', 'false');
});

test('over the map at street zoom, «Добави съоръжение» starts where the map looks', async ({
  page,
}) => {
  await page.goto('/karta?z=15&lat=42.69770&lng=23.32190');
  const { dialog } = await openMenu(page);
  const add = dialog.getByRole('link', { name: new RegExp(bg.Nav.quick.addFacility.title) });
  await expect(add).toHaveAttribute('href', /^\/dobavi\?lon=23\.32\d+&lat=42\.69\d+&izgled=1$/);
});
