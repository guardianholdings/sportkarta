import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MINIMUM_ACCOUNT_AGE } from '@sportkarta/lib/age';
import { describe, expect, it } from 'vitest';

import { buildProfileUpdate, ProfileValidationError } from '@/lib/profile';

/**
 * Minimum account age (operator decision 2026-11-06: 14, the Bulgarian
 * digital-consent age). Two properties hold it in place: the account path
 * refuses a younger date of birth with its own code and without the date, and
 * every sentence that states the age reads it from the constant — a typed
 * number in a string would drift the moment the constant changed.
 */

// Fixed clock, like dob-not-persisted.test.ts: the verdict must not depend on the run date.
const NOW = new Date('2026-07-22T09:00:00Z');

function messages(locale: 'bg' | 'en'): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'messages', `${locale}.json`), 'utf8'),
  ) as Record<string, unknown>;
}

function pick(tree: Record<string, unknown>, dotted: string): string {
  let node: unknown = tree;
  for (const key of dotted.split('.')) node = (node as Record<string, unknown>)[key];
  expect(typeof node, dotted).toBe('string');
  return node as string;
}

/**
 * Every string on the site that names the minimum age — including the two
 * purpose paragraphs of the privacy notice (the account's and the analytics
 * consent's, which rests on the same ЗЗЛД чл. 25в age). Deliberately NOT here:
 * the club-pixels attestation («деца под 14 години»), which is a club's
 * declaration about advertising audiences, a different rule with its own age.
 */
const AGE_STRINGS = [
  'SignIn.privacyNote',
  'Privacy.minors.body',
  'Privacy.processing.account.body',
  'Privacy.processing.googleAnalytics.body',
  'Terms.account.age',
  'Profile.dateOfBirthHint',
  'Profile.error_under_minimum_age',
];

describe('minimum account age', () => {
  it('refuses a younger date of birth with its own code and keeps the date out of the error', () => {
    try {
      buildProfileUpdate({ displayName: 'Член', homeCity: '', dateOfBirth: '2013-01-01' }, NOW);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ProfileValidationError);
      expect((error as ProfileValidationError).code).toBe('under_minimum_age');
      expect((error as Error).message).not.toContain('2013');
    }
  });

  it('admits a member from their 14th birthday, still categorised as under 18', () => {
    expect(MINIMUM_ACCOUNT_AGE).toBe(14);
    const update = buildProfileUpdate(
      { displayName: 'Член', homeCity: '', dateOfBirth: '2012-07-22' },
      NOW,
    );
    expect(update.isMinor).toBe(true);
  });

  it('leaves an account without a date of birth alone', () => {
    expect(buildProfileUpdate({ displayName: 'Член', homeCity: '' }, NOW).isMinor).toBeUndefined();
  });

  it.each(['bg', 'en'] as const)(
    '%s: states the age through {age}, never as a typed number',
    (locale) => {
      const tree = messages(locale);
      for (const key of AGE_STRINGS) {
        const text = pick(tree, key);
        expect(text, key).toContain('{age}');
        expect(text, key).not.toMatch(/\b14\b/);
      }
    },
  );

  it.each(['bg', 'en'] as const)(
    '%s: both legal documents are stamped with the day the clause arrived',
    (locale) => {
      const tree = messages(locale);
      expect(pick(tree, 'Privacy.updated')).toMatch(/6\u00a0ноември 2026|6 November 2026/);
      expect(pick(tree, 'Terms.updated')).toMatch(/6 ноември 2026|6 November 2026/);
    },
  );

  it('bg/en: no longer claims there is no minimum age', () => {
    for (const locale of ['bg', 'en'] as const) {
      const tree = messages(locale);
      expect(pick(tree, 'Privacy.minors.body')).not.toMatch(/Не сме въвели|have not set a minimum/);
      expect(pick(tree, 'Terms.account.age')).not.toMatch(/преразглежда|under review/);
    }
  });
});
