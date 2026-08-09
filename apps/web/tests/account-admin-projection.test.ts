import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The admin account module may read anything a person's account touches, and it
 * may never read a credential or a coordinate.
 *
 * This is a source gate rather than a runtime one on purpose: the failure it
 * guards against is a future author adding `token` to a SELECT list to debug
 * something and leaving it there. A runtime test would need that person to also
 * write a test; this one fails on the diff.
 *
 * The forbidden set is not arbitrary. Each entry is a live bearer credential or
 * a record of where a named person physically was:
 *
 *   sessions.token                     — signs in as them
 *   accounts.access_token / refresh_token / id_token / password
 *                                      — the linked provider identity
 *   api_keys.key_hash                  — CHECK-pinned to a sha256 hex; still not ours to show
 *   calendar_tokens.token              — an unauthenticated, permanent URL to their whole calendar
 *   digest_subscriptions.unsubscribe_token
 *                                      — a working "cancel their subscription" link in a screenshot
 *   training_routes.geom               — where they were, GDPR Art. 9-adjacent and consent-gated
 *   training_metrics.avg/max_heart_rate, calories_kcal
 *                                      — Art. 9 health data on a separate lawful basis
 */

const WEB_ROOT = join(__dirname, '..');

/** Every file that builds SQL or renders for the account module. */
const GUARDED = [
  join('lib', 'account-admin.ts'),
  join('lib', 'account-access.ts'),
  join('app', '[locale]', 'admin', '(protected)', 'akaunti', 'page.tsx'),
  join('app', '[locale]', 'admin', '(protected)', 'akaunti', '[id]', 'page.tsx'),
];

/**
 * Matched as SQL/property identifiers, not as substrings of prose: the files
 * deliberately DISCUSS these columns at length in their comments, and a naive
 * substring scan would fail on its own documentation. Comments are stripped
 * first, then each name must appear as a standalone word to count.
 */
const FORBIDDEN = [
  'access_token',
  'refresh_token',
  'id_token',
  'key_hash',
  'unsubscribe_token',
  'geom',
  'avg_heart_rate',
  'max_heart_rate',
  'calories_kcal',
];

/** `token` and `password` are too common to match bare; require a SQL-ish context. */
const FORBIDDEN_PATTERNS: [string, RegExp][] = [
  ['sessions.token', /\bsessions?\.\s*token\b/],
  ['bare token column', /(?:SELECT|,)\s*(?:\w+\.)?token\b/i],
  ['password column', /(?:SELECT|,)\s*(?:\w+\.)?password\b/i],
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
}

describe('admin account module projection', () => {
  it.each(GUARDED)('%s selects no credential and no coordinate', (rel) => {
    const code = stripComments(readFileSync(join(WEB_ROOT, rel), 'utf8'));

    for (const name of FORBIDDEN) {
      const re = new RegExp(`\\b${name}\\b`);
      expect(
        re.test(code),
        `${rel} references \`${name}\`. That column is a live credential or a stored location and must never reach an admin screen — see the header of lib/account-admin.ts.`,
      ).toBe(false);
    }

    for (const [label, pattern] of FORBIDDEN_PATTERNS) {
      expect(
        pattern.test(code),
        `${rel} appears to select ${label}, which is a live bearer credential.`,
      ).toBe(false);
    }
  });

  it('reads trainings through the shared safe projection and never joins the sensitive tables', () => {
    const code = readFileSync(join(WEB_ROOT, 'lib', 'account-admin.ts'), 'utf8');
    // memberTrainings returns has_route/has_metrics as EXISTENCE booleans and
    // never the underlying rows. Aggregating training_logs itself is fine — the
    // list screen counts them — but naming either sensitive table here is the
    // step that would let a future author show "just a bit more".
    expect(code).toContain('memberTrainings');
    for (const table of ['training_routes', 'training_metrics']) {
      const re = new RegExp(`\\b${table}\\b`);
      expect(
        re.test(stripComments(code)),
        `account-admin.ts names \`${table}\`. Route geometry and heart rate never leave their tables — memberTrainings already exposes them as existence booleans.`,
      ).toBe(false);
    }
  });

  it('derives badges rather than reading the notification ledger', () => {
    const code = stripComments(readFileSync(join(WEB_ROOT, 'lib', 'account-admin.ts'), 'utf8'));
    // user_badges is a "new badge" notification cache, not the badge set: the
    // set is folded from the event stream on every read, which is what makes a
    // newly-added badge appear retroactively with a truthful date.
    expect(code).toContain('evaluateBadges');
    expect(
      /FROM\s+user_badges/i.test(code),
      'account-admin.ts reads user_badges directly; badges are derived by evaluateBadges over passportEvents.',
    ).toBe(false);
  });

  it('never writes a consent column', () => {
    const code = stripComments(readFileSync(join(WEB_ROOT, 'lib', 'account-admin.ts'), 'utf8'));
    // Consent is the member's to give and withdraw, and withdrawal is also what
    // DELETES the data it covers (db/src/training.ts setTrainingConsent). An
    // admin UPDATE of the flag alone would leave Art. 9 rows behind it.
    for (const column of ['training_route_consent_at', 'training_health_consent_at', 'profile_visibility']) {
      const writes = new RegExp(`(?:UPDATE|SET)[^;]*\\b${column}\\b`, 'i');
      expect(
        writes.test(code),
        `account-admin.ts appears to write \`${column}\`. This module is read-only; consent is the member's.`,
      ).toBe(false);
    }
  });
});
