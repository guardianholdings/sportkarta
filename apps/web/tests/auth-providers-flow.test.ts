import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveSignInProviders, type AuthEnv } from '@/lib/auth-config';
import { authOptions } from '@/lib/auth-options';
import { APPLE_ORIGIN } from '@/lib/auth-providers';
import { OTP_TTL_SECONDS } from '@/lib/auth-surface';

/**
 * The sign-in flows end to end, through the same options production runs
 * (lib/auth-options.ts) with better-auth's in-memory adapter in place of
 * Postgres. Google's, Apple's and Meta's servers are the only fakes: their
 * token and profile endpoints answer from the stub below, so the state cookie,
 * the callback route, the linking rules and our hooks are all the real thing.
 */

const BASE = 'http://localhost:3000';
const ENV: AuthEnv = {
  AUTH_GOOGLE_ENABLED: 'true',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  AUTH_APPLE_ENABLED: 'true',
  APPLE_CLIENT_ID: 'bg.pops.web',
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_KEY_ID: 'KEY1234567',
  // A throwaway key per run: no key material lives in the repo.
  APPLE_PRIVATE_KEY: generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString(),
  AUTH_FACEBOOK_ENABLED: 'true',
  FACEBOOK_CLIENT_ID: 'facebook-client',
  FACEBOOK_CLIENT_SECRET: 'facebook-secret',
};

function makeAuth() {
  const log = vi.fn();
  const auth = betterAuth(
    authOptions({
      secret: randomBytes(32).toString('hex'),
      baseURL: BASE,
      // Our table names, as production's drizzle schema has them.
      database: memoryAdapter({ users: [], sessions: [], accounts: [], verifications: [] }),
      providers: resolveSignInProviders(ENV),
      trustedProxies: [],
      log,
      afterSessionCreated: () => Promise.resolve(),
    }),
  );
  return { auth, log };
}
type Auth = ReturnType<typeof makeAuth>['auth'];

/** What the fake Google, Apple and Meta say about the visitor on the next callback. */
interface ProviderProfile {
  id: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
}
let google: ProviderProfile;
let apple: ProviderProfile;
let facebook: ProviderProfile;
/** Every client secret Apple's token endpoint received, in order. */
let appleClientSecrets: string[];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function unsignedJwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(payload)}.`;
}

function formBody(body: unknown): URLSearchParams {
  if (body instanceof URLSearchParams) return body;
  return new URLSearchParams(typeof body === 'string' ? body : '');
}

beforeEach(() => {
  google = { id: 'google-1', email: 'member@example.org', emailVerified: true, name: 'Real Name' };
  // „Hide My Email“: a relay address, which is just an address.
  apple = { id: 'apple-1', email: 'x7k2p9q4mz@privaterelay.appleid.com', emailVerified: true };
  facebook = { id: 'facebook-1', email: 'member@example.org', name: 'Real Name' };
  appleClientSecrets = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://appleid.apple.com/auth/token')) {
      appleClientSecrets.push(formBody(init?.body).get('client_secret') ?? '');
      const now = Math.floor(Date.now() / 1000);
      return Promise.resolve(
        json({
          access_token: 'apple-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: unsignedJwt({
            iss: 'https://appleid.apple.com',
            aud: ENV.APPLE_CLIENT_ID,
            sub: apple.id,
            email: apple.email,
            // Apple sends these as strings.
            email_verified: String(apple.emailVerified),
            is_private_email: 'true',
            iat: now,
            exp: now + 3600,
          }),
        }),
      );
    }
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const now = Math.floor(Date.now() / 1000);
      return Promise.resolve(
        json({
          access_token: 'google-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid email profile',
          id_token: unsignedJwt({
            iss: 'https://accounts.google.com',
            aud: ENV.GOOGLE_CLIENT_ID,
            sub: google.id,
            email: google.email,
            email_verified: google.emailVerified,
            name: google.name,
            picture: 'https://lh3.example/photo.jpg',
            iat: now,
            exp: now + 3600,
          }),
        }),
      );
    }
    if (url.startsWith('https://graph.facebook.com/v24.0/oauth/access_token')) {
      return Promise.resolve(
        json({ access_token: 'facebook-access-token', token_type: 'bearer', expires_in: 3600 }),
      );
    }
    if (url.startsWith('https://graph.facebook.com/debug_token')) {
      // Meta confirms the token is valid, for our app, and whose it is.
      return Promise.resolve(
        json({
          data: { is_valid: true, app_id: ENV.FACEBOOK_CLIENT_ID, user_id: facebook.id },
        }),
      );
    }
    if (url.startsWith('https://graph.facebook.com/me')) {
      return Promise.resolve(
        json({
          id: facebook.id,
          name: facebook.name,
          ...(facebook.email ? { email: facebook.email } : {}),
          picture: { data: { url: 'https://fb.example/photo.jpg' } },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch in a sign-in test: ${url}`));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** `name=value` pairs from Set-Cookie headers, as a browser would send them back. */
