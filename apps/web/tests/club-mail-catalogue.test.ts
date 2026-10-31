import { CLUB_ROLES, PUSH_NOTIFY_KINDS, SMS_NOTIFY_KINDS } from '@sportkarta/lib/clubs';
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

  it('has a push line and an SMS line for every notice that goes by them (0051)', () => {
    for (const kind of PUSH_NOTIFY_KINDS) expect(at(mail, `push.${kind}`), kind).toBeTruthy();
    for (const kind of SMS_NOTIFY_KINDS) expect(at(mail, `sms.${kind}`), kind).toBeTruthy();
    expect(at(mail, 'unsubscribeMarketing')).toBeTruthy();
    expect(at(mail, 'smsOptOut')).toBeTruthy();
  });

  it('fills every placeholder of the club-standing mails (0059, 0061)', () => {
    // fillClubTemplate leaves an unknown {x} in the text, so a placeholder the
    // worker does not pass (runClubLifecycle's values, plus {club}) would be
    // mailed literally.
    const filled = new Set(['club', 'date', 'noticeBy', 'grace', 'months', 'contact']);
    const kinds = [
      'club_trial_ending',
      'club_past_due',
      'club_lapsed',
      'club_suspended',
      'club_contract_renewing',
    ];
    for (const kind of kinds) {
      for (const group of ['subject', 'lead']) {
        const text = String(at(mail, `${group}.${kind}`));
        const unknown = [...text.matchAll(/\{(\w+)\}/g)]
          .map((m) => m[1] as string)
          .filter((name) => !filled.has(name));
        expect(unknown, `${group}.${kind}`).toEqual([]);
      }
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
