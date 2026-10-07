import { DisabledMailer } from '@sportkarta/lib/email';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deliverSignInCode, type SignInCodeOutcome } from '@/lib/sign-in-code';

/**
 * The sign-in server action, with only the framework and better-auth mocked:
 * the limiters, the destination rules and the mail delivery are the real ones.
 */
const h = vi.hoisted(() => {
  // Read once, when lib/auth-rate-limit.ts builds its limiters.
  process.env.OTP_SEND_LIMIT_PER_HOUR = '5';
  class Redirected extends Error {
    constructor(readonly target: unknown) {
      super('NEXT_REDIRECT');
    }
  }
  return {
    Redirected,
    ip: '203.0.113.1',
    locale: 'bg',
    signInEmailOTP: vi.fn<(args: unknown) => Promise<unknown>>(),
    signOut: vi.fn<(args: unknown) => Promise<unknown>>(),
    sendSignInCode: vi.fn<(email: string, locale: string) => Promise<SignInCodeOutcome>>(),
  };
});

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ 'x-forwarded-for': h.ip })),
}));
vi.mock('next/navigation', () => ({
  redirect: (target: unknown) => {
    throw new h.Redirected(target);
  },
}));
vi.mock('next-intl/server', () => ({ getLocale: () => Promise.resolve(h.locale) }));
vi.mock('@/i18n/navigation', () => ({
  redirect: (target: unknown) => {
    throw new h.Redirected(target);
  },
  getPathname: ({ href, locale }: { href: string; locale: string }) =>
    locale === 'bg' ? href : `/${locale}${href}`,
}));
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({ api: { signInEmailOTP: h.signInEmailOTP, signOut: h.signOut } }),
  sendSignInCode: (email: string, locale: string) => h.sendSignInCode(email, locale),
}));

const { signInAction, signOutAction } = await import('@/app/[locale]/vhod/actions');

const START = { step: 'email', email: '', error: null } as const;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function requestCode(email: string, locale = 'bg') {
  return signInAction(START, form({ step: 'email', email, locale }));
}

function enterCode(email: string, code = '000000', extra: Record<string, string> = {}) {
  return signInAction(START, form({ step: 'code', email, code, locale: 'bg', ...extra }));
}

async function redirectTarget(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof h.Redirected) return error.target;
    throw error;
  }
  throw new Error('expected a redirect');
}

let ipCounter = 0;
/** A fresh client address, so tests do not share per-IP allowances. */
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${String(ipCounter)}`;
}

beforeEach(() => {
  h.ip = freshIp();
  h.locale = 'bg';
  h.signInEmailOTP.mockReset().mockRejectedValue(new Error('INVALID_OTP'));
  h.sendSignInCode.mockReset().mockResolvedValue('sent');
  // Quiet: the action's own log lines are not what these tests are about.
  vi.spyOn(console, 'error').mockImplementation(vi.fn());
  vi.spyOn(console, 'warn').mockImplementation(vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requesting a code', () => {
  it('says so when the mail could not be sent, instead of «code sent»', async () => {
    h.sendSignInCode.mockImplementation((email, locale) =>
      deliverSignInCode({
        email,
        issueCode: () => Promise.resolve('123456'),
        locale,
        mailer: new DisabledMailer('SMTP_HOST is unset'),
        log: vi.fn(),
        verboseErrors: false,
      }),
    );
    expect(await requestCode('nomail@example.org')).toEqual({
      step: 'email',
      email: 'nomail@example.org',
      error: 'mail_unavailable',
    });
  });

  it('mails the code in the language of the form', async () => {
    expect(await requestCode('english@example.org', 'en')).toEqual({
      step: 'code',
      email: 'english@example.org',
      error: null,
    });
    expect(h.sendSignInCode).toHaveBeenCalledWith('english@example.org', 'en');
  });

  it('stops minting codes once the site-wide hourly cap is spent', async () => {
    // Every request from its own host and address, so only the global cap can
    // refuse. Earlier tests may already have used some of the five.
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      h.ip = freshIp();
      results.push(await requestCode(`flood-${String(i)}@example.org`));
    }
    const refused = results.filter((result) => result.error === 'mail_unavailable');
    expect(refused.length).toBeGreaterThan(0);
    // Refused before a code was minted or a mail attempted.
    expect(h.sendSignInCode).toHaveBeenCalledTimes(results.length - refused.length);
    expect(results.at(-1)?.error).toBe('mail_unavailable');
  });
});

describe('entering a code', () => {
  it('caps wrong codes per address, so fresh codes do not buy fresh guesses', async () => {
    const email = 'target@example.org';
    for (let i = 0; i < 10; i += 1) {
      h.ip = freshIp();
      expect((await enterCode(email)).error).toBe('invalid_code');
    }
    h.ip = freshIp();
    expect(await enterCode(email)).toEqual({ step: 'code', email, error: 'verify_throttled' });
    // The eleventh guess never reached better-auth.
    expect(h.signInEmailOTP).toHaveBeenCalledTimes(10);
  });

  it('caps wrong codes per IP across addresses', async () => {
    for (let i = 0; i < 30; i += 1) {
      expect((await enterCode(`spray-${String(i)}@example.org`)).error).toBe('invalid_code');
    }
    expect((await enterCode('spray-last@example.org')).error).toBe('verify_throttled');
  });

  it('does not count a correct code against the member', async () => {
    const email = 'regular@example.org';
    for (let i = 0; i < 9; i += 1) await enterCode(email);
    h.signInEmailOTP.mockResolvedValueOnce({});
    await redirectTarget(enterCode(email, '123456'));
    // Nine failures on the books, not ten: one more wrong code is still heard.
    expect((await enterCode(email)).error).toBe('invalid_code');
    expect((await enterCode(email)).error).toBe('verify_throttled');
  });

  it('lands on the requested page, in the language of the form', async () => {
    h.signInEmailOTP.mockResolvedValue({});
    expect(
      await redirectTarget(
        enterCode('en-member@example.org', '123456', { locale: 'en', next: '/obekt/ndk' }),
      ),
    ).toEqual({ href: '/obekt/ndk', locale: 'en' });
    // A prefix on `next` does not override the language the member signed in with.
    expect(
      await redirectTarget(
        enterCode('bg-member@example.org', '123456', { locale: 'bg', next: '/en/trenirovki' }),
      ),
    ).toEqual({ href: '/trenirovki', locale: 'bg' });
  });

  it('falls back to the profile, localised, when next is missing or hostile', async () => {
    h.signInEmailOTP.mockResolvedValue({});
    expect(
      await redirectTarget(
        enterCode('fallback@example.org', '123456', { locale: 'en', next: '/en//evil.example' }),
      ),
    ).toEqual({ href: '/profil', locale: 'en' });
  });
});

describe('signing out', () => {
  it('keeps the language the member was reading', async () => {
    h.locale = 'en';
    expect(await redirectTarget(signOutAction())).toEqual({ href: '/', locale: 'en' });
  });
});
