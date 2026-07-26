import { describe, expect, it } from 'vitest';

import bg from '../messages/bg.json';
import en from '../messages/en.json';
import { addedPoints, addedRedirectValue } from '../lib/contributions/added-banner';

/**
 * A2 ("show the number") — docs/ENGAGEMENT-IMPLEMENTATION.md Phase 1.
 *
 * Two contribution flows told a member they had earned points without ever
 * saying how many: the QR check-in ("Получихте точки.", though the action had
 * `pointsAwarded` in hand) and adding a facility, which is the LARGEST award on
 * the platform and acknowledged nothing at all — the action redirected with a
 * bare `?added=1` that no page read, because /obekt/[slug] declared no
 * searchParams.
 *
 * These tests pin the two properties that make the fix honest rather than
 * decorative: the copy actually carries a number, and a forged query parameter
 * cannot make it say something absurd.
 */

type Messages = typeof bg;

/** Every message that promises a figure, and must therefore interpolate one. */
const NUMBER_BEARING: { path: string; read: (m: Messages) => string }[] = [
  { path: 'Checkin.outcome.scored', read: (m) => m.Checkin.outcome.scored },
  { path: 'Contribute.thanksWithPoints', read: (m) => m.Contribute.thanksWithPoints },
];

describe('points feedback — the copy names a figure', () => {
  for (const { path, read } of NUMBER_BEARING) {
    it(`${path} interpolates {points} in both catalogues`, () => {
      for (const [locale, messages] of [
        ['bg', bg],
        ['en', en],
      ] as const) {
        expect(
          read(messages as Messages),
          `${locale}.json ${path} must contain the {points} placeholder — without it the ` +
            'member is told they earned points but never how many, which is the exact ' +
            'gap A2 exists to close.',
        ).toContain('{points}');
      }
    });
  }

  it('the check-in success line is not the placeholder-free wording it replaced', () => {
    // Guards the specific regression: "you received points" with no figure.
    expect(bg.Checkin.outcome.scored).not.toBe('Присъствието е записано. Получихте точки.');
  });

  it('outcomes that award nothing do NOT promise a figure', () => {
    // The anti-abuse layer never refuses a check-in, so an unscored attendance
    // is a recorded fact, not a failure. None of these may imply a payment.
    const unscored = [
      bg.Checkin.outcome.unscored_method,
      bg.Checkin.outcome.unscored_no_location,
      bg.Checkin.outcome.unscored_out_of_range,
      bg.Checkin.outcome.unscored_daily_cap,
      bg.Checkin.outcome.unscored_already,
    ];
    for (const line of unscored) expect(line).not.toContain('{points}');
  });
});

describe('addedPoints — a forgeable query parameter', () => {
  it('accepts the real award', () => {
    expect(addedPoints('10')).toBe(10);
  });

  it('treats absent, empty and non-string as nothing to celebrate', () => {
    expect(addedPoints(undefined)).toBeNull();
    expect(addedPoints('')).toBeNull();
    expect(addedPoints('   ')).toBeNull();
    // Next gives an array when the key repeats: /obekt/x?added=10&added=99
    expect(addedPoints(['10', '99'])).toBeNull();
  });

  it('never renders a zero', () => {
    // An add that awarded nothing is real — the ledger's idempotency key had
    // already paid for this facility. "+0" would read as a penalty.
    expect(addedPoints('0')).toBeNull();
    expect(addedPoints('-5')).toBeNull();
  });

  it('clamps to the points_ledger CHECK bound, so a crafted value cannot lie', () => {
    expect(addedPoints('101')).toBeNull();
    expect(addedPoints('999999')).toBeNull();
    expect(addedPoints('100')).toBe(100);
    expect(addedPoints('1')).toBe(1);
  });

  it('rejects anything that is not a literal run of digits', () => {
    // Number() accepts far more than "an integer": '0x0A', '1e1' and ' 10 ' all
    // coerce to 10. The parser matches digits instead, so the accepted set is
    // exactly the documented one.
    for (const bad of ['1.5', 'abc', '1e1', 'NaN', 'Infinity', '0x0A', '10 ', ' 10', '+10', '-10']) {
      expect(addedPoints(bad), `${bad} should not be accepted`).toBeNull();
    }
  });
});

describe('addedRedirectValue — what the action puts in the URL', () => {
  it('is the real ledger award, not a literal', () => {
    // Read from POINTS_BY_EVENT so the banner cannot drift from what was paid.
    expect(addedRedirectValue(true)).toBe(10);
  });

  it('is zero when the ledger paid nothing, which addedPoints then hides', () => {
    expect(addedRedirectValue(false)).toBe(0);
    expect(addedPoints(String(addedRedirectValue(false)))).toBeNull();
  });

  it('round-trips: what the action emits is what the page renders', () => {
    expect(addedPoints(String(addedRedirectValue(true)))).toBe(10);
  });
});
