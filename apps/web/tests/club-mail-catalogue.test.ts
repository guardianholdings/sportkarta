import { CLUB_ROLES } from '@sportkarta/lib/clubs';
import { CLUB_MAIL_KINDS } from '@sportkarta/lib/email';
import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The worker reads ClubEmail at SEND time and throws on a missing key rather
 * than mailing the key's name as a subject (apps/worker/src/club-mail-job.ts).
 * The bg↔en parity test cannot see a kind that is missing from BOTH files, so
 * this pins the catalogue to the renderer's list of kinds.
 */

type Catalogue = Record<string, unknown>;

function at(catalogue: Catalogue, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined,
      catalogue,
    );
}

describe.each([
  ['bg', bg],
  ['en', en],
] as const)('ClubEmail in %s', (_locale, messages) => {
  const mail = (messages as Catalogue).ClubEmail as Catalogue;

  it.each(['subject', 'lead', 'action'])('has a %s for every mail kind', (group) => {
    for (const kind of CLUB_MAIL_KINDS) {
      const value = at(mail, `${group}.${kind}`);
      expect(typeof value === 'string' && value.length > 0, `${group}.${kind}`).toBe(true);
    }
  });

  it('names every staff role', () => {
    for (const role of CLUB_ROLES) expect(at(mail, `roleName.${role}`)).toBeTruthy();
  });

  it('has the shared lines and the digest lines', () => {
    for (const key of [
      'greeting',
      'greetingNoName',
      'labelWhen',
      'labelWhere',
      'footer',
      'unsubscribe',
      'rosterLine',
      'rosterLineOpen',
      'week.checkins',
      'week.newMembers',
      'week.bookings',
      'week.revenue',
      'week.expiring',
      'week.overdue',
      'week.claims',
      'week.erasures',
    ]) {
      expect(at(mail, key), key).toBeTruthy();
    }
  });
});
