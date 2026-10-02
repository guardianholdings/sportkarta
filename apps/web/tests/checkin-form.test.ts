import { describe, expect, it, vi } from 'vitest';

import {
  PHASE_KEYS,
  offersUnscored,
  submitsImmediately,
  UNSCORED_OFFER_AFTER_MS,
} from '../app/[locale]/otmetka/[token]/checkin-form';
import bg from '../messages/bg.json';
import en from '../messages/en.json';

// The form module imports its server action, which reaches the database and
// `server-only`; only the pure decisions are under test here. (Hoisted above
// the imports by vitest.)
vi.mock('../app/[locale]/otmetka/[token]/actions', () => ({ redeemCheckinAction: vi.fn() }));

/**
 * QR check-in must not record an unpaid check-in just because the tap beat the
 * location fix (pre-launch audit, 2026-09).
 *
 * A check-in is recorded once per member and occurrence — `ON CONFLICT DO
 * NOTHING` in lib/sessions/checkin.ts — so one sent without coordinates is
 * final: the second scan only says "already checked in", and the rotating QR
 * code has expired by the time anybody notices. The form now holds a tap until
 * the position is in, and recording without one is a deliberate second choice.
 */

const PHASES = [
  'idle',
  'asking',
  'granted',
  'denied',
  'unavailable',
  'unsupported',
  'insecure',
] as const;

describe('when a check-in tap may post', () => {
  it('posts at once only with a fix, or where no fix can ever come', () => {
    expect(PHASES.filter((phase) => submitsImmediately(phase))).toEqual([
      'granted',
      'unsupported',
      'insecure',
    ]);
  });

  it('holds the post while the question is unanswered or has not been put', () => {
    for (const phase of ['idle', 'asking', 'denied', 'unavailable'] as const) {
      expect(submitsImmediately(phase), phase).toBe(false);
    }
  });
});

describe('the deliberate «без точки» choice', () => {
  it('is offered once asking has failed', () => {
    expect(offersUnscored('denied', false)).toBe(true);
    expect(offersUnscored('unavailable', false)).toBe(true);
  });

  it('is offered once a tap has waited a while on a request that may never answer', () => {
    expect(offersUnscored('asking', true)).toBe(true);
  });

  it('is not offered before anybody tapped, in the moment before a fix, or once it is in', () => {
    expect(offersUnscored('idle', false)).toBe(false);
    // A request still inside its grace period — whether the silent fetch for
    // a member who already allowed location, or a tap that has only just
    // asked — is not a reason to invite an unpaid check-in.
    expect(offersUnscored('asking', false)).toBe(false);
    expect(offersUnscored('granted', true)).toBe(false);
  });

  it('waits a few seconds, not a split second and not the 8 s position timeout', () => {
    expect(UNSCORED_OFFER_AFTER_MS).toBeGreaterThanOrEqual(2_000);
    expect(UNSCORED_OFFER_AFTER_MS).toBeLessThan(8_000);
  });
});

describe('check-in copy', () => {
  it('every phase line exists in both catalogues', () => {
    for (const [locale, messages] of [
      ['bg', bg],
      ['en', en],
    ] as const) {
      const checkin = messages.Checkin as Record<string, unknown>;
      for (const key of Object.values(PHASE_KEYS)) {
        expect(typeof checkin[key], `${locale} Checkin.${key}`).toBe('string');
      }
      expect(typeof checkin.submitWithoutLocation, `${locale} submitWithoutLocation`).toBe(
        'string',
      );
    }
  });
});
