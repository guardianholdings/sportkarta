import type { Auth } from 'better-auth';

import type { authOptions } from '@/lib/auth-options';

/**
 * Sign-in steps shared by the flow tests (tests/auth-providers-flow.test.ts,
 * better-auth's in-memory adapter) and the session-revocation journey
 * (tests/journeys/session-revocation.test.ts, Postgres). Both drive a
 * better-auth built from lib/auth-options.ts, so these take either instance.
 */

/** better-auth as lib/auth-options.ts configures it, whatever the database. */
export type AuthUnderTest = Auth<ReturnType<typeof authOptions>>;

/** The base URL both suites build better-auth with. */
export const BASE = 'http://localhost:3000';

/** `name=value` pairs from Set-Cookie headers, as a browser would send them back. */
export function cookiesFrom(headers: Headers, previous = ''): string {
  const jar = new Map(
    previous
      .split('; ')
      .filter(Boolean)
      .map((pair) => [pair.split('=')[0] ?? '', pair] as const),
  );
  for (const line of headers.getSetCookie()) {
    const pair = line.split(';')[0] ?? '';
    const name = pair.split('=')[0] ?? '';
    if (pair.endsWith('=') || /max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, pair);
  }
  return [...jar.values()].join('; ');
}

/** Start a provider sign-in, come back through the real callback route. */
export async function providerSignIn(
  auth: AuthUnderTest,
  provider: 'google' | 'facebook',
  cookie = '',
) {
  const started = await auth.api.signInSocial({
    body: {
      provider,
      callbackURL: '/profil',
      errorCallbackURL: `/vhod?provider=${provider}`,
    },
    headers: new Headers(cookie ? { cookie } : {}),
    returnHeaders: true,
  });
  const authorize = new URL(started.response.url ?? '');
  const state = authorize.searchParams.get('state') ?? '';
  const withState = cookiesFrom(started.headers, cookie);
  const response = await auth.handler(
    new Request(`${BASE}/api/auth/callback/${provider}?code=test-code&state=${state}`, {
      headers: { cookie: withState },
    }),
  );
  return {
    location: response.headers.get('location') ?? '',
    cookie: cookiesFrom(response.headers, withState),
  };
}

export async function codeSignIn(auth: AuthUnderTest, email: string) {
  const otp = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
  return auth.api.signInEmailOTP({ body: { email, otp }, returnHeaders: true });
}
