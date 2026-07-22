import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

/**
 * Shared sign-in helper for the e2e suites.
 *
 * The code is read from the file-transport outbox (MAIL_TRANSPORT=file), which
 * is why the app needs no test-only endpoint or backdoor: the tests go through
 * exactly the flow a member goes through, and the "inbox" is a directory.
 */

// Relative to the process cwd, which is apps/web for both `next dev` and
// Playwright — the same path the app writes to.
const OUTBOX = process.env.MAIL_OUTBOX_DIR?.trim() || './var/mail';

export const ADMIN_EMAIL = 'e2e@example.org';

export async function clearOutbox(): Promise<void> {
  await rm(OUTBOX, { recursive: true, force: true });
}

/** Newest message in the outbox, or null when nothing has been sent yet. */
async function latestMessage(): Promise<{ to: string; text: string } | null> {
  let files: string[];
  try {
    files = (await readdir(OUTBOX)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return null;
  }
  const newest = files.at(-1);
  if (!newest) return null;
  return JSON.parse(await readFile(path.join(OUTBOX, newest), 'utf8')) as {
    to: string;
    text: string;
  };
}

export async function readOtp(email: string): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const message = await latestMessage();
        if (message?.to !== email) return undefined;
        code = /\b(\d{6})\b/.exec(message.text)?.[1];
        return code;
      },
      { message: `no sign-in code was delivered to ${email}`, timeout: 10_000 },
    )
    .toMatch(/^\d{6}$/);
  return code as string;
}

/** Full email-OTP sign-in, ending on `expectUrl`. */
export async function signIn(page: Page, email: string, expectUrl: RegExp): Promise<void> {
  await clearOutbox();
  await page.goto('/vhod');
  await page.getByLabel(/имейл|email/i).fill(email);
  await page.getByRole('button', { name: /изпрати код|send code/i }).click();

  const code = await readOtp(email);
  await page.getByLabel(/код|code/i).fill(code);
  await page.getByRole('button', { name: /^(влез|sign in)$/i }).click();
  await page.waitForURL(expectUrl);
}
