import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { revokeSessions } from '@/lib/account-controls';
import { requireAuth } from '@/lib/auth';
import { getCurrentUser } from '@/lib/auth-session';

import { sql } from '@sportkarta/db';

import {
  BASE,
  codeSignIn,
  cookiesFrom,
  providerSignIn,
  type AuthUnderTest,
} from '../auth-flow-harness';
import { closePool, emailOf, hasDb, journey, makeUser, type Tx } from './db';

/**
 * A session deleted in the database is refused on the very NEXT request,
 * although the browser still holds a signed cookie cache that better-auth
 * itself keeps vouching for (SESSION_COOKIE_CACHE_SECONDS, lib/auth-options.ts).
 * The real getCurrentUser() and the real better-auth (lib/auth.ts, the drizzle
 * adapter) run against Postgres: the in-memory flow tests
 * (tests/auth-providers-flow.test.ts) cannot run getCurrentUser's SQL.
 *
 * getDb() is routed into the journey's transaction, so better-auth's own
 * writes roll back with everything else. That matters: revokeSessions logs to
 * the append-only admin_actions, which a committed fixture would litter for
 * good.
 */

const h = vi.hoisted(() => ({ tx: null as object | null, cookie: '' }));

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers(h.cookie ? { cookie: h.cookie } : {})),
}));
// Only requireUser/requireRole redirect; getCurrentUser never does.
vi.mock('next-intl/server', () => ({ getLocale: () => Promise.resolve('bg') }));
vi.mock('@/i18n/navigation', () => ({
  redirect: () => {
    throw new Error('getCurrentUser must not redirect');
  },
}));
vi.mock('@sportkarta/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('@sportkarta/db')>();
  // One object for every caller, including the adapter lib/auth.ts builds once
  // and caches: each property is looked up on the journey's transaction while
  // one is open, on the real database otherwise (journey() opens it there).
  const routed = new Proxy(
    {},
    {
      get(_target, key) {
        const db = h.tx ?? real.getDb();
        const value: unknown = Reflect.get(db, key, db);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(db)
          : value;
      },
    },
  );
  return { ...real, getDb: () => routed };
});

/**
 * What Meta says about the visitor on the next Facebook callback. The id is
 * fresh per journey: a (facebook, id) link left in the shared database by some
 * other run would otherwise route the callback to that account.
 */
const facebook = { id: '', email: '' };

/** A journey in which better-auth and getCurrentUser read and write `tx`. */
function signedInJourney(run: (tx: Tx, auth: AuthUnderTest) => Promise<void>): Promise<void> {
  return journey(async (tx) => {
    h.tx = tx;
    try {
      await run(tx, requireAuth());
    } finally {
      h.tx = null;
      h.cookie = '';
    }
  });
}

/** better-auth's own answer, which may come from the signed cookie alone. */
async function cookieSays(auth: AuthUnderTest, cookie: string): Promise<string | null> {
  const session = await auth.api.getSession({ headers: new Headers({ cookie }) });
  return session?.user.id ?? null;
}

describe.skipIf(!hasDb)('session revocation journey (requires running database)', () => {
  beforeAll(() => {
    // Read once, when lib/auth.ts first builds the instance.
    vi.stubEnv('AUTH_URL', BASE);
    vi.stubEnv('ADMIN_EMAILS', '');
    vi.stubEnv('AUTH_FACEBOOK_ENABLED', 'true');
    vi.stubEnv('FACEBOOK_CLIENT_ID', 'facebook-client');
    vi.stubEnv('FACEBOOK_CLIENT_SECRET', 'facebook-secret');
  });

  beforeEach(() => {
    // Meta's servers are the only fake; the callback route is the real one.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const json = (body: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
        );
      if (url.startsWith('https://graph.facebook.com/v24.0/oauth/access_token')) {
        return json({
          access_token: 'facebook-access-token',
          token_type: 'bearer',
          expires_in: 3600,
        });
      }
      if (url.startsWith('https://graph.facebook.com/debug_token')) {
        return json({ data: { is_valid: true, app_id: 'facebook-client', user_id: facebook.id } });
      }
      if (url.startsWith('https://graph.facebook.com/me')) {
        return json({
          id: facebook.id,
          name: 'Stranger',
          email: facebook.email,
          picture: { data: { url: 'https://fb.example/photo.jpg' } },
        });
      }
      return Promise.reject(new Error(`unexpected fetch in a sign-in journey: ${url}`));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closePool();
  });

  it('an admin ending every session signs the member out on their very next request', async () => {
    await signedInJourney(async (tx, auth) => {
      const admin = await makeUser(tx, 'revoker', 'admin');
      const member = await makeUser(tx, 'stolen_phone');
      const signedIn = await codeSignIn(auth, emailOf(member));
      h.cookie = cookiesFrom(signedIn.headers);
      // The signed cache rides next to the token, as in a real browser.
      expect(h.cookie).toMatch(/session_data=/);
      expect((await getCurrentUser())?.id).toBe(member);

      expect(await revokeSessions(tx, admin, member)).toEqual({ ok: true, changed: true });

      // better-auth would still vouch from the cookie...
      expect(await cookieSays(auth, h.cookie)).toBe(member);
      // ...and nothing that authorizes takes its word for it.
      expect(await getCurrentUser()).toBeNull();
    });
  });

  it('a session expired in the store is refused while its cookie is still fresh', async () => {
    await signedInJourney(async (tx, auth) => {
      const member = await makeUser(tx, 'expired');
      const signedIn = await codeSignIn(auth, emailOf(member));
      h.cookie = cookiesFrom(signedIn.headers);
      expect((await getCurrentUser())?.id).toBe(member);

      // The row survives but is past its end (the journey's frozen now()).
      await tx.execute(sql`
        UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = ${member}
      `);

      expect(await cookieSays(auth, h.cookie)).toBe(member);
      expect(await getCurrentUser()).toBeNull();
    });
  });

  it('the pre-hijack stranger is signed out the moment the owner proves the address', async () => {
    await signedInJourney(async (_tx, auth) => {
      // A stranger opens an account through Facebook with an address they do
      // not own: Meta does not vouch for it, so the account is unverified.
      const tag = randomUUID().slice(0, 8);
      facebook.id = `facebook-${tag}`;
      facebook.email = `journey-owner-${tag}@example.org`;
      const stranger = await providerSignIn(auth, 'facebook');
      expect(stranger.location).toBe('/profil');
      expect(stranger.cookie).toMatch(/session_data=/);
      h.cookie = stranger.cookie;
      const planted = await getCurrentUser();
      if (!planted) throw new Error('the Facebook sign-up made no session');
      expect(planted.email).toBe(facebook.email);

      // The owner redeems an email code: same account, now proven, and every
      // session the stranger held deleted from the store.
      const owner = await codeSignIn(auth, facebook.email);
      expect(owner.response.user.id).toBe(planted.id);

      // The stranger's cookie still vouches to better-auth...
      expect(await cookieSays(auth, stranger.cookie)).toBe(planted.id);
      // ...and opens nothing, although the account and a session of it (the
      // owner's) are alive: the cookie has to name a live session.
      expect(await getCurrentUser()).toBeNull();
      h.cookie = cookiesFrom(owner.headers);
      expect((await getCurrentUser())?.id).toBe(planted.id);
    });
  });
});