function cookiesFrom(headers: Headers, previous = ''): string {
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
async function providerSignIn(auth: Auth, provider: 'google' | 'facebook', cookie = '') {
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

async function codeSignIn(auth: Auth, email: string) {
  const otp = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
  return auth.api.signInEmailOTP({ body: { email, otp }, returnHeaders: true });
}

/**
 * The session as the database has it. The 5-minute signed cookie cache is
 * skipped on purpose: it is what lets a revoked session linger for up to five
 * minutes (lib/auth-options.ts), and these tests are about the revocation.
 */
async function sessionUser(auth: Auth, cookie: string) {
  const session = await auth.api.getSession({
    headers: new Headers({ cookie }),
    query: { disableCookieCache: true },
  });
  return session?.user ?? null;
}

async function linksOf(auth: Auth, userId: string) {
  const context = await auth.$context;
  return (await context.internalAdapter.findAccounts(userId)).map((link) => link.providerId);
}

describe('the email code', () => {
  it('only the newest code works', async () => {
    const { auth } = makeAuth();
    const email = 'member@example.org';
    const first = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
    let second = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
    while (second === first) {
      second = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
    }

    await expect(auth.api.signInEmailOTP({ body: { email, otp: first } })).rejects.toThrow();
    const signedIn = await auth.api.signInEmailOTP({ body: { email, otp: second } });
    expect(signedIn.user.email).toBe(email);
  });

  it(`stays valid for ${OTP_TTL_SECONDS / 60} minutes and not a minute longer`, async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { auth } = makeAuth();
    const email = 'slow-mail@example.org';

    const late = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
    vi.setSystemTime(Date.now() + (OTP_TTL_SECONDS - 60) * 1000);
    expect((await auth.api.signInEmailOTP({ body: { email, otp: late } })).user.email).toBe(email);

    const expired = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
    vi.setSystemTime(Date.now() + (OTP_TTL_SECONDS + 60) * 1000);
    await expect(auth.api.signInEmailOTP({ body: { email, otp: expired } })).rejects.toThrow();
  });
});

describe('one person, one account', () => {
  it('signs a Google sign-in with the same verified address into the code account', async () => {
    const { auth } = makeAuth();
    const viaCode = await codeSignIn(auth, 'member@example.org');

    const viaGoogle = await providerSignIn(auth, 'google');
    expect(viaGoogle.location).toBe('/profil');
    const user = await sessionUser(auth, viaGoogle.cookie);
    expect(user?.id).toBe(viaCode.response.user.id);
    expect(await linksOf(auth, viaCode.response.user.id)).toContain('google');
  });

  it('keeps no provider token and copies neither the name nor the photo', async () => {
    const { auth } = makeAuth();
    const { cookie } = await providerSignIn(auth, 'google');
    const user = await sessionUser(auth, cookie);
    if (!user) throw new Error('Google sign-in made no session');
    expect(user.name).toBe('');
    expect(user.image ?? null).toBeNull();

    const context = await auth.$context;
    const [link] = await context.internalAdapter.findAccounts(user.id);
    expect(link).toMatchObject({ providerId: 'google', accountId: 'google-1' });
    expect(link?.accessToken ?? null).toBeNull();
    expect(link?.refreshToken ?? null).toBeNull();
    expect(link?.idToken ?? null).toBeNull();
  });

  it('never links on an address the provider has not verified', async () => {
    const { auth } = makeAuth();
    const viaCode = await codeSignIn(auth, 'member@example.org');
    google.emailVerified = false;

    const attempt = await providerSignIn(auth, 'google');
    expect(attempt.location).toContain('/vhod?provider=google');
    expect(attempt.location).toContain('error=account_not_linked');
    expect(await sessionUser(auth, attempt.cookie)).toBeNull();
    expect(await linksOf(auth, viaCode.response.user.id)).not.toContain('google');
  });

  it('never merges Facebook into an existing account — decision (a)', async () => {
    const { auth } = makeAuth();
    const viaCode = await codeSignIn(auth, 'member@example.org');

    const attempt = await providerSignIn(auth, 'facebook');
    expect(attempt.location).toContain('/vhod?provider=facebook');
    expect(attempt.location).toContain('error=account_not_linked');
    expect(await sessionUser(auth, attempt.cookie)).toBeNull();
    expect(await linksOf(auth, viaCode.response.user.id)).toEqual([]);
  });

  it('opens no account for a Facebook profile without an address', async () => {
    const { auth } = makeAuth();
    facebook.email = undefined;

    const attempt = await providerSignIn(auth, 'facebook');
    expect(attempt.location).toContain('/vhod?provider=facebook');
    expect(attempt.location).toContain('error=email_not_found');
    expect(await sessionUser(auth, attempt.cookie)).toBeNull();
  });
});

describe('the pre-hijack case', () => {
  it('a stranger’s Facebook link dies when the real owner signs in with a code', async () => {
    const { auth, log } = makeAuth();
    // A stranger opens an account through Facebook with an address they do not own.
    facebook.email = 'victim@example.org';
    const stranger = await providerSignIn(auth, 'facebook');
    expect(stranger.location).toBe('/profil');
    const planted = await sessionUser(auth, stranger.cookie);
    if (!planted) throw new Error('the Facebook sign-up made no session');
    expect(planted.emailVerified).toBe(false);
    expect(await linksOf(auth, planted.id)).toEqual(['facebook']);

    // The owner signs in with an email code: same account, now proven. (The
    // sign-in response carries the user as it was read before the update, so
    // the stored row is what is checked.)
    const owner = await codeSignIn(auth, 'victim@example.org');
    expect(owner.response.user.id).toBe(planted.id);
    const context = await auth.$context;
    expect((await context.internalAdapter.findUserById(planted.id))?.emailVerified).toBe(true);

    // The Facebook link is gone, and so is the stranger's session...
    expect(await linksOf(auth, planted.id)).toEqual([]);
    expect(await sessionUser(auth, stranger.cookie)).toBeNull();
    // ...and Facebook cannot get back in: the address now has a profile.
    const retry = await providerSignIn(auth, 'facebook');
    expect(retry.location).toContain('error=account_not_linked');
    expect(await sessionUser(auth, retry.cookie)).toBeNull();
    // The owner's own session survives, and the log names no one.
    const ownerCookie = cookiesFrom(owner.headers);
    expect((await sessionUser(auth, ownerCookie))?.id).toBe(planted.id);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('dropped 1 unproven provider link');
    expect(logged).not.toContain('victim@example.org');
  });

  it('leaves a verified account’s links alone on a code sign-in', async () => {
    const { auth } = makeAuth();
    const viaGoogle = await providerSignIn(auth, 'google');
    const user = await sessionUser(auth, viaGoogle.cookie);
    if (!user) throw new Error('Google sign-in made no session');
    expect(user.emailVerified).toBe(true);

    await codeSignIn(auth, 'member@example.org');
    expect(await linksOf(auth, user.id)).toEqual(['google']);
    expect((await sessionUser(auth, viaGoogle.cookie))?.id).toBe(user.id);
  });
});

/**
 * Sign in with Apple the way Apple does it: the visitor comes back by a
 * cross-site form POST (response_mode=form_post), which carries no Lax
 * cookie; better-auth answers it with a redirect to the same callback as a GET,
 * and that request does carry the state cookie.
 */
async function appleSignIn(auth: Auth) {
  const started = await auth.api.signInSocial({
    body: { provider: 'apple', callbackURL: '/profil', errorCallbackURL: '/vhod?provider=apple' },
    returnHeaders: true,
  });
  const state = new URL(started.response.url ?? '').searchParams.get('state') ?? '';
  const jar = cookiesFrom(started.headers);
  const posted = await auth.handler(
    new Request(`${BASE}/api/auth/callback/apple`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APPLE_ORIGIN },
      body: new URLSearchParams({ code: 'test-code', state }).toString(),
    }),
  );
  const back = posted.headers.get('location') ?? '';
  const response = await auth.handler(
    new Request(new URL(back, BASE), { headers: { cookie: jar } }),
  );
  return {
    postStatus: posted.status,
    back,
    location: response.headers.get('location') ?? '',
    cookie: cookiesFrom(response.headers, jar),
  };
}

