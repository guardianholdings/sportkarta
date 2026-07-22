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

/**
 * Newest message addressed to `email`, or null.
 *
 * Filenames are ISO timestamps, so sorting them orders the outbox. Scanning by
 * recipient rather than emptying the directory first is deliberate: better-auth
 * sends the code in the background, so a send can land just after the action
 * returns — deleting the directory underneath it loses the message and the test
 * waits forever for a code that was never written.
 */
async function latestMessageFor(
  email: string,
  since: number,
): Promise<{ to: string; text: string } | null> {
  let files: string[];
  try {
    files = (await readdir(OUTBOX)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return null;
  }
  for (const name of files.reverse()) {
    try {
      const message = JSON.parse(await readFile(path.join(OUTBOX, name), 'utf8')) as {
        to: string;
        text: string;
        sentAt: string;
      };
      // `since` rules out a code left by an earlier run for the same address:
      // that one has been rotated and would fail verification.
      if (message.to === email && Date.parse(message.sentAt) >= since) return message;
    } catch {
      // A message being written right now: skip it, the poll will retry.
    }
  }
  return null;
}

export async function readOtp(email: string, since: number): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const message = await latestMessageFor(email, since);
        if (!message) return undefined;
        code = /\b(\d{6})\b/.exec(message.text)?.[1];
        return code;
      },
      { message: `no sign-in code was delivered to ${email}`, timeout: 10_000 },
    )
    .toMatch(/^\d{6}$/);
  return code as string;
}

/**
 * Full email-OTP sign-in, ending on `expectUrl`. Each suite uses a distinct
 * address per test, so messages never need to be cleared between runs.
 */
export async function signIn(page: Page, email: string, expectUrl: RegExp): Promise<void> {
  await page.goto('/vhod');
  await page.getByLabel(/имейл|email/i).fill(email);
  // One second of slack for clock granularity between this process and the file.
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: /изпрати код|send code/i }).click();

  const code = await readOtp(email, since);
  await page.getByLabel(/код|code/i).fill(code);
  await page.getByRole('button', { name: /^(влез|sign in)$/i }).click();
  await page.waitForURL(expectUrl);
}
