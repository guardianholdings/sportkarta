import { afterEach, describe, expect, it, vi } from 'vitest';

import { hasIdentity, organisation } from '@/lib/organisation';

/**
 * The controller identity on /kontakt, /privacy and /usloviya (pre-launch audit:
 * no page named a controller, an ЕИК, an address or a working inbox).
 *
 * The property under test is the one a legal page needs most: it may be
 * INCOMPLETE, but it may never be WRONG. So an unset value is absent, a
 * malformed one is dropped (never "fixed" into something plausible), nothing
 * is ever filled in with a placeholder, and the warning names the variable and
 * never the value.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

function quiet() {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined);
}

describe('organisation', () => {
  it('is entirely absent, silently, when nothing is configured', () => {
    const warn = quiet();
    expect(organisation({})).toEqual({
      legalName: null,
      eik: null,
      address: null,
      contactEmail: null,
    });
    expect(hasIdentity(organisation({}))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads every field as registered, trimming stray whitespace', () => {
    const org = organisation({
      ORG_LEGAL_NAME: '  Сдружение „Повече от просто спорт“ ',
      ORG_EIK: ' 123 456 789 ',
      ORG_ADDRESS: 'гр. София 1000,\n ул. „Примерна“ 1',
      CONTACT_EMAIL: ' hello@pops.bg ',
    });
    expect(org).toEqual({
      legalName: 'Сдружение „Повече от просто спорт“',
      eik: '123456789',
      address: 'гр. София 1000, ул. „Примерна“ 1',
      contactEmail: 'hello@pops.bg',
    });
    expect(hasIdentity(org)).toBe(true);
  });

  it('accepts a 13-digit branch number and drops a pasted VAT prefix', () => {
    quiet();
    expect(organisation({ ORG_EIK: '1234567890123' }).eik).toBe('1234567890123');
    expect(organisation({ ORG_EIK: 'BG123456789' }).eik).toBe('123456789');
  });

  it('drops a malformed ЕИК rather than printing a number nobody can look up', () => {
    const warn = quiet();
    expect(organisation({ ORG_EIK: '12345' }).eik).toBeNull();
    expect(organisation({ ORG_EIK: 'TBD' }).eik).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('drops a contact address that is not one, so no page links to a dead mailto', () => {
    const warn = quiet();
    for (const bad of ['TODO', 'hello@', 'hello@pops', 'a b@pops.bg', '"x"@pops.bg']) {
      expect(organisation({ CONTACT_EMAIL: bad }).contactEmail, bad).toBeNull();
    }
    expect(warn).toHaveBeenCalled();
  });

  it('keeps each field independent — one bad value hides only itself', () => {
    quiet();
    const org = organisation({
      ORG_LEGAL_NAME: 'Сдружение „Пример“',
      ORG_EIK: 'not-a-number',
      CONTACT_EMAIL: 'hello@pops.bg',
    });
    expect(org.legalName).toBe('Сдружение „Пример“');
    expect(org.eik).toBeNull();
    expect(org.contactEmail).toBe('hello@pops.bg');
  });

  it('never writes the value it refused into the log', () => {
    const warn = quiet();
    organisation({ CONTACT_EMAIL: 'secret-inbox@', ORG_EIK: '999' });
    const logged = warn.mock.calls.flat().join(' ');
    expect(logged).toContain('CONTACT_EMAIL');
    expect(logged).not.toContain('secret-inbox');
    expect(logged).not.toContain('999');
  });
});