function claimsOf(jwt: string | undefined): { iat: number; exp: number; sub: string } {
  return JSON.parse(Buffer.from(jwt?.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
    iat: number;
    exp: number;
    sub: string;
  };
}

describe('Sign in with Apple', () => {
  it('comes back by form POST, signs in, and treats a relay address as an address', async () => {
    const { auth } = makeAuth();
    const signedIn = await appleSignIn(auth);

    expect(signedIn.postStatus).toBe(302);
    expect(signedIn.back).toContain('/api/auth/callback/apple?');
    expect(signedIn.location).toBe('/profil');
    const user = await sessionUser(auth, signedIn.cookie);
    expect(user?.email).toBe(apple.email);
    expect(user?.emailVerified).toBe(true);
  });

  it('sends Apple a client secret minted at the time of each token request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { auth } = makeAuth();

    await appleSignIn(auth);
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);
    await appleSignIn(auth);

    expect(appleClientSecrets).toHaveLength(2);
    const [first, second] = appleClientSecrets.map(claimsOf);
    expect(first?.sub).toBe(ENV.APPLE_CLIENT_ID);
    // Two hours apart, two secrets: the second was signed then, not at boot.
    expect((second?.iat ?? 0) - (first?.iat ?? 0)).toBeGreaterThanOrEqual(2 * 60 * 60);
    expect((second?.exp ?? 0) * 1000).toBeGreaterThan(Date.now());
  });
});
