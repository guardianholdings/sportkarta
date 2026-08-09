import { afterEach, describe, expect, it, vi } from 'vitest';

import { donationDetails } from '@/lib/donations';

/**
 * `/podkrepi`'s bank details (docs/MONETISATION.md S4).
 *
 * The property under test is FAIL CLOSED: a half-configured or malformed
 * environment must yield `null` — the page then asks visitors to write in for
 * bank details — rather than rendering an account number a transfer would
 * bounce off. And the warning must never carry the value, because a donation
 * IBAN in a log aggregator is exactly the kind of thing "no PII in logs" exists
 * to keep out of one.
 */

const IBAN = 'BG18RZBB91550123456789';

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

describe('donationDetails', () => {
  it('is absent, not an error, when nothing is configured', () => {
    const warn = quiet();
    expect(donationDetails({})).toBeNull();
    // Unconfigured is the default state of a fresh checkout: no noise.
    expect(warn).not.toHaveBeenCalled();
  });

  it('normalises a spaced, lowercase IBAN into the form a banking app accepts', () => {
    const details = donationDetails({
      DONATION_IBAN: ' bg18 rzbb 9155 0123 4567 89 ',
      DONATION_BENEFICIARY: '  Сдружение СпортКарта  ',
    });
    expect(details).toMatchObject({ iban: IBAN, beneficiary: 'Сдружение СпортКарта' });
  });

  it('refuses to render an IBAN it cannot recognise', () => {
    const warn = quiet();
    for (const bad of ['not-an-iban', '0888123456', 'BG18', 'BGXX91550123456789']) {
      expect(donationDetails({ DONATION_IBAN: bad, DONATION_BENEFICIARY: 'X' })).toBeNull();
    }
    expect(warn).toHaveBeenCalled();
  });

  it('refuses an IBAN with no account holder — that transfer comes back', () => {
    const warn = quiet();
    expect(donationDetails({ DONATION_IBAN: IBAN })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('never puts the value in the warning', () => {
    const warn = quiet();
    // Malformed (so it warns) and recognisable (so a leak would be visible).
    donationDetails({ DONATION_IBAN: 'my-SECRET-account', DONATION_BENEFICIARY: 'X' });
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('DONATION_IBAN');
    expect(logged).not.toContain('SECRET');
  });

  it('drops a malformed BIC without losing the IBAN', () => {
    const warn = quiet();
    const details = donationDetails({
      DONATION_IBAN: IBAN,
      DONATION_BENEFICIARY: 'X',
      DONATION_BIC: 'nope',
    });
    // The transfer works without a BIC inside the EU, so a bad one degrades.
    expect(details?.iban).toBe(IBAN);
    expect(details?.bic).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('accepts a lowercase spaced BIC', () => {
    expect(
      donationDetails({
        DONATION_IBAN: IBAN,
        DONATION_BENEFICIARY: 'X',
        DONATION_BIC: 'rzbb bgsf',
      })?.bic,
    ).toBe('RZBBBGSF');
  });

  it('takes an https payment link and rejects anything else', () => {
    const warn = quiet();
    const base = { DONATION_IBAN: IBAN, DONATION_BENEFICIARY: 'X' };
    expect(
      donationDetails({ ...base, DONATION_PAYMENT_URL: 'https://pay.example.org/skarta' })
        ?.paymentUrl,
    ).toBe('https://pay.example.org/skarta');
    for (const bad of [
      'http://pay.example.org',
      'javascript:alert(1)',
      `https://pay.example.org/${'x'.repeat(300)}`,
    ]) {
      expect(donationDetails({ ...base, DONATION_PAYMENT_URL: bad })?.paymentUrl).toBeNull();
    }
    expect(warn).toHaveBeenCalled();
  });

  it('defaults to bank transfer only — no payment link unless one is configured', () => {
    expect(
      donationDetails({ DONATION_IBAN: IBAN, DONATION_BENEFICIARY: 'X' })?.paymentUrl,
    ).toBeNull();
  });

  it('carries an optional transfer reference, bounded in length', () => {
    const base = { DONATION_IBAN: IBAN, DONATION_BENEFICIARY: 'X' };
    expect(donationDetails({ ...base, DONATION_REFERENCE: 'дарение' })?.reference).toBe('дарение');
    quiet();
    expect(donationDetails({ ...base, DONATION_REFERENCE: 'x'.repeat(61) })?.reference).toBeNull();
  });
});
