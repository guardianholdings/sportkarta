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
  /** The outbox file name, or mailpit's message ID. */
  id: string;
  at: number;
  /** Present for the outbox; mailpit serves it from a second endpoint. */
  text?: string;
}

/**
 * Every message in the file outbox addressed to `email`.
 *
 * Scanning by recipient rather than emptying the directory first is
 * deliberate: better-auth sends the code in the background, so a send can land
 * just after the action returns — deleting the directory underneath it loses
 * the message and the test waits forever for a code that was never written.
 */
async function fromOutbox(email: string): Promise<Delivered[]> {
  let files: string[];
  try {
    files = (await readdir(OUTBOX)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const found: Delivered[] = [];
  for (const name of files) {
    try {
      const message = JSON.parse(await readFile(path.join(OUTBOX, name), 'utf8')) as {
        to: string;
        text: string;
        sentAt: string;
      };
      if (message.to === email) {
        found.push({ id: name, at: Date.parse(message.sentAt), text: message.text });
      }
    } catch {
      // A message being written right now: skip it, the poll will retry.
    }
  }
  return found;
}

interface MailpitSummary {
  ID: string;
  Created: string;
  To: { Address: string }[] | null;
}

/**
 * Every message in mailpit addressed to `email`.
 *
 * mailpit's `to:` search is a substring match, so the recipient is compared
 * exactly here — `e2e@example.org` must not pick up a code sent to
 * `x-e2e@example.org`.
 */
async function fromMailpit(base: string, email: string): Promise<Delivered[]> {
  const query = encodeURIComponent(`to:"${email}"`);
  const search = await fetch(`${base}/api/v1/search?query=${query}&limit=50`);
  if (!search.ok) return [];
  const { messages } = (await search.json()) as { messages?: MailpitSummary[] };
  return (messages ?? [])
    .filter((m) => (m.To ?? []).some((to) => to.Address.toLowerCase() === email.toLowerCase()))
    .map((m) => ({ id: m.ID, at: Date.parse(m.Created) }));
}

async function deliveredTo(email: string): Promise<Delivered[]> {
  return MAILPIT ? fromMailpit(MAILPIT, email) : fromOutbox(email);
}

async function textOf(message: Delivered): Promise<string> {
  if (message.text !== undefined || !MAILPIT) return message.text ?? '';
  const response = await fetch(`${MAILPIT}/api/v1/message/${encodeURIComponent(message.id)}`);
  if (!response.ok) return '';
  const { Text } = (await response.json()) as { Text?: string };
  return Text ?? '';
}

/**
 * What the sink already holds for `email`. Take it BEFORE asking for a code,
 * and pass it to readOtp: none of it can be the code that request sends.
 *
 * `since` alone could not say so. It carries a second of slack for the clock
 * difference between this process and the sink, and the admin tests sign in as
 * one shared address back to back — so the previous test's code, landed a few
 * hundred milliseconds earlier and since rotated, passed for the new one, and
 * the sign-in failed on «Кодът е грешен или изтекъл» until the retry.
 */
export async function alreadyDelivered(email: string): Promise<ReadonlySet<string>> {
  return new Set((await deliveredTo(email)).map((message) => message.id));
}

/**
 * The code in the newest message to `email` that arrived after `since` and is
 * not in `seen`. `since` rules out a code left by an earlier run for the same
 * address: that one has been rotated and would fail verification.
 */
export async function readOtp(
  email: string,
  since: number,
  seen: ReadonlySet<string> = new Set(),
): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(
      async () => {
        const newest = (await deliveredTo(email))
          .filter((message) => !seen.has(message.id) && message.at >= since)
          .sort((a, b) => b.at - a.at)[0];
        if (!newest) return undefined;
        code = /\b(\d{6})\b/.exec(await textOf(newest))?.[1];
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
  const seen = await alreadyDelivered(email);
  // One second of slack for clock granularity between this process and the
  // mail sink (a file's timestamp, or mailpit's receive time).
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: /изпрати код|send code/i }).click();

  const code = await readOtp(email, since, seen);
  await page.getByLabel(/код|code/i).fill(code);
  await page.getByRole('button', { name: /^(влез|sign in)$/i }).click();
  await page.waitForURL(expectUrl);
}
