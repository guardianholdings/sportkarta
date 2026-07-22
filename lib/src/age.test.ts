import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  completedYears,
  civilToday,
  deriveIsMinor,
  InvalidDateOfBirthError,
  MINOR_AGE,
} from './age.js';

/** A UTC instant that is unambiguously the given Sofia civil day (midday). */
function sofiaNoon(iso: string): Date {
  return new Date(`${iso}T09:00:00Z`);
}

describe('civilToday', () => {
  it('uses Europe/Sofia, not the server timezone', () => {
    // 22:30 UTC on 2026-07-21 is already 2026-07-22 in Sofia (UTC+3 in summer).
    expect(civilToday(new Date('2026-07-21T22:30:00Z'))).toEqual({
      year: 2026,
      month: 7,
      day: 22,
    });
    // 22:30 UTC on 2026-01-21 is 2026-01-22 in Sofia (UTC+2 in winter).
    expect(civilToday(new Date('2026-01-21T22:30:00Z'))).toEqual({
      year: 2026,
      month: 1,
      day: 22,
    });
  });
});

describe('deriveIsMinor', () => {
  it('is false from the 18th birthday onwards', () => {
    expect(deriveIsMinor('2008-07-22', sofiaNoon('2026-07-22'))).toBe(false);
    expect(deriveIsMinor('2008-07-23', sofiaNoon('2026-07-22'))).toBe(true);
    expect(deriveIsMinor('2008-07-21', sofiaNoon('2026-07-22'))).toBe(false);
  });

  it('treats 29 February birthdays as having a birthday on 1 March in common years', () => {
    expect(deriveIsMinor('2008-02-29', sofiaNoon('2026-02-28'))).toBe(true);
    expect(deriveIsMinor('2008-02-29', sofiaNoon('2026-03-01'))).toBe(false);
  });

  it('does not flip across the DST boundary', () => {
    // Sofia switches to summer time on the last Sunday of March at 03:00.
    const beforeSwitch = new Date('2026-03-29T00:30:00Z'); // 02:30 local
    const afterSwitch = new Date('2026-03-29T01:30:00Z'); // 04:30 local
    expect(deriveIsMinor('2008-03-29', beforeSwitch)).toBe(false);
    expect(deriveIsMinor('2008-03-29', afterSwitch)).toBe(false);
    expect(deriveIsMinor('2008-03-30', beforeSwitch)).toBe(true);
    expect(deriveIsMinor('2008-03-30', afterSwitch)).toBe(true);
  });

  it('rejects malformed, impossible, future and implausible dates', () => {
    const now = sofiaNoon('2026-07-22');
    for (const bad of ['', '22-07-2008', '2008/07/22', '2008-7-2', 'yesterday']) {
      expect(() => deriveIsMinor(bad, now)).toThrow(InvalidDateOfBirthError);
    }
    expect(() => deriveIsMinor('2025-02-30', now)).toThrow(InvalidDateOfBirthError);
    expect(() => deriveIsMinor('2027-01-01', now)).toThrow(InvalidDateOfBirthError);
    expect(() => deriveIsMinor('1800-01-01', now)).toThrow(InvalidDateOfBirthError);
  });

  it('never puts the rejected date into the error message', () => {
    try {
      deriveIsMinor('2099-12-31', sofiaNoon('2026-07-22'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(String(error)).not.toContain('2099');
    }
  });

  it('agrees with completedYears for any plausible birth date (property)', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('1930-01-01'), max: new Date('2026-07-22'), noInvalidDate: true }),
        (date) => {
          const iso = date.toISOString().slice(0, 10);
          const today = civilToday(sofiaNoon('2026-07-22'));
          const [year, month, day] = iso.split('-').map(Number) as [number, number, number];
          const age = completedYears({ year, month, day }, today);
          expect(deriveIsMinor(iso, sofiaNoon('2026-07-22'))).toBe(age < MINOR_AGE);
        },
      ),
    );
  });
});
