import { expect, test } from '@playwright/test';

import bg from '../messages/bg.json';

/**
 * The legal surfaces the pre-launch audit found missing: who runs the site and
 * how to reach them (/kontakt), the terms (/usloviya), a way for anybody to
 * report content (/signal, DSA Art. 16) — and the privacy notice's promise that
 * a signed-out visitor gets no cookie at all.
 */

test('a signed-out visitor is sent no cookie', async ({ request }) => {
  // next-intl used to write NEXT_LOCALE on every response although nothing read
  // it (apps/web/i18n/routing.ts). The only cookies left are the sign-in ones.
  for (const path of ['/', '/en', '/privacy', '/kontakt']) {
    const response = await request.get(path, { maxRedirects: 0 });
    const cookies = response
      .headersArray()
      .filter((header) => header.name.toLowerCase() === 'set-cookie')
      .map((header) => header.value.split('=')[0]);
    expect(cookies, path).toEqual([]);
  }
});

test('terms, contact and the notice form are one click from the footer', async ({ page }) => {
  const destinations: [string, string][] = [
    [bg.Footer.terms, bg.Terms.title],
    [bg.Footer.contact, bg.Contact.title],
    [bg.Footer.notice, bg.Notice.title],
  ];
  for (const [link, heading] of destinations) {
    await page.goto('/privacy');
    await page.getByRole('contentinfo').getByRole('link', { name: link, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
  }
});

test('a "report this" link pre-fills its own page, never an outside URL', async ({ page }) => {
  const urlField = page.locator('input[name="url"]');

  await page.goto('/signal?url=%2Fklasirane');
  await expect(urlField).toHaveValue('/klasirane');

  // A crafted link must not plant somebody else's address in the notice.
  await page.goto('/signal?url=https%3A%2F%2Fevil.example%2Fx');
  await expect(urlField).toHaveValue('');
});
