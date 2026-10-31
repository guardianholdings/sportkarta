import { expect, test } from '@playwright/test';

import bg from '../messages/bg.json';

/**
 * The «+» of the tab bar (components/shell/quick-actions.tsx): three actions,
 * a modal that keeps focus inside, closes on Escape and gives focus back. The
 * unit test pins the source; this drives it in a browser, on a phone.
 */

test.use({ viewport: { width: 390, height: 844 } });

test('the «+» opens three actions and closes on Escape', async ({ page }) => {
  await page.goto('/sesii');
  const plus = page.getByRole('button', { name: bg.Nav.quick.title }).last();
  await plus.click();

  const dialog = page.getByRole('dialog', { name: bg.Nav.quick.title });
  await expect(dialog).toBeVisible();
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
  await page.getByRole('button', { name: bg.Nav.quick.title }).last().click();
  const add = page
    .getByRole('dialog', { name: bg.Nav.quick.title })
    .getByRole('link', { name: new RegExp(bg.Nav.quick.addFacility.title) });
  await expect(add).toHaveAttribute('href', /^\/dobavi\?lon=23\.32\d+&lat=42\.69\d+&izgled=1$/);
});
