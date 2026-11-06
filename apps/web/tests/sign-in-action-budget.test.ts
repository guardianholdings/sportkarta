import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SignInCodeOutcome } from '@/lib/sign-in-code';

/**
 * The sign-in action against the daily mail budget (lib/mail-budget.ts): a
 * spent code share holds the request with the same «try later» answer as the
 * hourly cap, mints and mails nothing, and a send that fails gives its slot
 * back. Its own file, because the limiters are module singletons and
 * sign-in-action.test.ts deliberately spends the hourly cap.
 */
const h = vi.hoisted(() => {
  class Redirected extends Error {
    constructor(readonly target: unknown) {
      super('NEXT_REDIRECT');
    }
  }
  return {
    Redirected,
    ip: '203.0.113.9',
    reserve: vi.fn<() => Promise<{ release(): Promise<void> } | null>>(),
    release: vi.fn<() => Promise<void>>(),
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
vi.mock('next-intl/server', () => ({ getLocale: () => Promise.resolve('bg') }));
vi.mock('@/i18n/navigation', () => ({
  redirect: (target: unknown) => {
    throw new h.Redirected(target);
  },
  getPathname: ({ href }: { href: string }) => href,
}));
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({ api: { signInEmailOTP: vi.fn(), signOut: vi.fn() } }),
  sendSignInCode: (email: string, locale: string) => h.sendSignInCode(email, locale),
}));
vi.mock('@/lib/mail-budget', () => ({
  reserveSignInCodeMail: () => h.reserve(),
}));

const { signInAction } = await import('@/app/[locale]/vhod/actions');

const START = { step: 'email', email: '', error: null } as const;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

let ipCounter = 0;

beforeEach(() => {
  ipCounter += 1;
  h.ip = `198.51.100.${String(ipCounter)}`;
  h.release.mockReset().mockResolvedValue(undefined);
  h.reserve.mockReset().mockResolvedValue({ release: h.release });
  h.sendSignInCode.mockReset().mockResolvedValue('sent');
  vi.spyOn(console, 'error').mockImplementation(vi.fn());
  vi.spyOn(console, 'warn').mockImplementation(vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the sign-in code share', () => {
  it('holds a request once the share is spent: the «try later» answer, no code minted or mailed', async () => {
    h.reserve.mockResolvedValue(null);
    expect(await signInAction(START, form({ step: 'email', email: 'held@example.org' }))).toEqual({
      step: 'email',
      email: 'held@example.org',
      error: 'mail_unavailable',
    });
    expect(h.sendSignInCode).not.toHaveBeenCalled();
  });

  it('keeps a held RESEND on the code step, where the code already sent still works', async () => {
    h.reserve.mockResolvedValue(null);
    expect(
      await signInAction(
        { step: 'code', email: 'held@example.org', error: null },
        form({ step: 'code', resend: '1', email: 'held@example.org' }),
      ),
    ).toEqual({ step: 'code', email: 'held@example.org', error: 'mail_unavailable' });
    expect(h.sendSignInCode).not.toHaveBeenCalled();
  });

  it('spends the slot only on a code that went, and gives it back when the send failed', async () => {
    expect(await signInAction(START, form({ step: 'email', email: 'went@example.org' }))).toEqual({
      step: 'code',
      email: 'went@example.org',
      error: null,
    });
    expect(h.release).not.toHaveBeenCalled();

    h.sendSignInCode.mockResolvedValue('mail_unavailable');
    expect(await signInAction(START, form({ step: 'email', email: 'failed@example.org' }))).toEqual(
      { step: 'email', email: 'failed@example.org', error: 'mail_unavailable' },
    );
    expect(h.release).toHaveBeenCalledOnce();

    // A code that could not be minted sent nothing either.
    h.sendSignInCode.mockResolvedValue('unknown');
    await signInAction(START, form({ step: 'email', email: 'unminted@example.org' }));
    expect(h.release).toHaveBeenCalledTimes(2);
  });

  it('asks the budget only after the in-memory limiters have let the request through', async () => {
    // An address may ask for five codes per ten minutes; the sixth is throttled
    // before the budget is consulted, so a per-address flood costs no slot.
    for (let i = 0; i < 5; i += 1) {
      await signInAction(START, form({ step: 'email', email: 'eager@example.org' }));
    }
    expect(h.reserve).toHaveBeenCalledTimes(5);
    expect(
      await signInAction(START, form({ step: 'email', email: 'eager@example.org' })),
    ).toMatchObject({ error: 'throttled' });
    expect(h.reserve).toHaveBeenCalledTimes(5);
  });
});
