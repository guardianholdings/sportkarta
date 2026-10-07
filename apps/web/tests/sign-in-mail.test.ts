import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  SIGN_IN_MAIL_STRING_KEYS,
  signInCodeEmail,
  UNBOUNDED_800_WOFF2,
} from '@sportkarta/lib/email';
import { describe, expect, it } from 'vitest';

import { OTP_TTL_SECONDS } from '@/lib/auth-surface';
import { signInMailStrings } from '@/lib/sign-in-code';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The sign-in mail as members get it: the real AuthEmail catalogues, the real
 * code lifetime and the embedded font. The renderer's own contract (escaping,
 * links, the inline mark) is in lib/src/email/sign-in-mail.test.ts.
 */

const MINUTES = OTP_TTL_SECONDS / 60;
const CODE = '482913';

/** The CEO's budget for the whole HTML (bg ≈ 27 KB, en ≈ 38 KB); Gmail clips at 102 KB. */
const HTML_BUDGET_BYTES = 40_000;

function mailFor(locale: 'bg' | 'en') {
  return signInCodeEmail({
    code: CODE,
    minutes: MINUTES,
    strings: signInMailStrings(locale),
    locale,
  });
}

describe.each(['bg', 'en'] as const)('the %s sign-in mail', (locale) => {
  const mail = mailFor(locale);

  it('carries the code in the subject, the text part and once in the HTML', () => {
    expect(mail.subject.startsWith(`${CODE} `)).toBe(true);
    expect(mail.text).toContain(CODE);
    expect(mail.html.split(CODE)).toHaveLength(2);
  });

  it('states the real lifetime of the code', () => {
    const unit = locale === 'en' ? 'minutes' : 'минути';
    expect(mail.text).toContain(`${String(MINUTES)} ${unit}`);
    expect(mail.html).toContain(`${String(MINUTES)} ${unit}`);
  });

  it('leaves no placeholder unfilled', () => {
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(part).not.toMatch(/\{(code|minutes)\}|<\/?link>/);
    }
  });

  it(`stays within ${String(HTML_BUDGET_BYTES)} bytes of HTML`, () => {
    expect(Buffer.byteLength(mail.html, 'utf8')).toBeLessThanOrEqual(HTML_BUDGET_BYTES);
  });
});

describe('the AuthEmail catalogue', () => {
  it.each([
    ['bg', bg.AuthEmail],
    ['en', en.AuthEmail],
  ] as const)('%s has exactly the keys the mail reads', (_, strings) => {
    expect(Object.keys(strings).sort()).toEqual([...SIGN_IN_MAIL_STRING_KEYS].sort());
  });

  it.each([
    ['bg', bg.AuthEmail],
    ['en', en.AuthEmail],
  ] as const)('%s keeps every placeholder the mail fills', (_, strings) => {
    expect(strings.subject).toContain('{code}');
    for (const key of ['preheader', 'validity', 'textLead'] as const) {
      expect(strings[key]).toContain('{minutes}');
    }
    expect(strings.lead).toMatch(/<link>[^<]+<\/link>/);
  });
});

describe('the embedded brand font', () => {
  // The same package app/fonts.css loads; apps/web/scripts/email-assets.mjs
  // regenerates the module from it.
  const files = path.join(__dirname, '..', 'node_modules', '@fontsource', 'unbounded', 'files');

  it.each(['cyrillic', 'latin'] as const)(
    'is @fontsource/unbounded’s %s 800 subset, byte for byte',
    (subset) => {
      const woff2 = readFileSync(path.join(files, `unbounded-${subset}-800-normal.woff2`));
      expect(Buffer.from(UNBOUNDED_800_WOFF2[subset], 'base64').equals(woff2)).toBe(true);
    },
  );
});
