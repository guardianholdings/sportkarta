import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * providerSignInAction: the hand-off to Google, Apple or Facebook. Only the
 * framework and better-auth are mocked; the flags, the provider check and the
 * destination rules are the real ones.
 */
const h = vi.hoisted(() => {
  class Redirected extends Error {
    constructor(
      readonly target: unknown,
      readonly offSite: boolean,
    ) {
      super('NEXT_REDIRECT');
    }
  }
  return {
    Redirected,
    signInSocial: vi.fn<(args: { body: Record<string, unknown> }) => Promise<{ url?: string }>>(),
  };
});

type Href = string | { pathname: string; query?: Record<string, string> };

vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock('next/navigation', () => ({
  redirect: (target: unknown) => {
    throw new h.Redirected(target, true);
  },
}));
vi.mock('next-intl/server', () => ({ getLocale: () => Promise.resolve('bg') }));
vi.mock('@/i18n/navigation', () => ({
  redirect: (target: unknown) => {
    throw new h.Redirected(target, false);
  },
  // next-intl's own rule: the default locale has no prefix; `query` is serialised.
  getPathname: ({ href, locale }: { href: Href; locale: string }) => {
    const path =
      typeof href === 'string'
        ? href
        : `${href.pathname}${href.query ? `?${new URLSearchParams(href.query).toString()}` : ''}`;
    return locale === 'bg' ? path : `/${locale}${path}`;
  },
}));
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({ api: { signInSocial: h.signInSocial } }),
  sendSignInCode: vi.fn(),
}));

const { providerSignInAction } = await import('@/app/[locale]/vhod/actions');

const FLAGS = {
  AUTH_GOOGLE_ENABLED: 'true',
  GOOGLE_CLIENT_ID: 'g-id',
  GOOGLE_CLIENT_SECRET: 'g-secret',
} as const;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function outcome(fields: Record<string, string>) {
  try {
    await providerSignInAction(form(fields));
  } catch (error) {
    if (error instanceof h.Redirected) return error;
    throw error;
  }
  throw new Error('expected a redirect');
}

beforeEach(() => {
  Object.assign(process.env, FLAGS);
  h.signInSocial.mockResolvedValue({ url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' });
});

afterEach(() => {
  delete process.env.AUTH_GOOGLE_ENABLED;
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  h.signInSocial.mockReset();
});

describe('providerSignInAction', () => {
  it('hands the visitor to the provider, with a way back for success and for failure', async () => {
    const result = await outcome({ provider: 'google', locale: 'bg', next: '/profil' });

    expect(result.offSite).toBe(true);
    expect(result.target).toBe('https://accounts.google.com/o/oauth2/v2/auth?state=s');
    const body = h.signInSocial.mock.calls[0]?.[0].body;
    expect(body?.provider).toBe('google');
    expect(body?.callbackURL).toBe('/profil');
    // /vhod names the provider, and better-auth appends &error=<code>.
    expect(String(body?.errorCallbackURL)).toMatch(/^\/vhod\?/);
    expect(new URLSearchParams(String(body?.errorCallbackURL).split('?')[1]).get('provider')).toBe(
      'google',
    );
  });

  it('brings an English visitor back to the English pages', async () => {
    await outcome({ provider: 'google', locale: 'en', next: '/profil' });
    const body = h.signInSocial.mock.calls[0]?.[0].body;
    expect(body?.callbackURL).toBe('/en/profil');
    expect(String(body?.errorCallbackURL)).toMatch(/^\/en\/vhod\?/);
  });

  it('never sends the visitor off-site afterwards, whatever `next` says', async () => {
    await outcome({ provider: 'google', locale: 'bg', next: 'https://evil.example/' });
    const body = h.signInSocial.mock.calls[0]?.[0].body;
    expect(String(body?.callbackURL)).toMatch(/^\//);
    expect(JSON.stringify(body)).not.toContain('evil.example');
  });

  it('refuses a provider that is off, or not one of ours, before calling better-auth', async () => {
    for (const provider of ['apple', 'facebook', 'github', '']) {
      const result = await outcome({ provider, locale: 'bg' });
      expect(result.offSite).toBe(false);
      expect(result.target).toEqual({ href: '/vhod', locale: 'bg' });
    }
    delete process.env.AUTH_GOOGLE_ENABLED;
    expect((await outcome({ provider: 'google', locale: 'bg' })).target).toEqual({
      href: '/vhod',
      locale: 'bg',
    });
    expect(h.signInSocial).not.toHaveBeenCalled();
  });
});
