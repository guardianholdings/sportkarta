import { pointsEvent } from '@sportkarta/db/schema';
import { PASSPORT_EVENT_KINDS } from '@sportkarta/lib/badges';
import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * Every points_ledger event has a label, in both locales, in both places that
 * print ledger rows.
 *
 * WHY THIS EXISTS. The passport history (components/passport/history-list.tsx)
 * and the profile's points panel (components/profile/points-panel.tsx) render
 * `t(`event_${kind}`)` straight from `points_ledger.event`. Stage 5.4 added
 * `session_attended` to the enum and wrote it for every QR check-in, but no
 * `event_session_attended` message — so every member who checked in saw the
 * raw key «Passport.event_session_attended» on their own passport. The parity
 * test in tests/i18n.test.ts cannot see that: the key was missing from BOTH
 * catalogues, and missing symmetrically is parity.
 *
 * This asserts the contract instead: a new enum value is one migration plus
 * these keys, and forgetting the keys fails here rather than on a passport.
 */

type Namespace = Record<string, unknown>;

const NAMESPACES: [string, string, Namespace][] = [
  ['bg', 'Passport', bg.Passport as Namespace],
  ['en', 'Passport', en.Passport as Namespace],
  ['bg', 'Points', bg.Points as Namespace],
  ['en', 'Points', en.Points as Namespace],
];

describe('points_ledger events ↔ messages', () => {
  it('there are events to check (guards a vacuous pass)', () => {
    expect(pointsEvent.enumValues).toContain('session_attended');
  });

  for (const [locale, namespace, messages] of NAMESPACES) {
    it(`${locale}: ${namespace} labels every points_ledger event`, () => {
      const missing = pointsEvent.enumValues.filter((event) => {
        const value = messages[`event_${event}`];
        return typeof value !== 'string' || value.trim() === '';
      });
      expect(missing, `${namespace}.event_* missing in ${locale}.json`).toEqual([]);
    });
  }

  // The passport history also emits the check-in rows themselves
  // (`session_checkin`, from play_session_checkins), so it must label every
  // passport event kind, not only the ledger's.
  for (const [locale, messages] of [
    ['bg', bg.Passport],
    ['en', en.Passport],
  ] as [string, Namespace][]) {
    it(`${locale}: Passport labels every passport event kind`, () => {
      const missing = PASSPORT_EVENT_KINDS.filter(
        (kind) => typeof messages[`event_${kind}`] !== 'string',
      );
      expect(missing).toEqual([]);
    });
  }
});
