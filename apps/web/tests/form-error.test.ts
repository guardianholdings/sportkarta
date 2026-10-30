import { describe, expect, it, vi } from 'vitest';

import { formErrorText, isPlainCode } from '@/lib/clubs/form-error';
import { clubFormMessages } from '@/lib/clubs/form-labels';

vi.mock('server-only', () => ({}));
vi.mock('next-intl/server', () => ({
  getTranslations: async () => (key: string) => `t:${key}`,
  getMessages: async () => ({
    ClubForm: { error: { not_allowed: 'Нямате права.', rate_limited: 'Бавно.' } },
  }),
}));

/**
 * The form-error catalogue: pages read `?rezultat=` codes straight from the
 * URL, so an inherited name must miss like an unknown code — and the
 * catalogue must stay a PLAIN object, because it crosses into client
 * components and React refuses a null-prototype one (the member card crashed
 * on that). Both are asserted on what clubFormMessages() really returns.
 */
describe('the club form-error catalogue', () => {
  it('is a plain object a client component can receive', async () => {
    const messages = await clubFormMessages();
    expect(Object.getPrototypeOf(messages.errors)).toBe(Object.prototype);
    expect(structuredClone(messages)).toEqual(messages);
  });

  it('finds a code the catalogue has', async () => {
    const messages = await clubFormMessages();
    expect(formErrorText(messages, 'not_allowed')).toBe('t:error.not_allowed');
  });

  it('misses an unknown code, and an inherited name, like any unknown code', async () => {
    const messages = await clubFormMessages();
    for (const code of ['nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(formErrorText(messages, code)).toBe('t:genericError');
      expect(formErrorText(messages, code, null)).toBeNull();
    }
  });

  it('lets only plain codes reach a namespace lookup', () => {
    expect(isPlainCode('slot_taken')).toBe(true);
    for (const code of ['constructor', 'toString', '__proto__', 'Bad', '', 'a'.repeat(80)]) {
      expect(isPlainCode(code)).toBe(false);
    }
  });
});
