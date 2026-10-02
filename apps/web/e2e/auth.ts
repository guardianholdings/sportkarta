import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

/**
 * Shared sign-in helper for the e2e suites.
 *
 * The tests go through exactly the flow a member goes through — the app has no
 * test-only endpoint or backdoor — and read the one-time code from wherever
 * the server under test delivered it (playwright.config.ts decides which):
 *
 *  - E2E_MAILPIT_URL set (CI): the production server sends the code over real
 *    SMTP, STARTTLS required exactly as in production, to a mailpit sink, and
 *    it is read back from mailpit's HTTP API. This is the production mail
 *    path's end-to-end test — the path that once died silently in production.
 *  - otherwise (a local `next dev` run): the file-transport outbox, a
 *    directory of JSON messages.
 */

const MAILPIT = process.env.E2E_MAILPIT_URL?.trim().replace(/\/+$/, '');

// Relative to the process cwd, which is apps/web for both `next dev` and
// Playwright — the same path the app writes to.
const OUTBOX = process.env.MAIL_OUTBOX_DIR?.trim() || './var/mail';

export const ADMIN_EMAIL = 'e2e@example.org';

interface Delivered {
  text: string;
}

/**
 * Newest message addressed to `email` in the file outbox, or null.
 *
 * Filenames are ISO timestamps, so sorting them orders the outbox. Scanning by
 * recipient rather than emptying the directory first is deliberate: better-auth
 * sends the code in the background, so a send can land just after the action
 * returns — deleting the directory underneath it loses the message and the test
 * waits forever for a code that was never written.
 */
async function latestInOutbox(email: string, since: number): Promise<Delivered | null> {
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

interface MailpitSummary {
  ID: string;
  Created: string;
  To: { Address: string }[] | null;
}

/**
 * Newest message addressed to `email` in mailpit, or null.
 *
 * mailpit's `to:` search is a substring match, so the recipient is compared
 * exactly here — `e2e@example.org` must not pick up a code sent to
 * `x-e2e@example.org`. `since` does the same job as for the outbox: an earlier
 * run's code for the same address has been rotated.
 */
async function latestInMailpit(
  base: string,
  email: string,
  since: number,
): Promise<Delivered | null> {
  const query = encodeURIComponent(`to:"${email}"`);
  const search = await fetch(`${base}/api/v1/search?query=${query}&limit=50`);
  if (!search.ok) return null;
  const { messages } = (await search.json()) as { messages?: MailpitSummary[] };
  const newest = (messages ?? [])
    .filter((m) => (m.To ?? []).some((to) => to.Address.toLowerCase() === email.toLowerCase()))
    .filter((m) => Date.parse(m.Created) >= since)
    .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))[0];
  if (!newest) return null;
  const message = await fetch(`${base}/api/v1/message/${encodeURIComponent(newest.ID)}`);
  if (!message.ok) return null;
  const { Text } = (await message.json()) as { Text?: string };
  return { text: Text ?? '' };
}

export async function readOtp(email: string, since: number): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const message = MAILPIT
          ? await latestInMailpit(MAILPIT, email, since)
          : await latestInOutbox(email, since);
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
  // One second of slack for clock granularity between this process and the
  // mail sink (a file's timestamp, or mailpit's receive time).
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: /изпрати код|send code/i }).click();

  const code = await readOtp(email, since);
  await page.getByLabel(/код|code/i).fill(code);
  await page.getByRole('button', { name: /^(влез|sign in)$/i }).click();
  await page.waitForURL(expectUrl);
}
