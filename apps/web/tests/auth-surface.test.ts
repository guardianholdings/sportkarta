import { randomBytes } from 'node:crypto';

import { betterAuth } from 'better-auth';
import { describe, expect, it } from 'vitest';

import {
  authPlugins,
  DISABLED_AUTH_PATHS,
  INERT_AUTH_PATHS,
  PUBLIC_AUTH_PATHS,
} from '@/lib/auth-surface';

/**
 * A real better-auth instance built from the same plugins and path lists as
 * lib/auth.ts — only the database (in-memory here) and the environment differ,
 * and neither changes which endpoints exist.
 */
function buildAuth() {
  return betterAuth({
    secret: randomBytes(32).toString('hex'),
    baseURL: 'http://localhost:3000',
    emailAndPassword: { enabled: false },
    disabledPaths: [...DISABLED_AUTH_PATHS],
    // Google ships off, but its callback must be classified for the day it is on.
    socialProviders: { google: { clientId: 'test-client', clientSecret: 'test-secret' } },
    logger: { disabled: true },
    plugins: authPlugins(),
  });
}

const BASE = 'http://localhost:3000/api/auth';

function post(path: string, body: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('the better-auth REST surface', () => {
  const auth = buildAuth();
  const routedPaths = Object.values(auth.api)
    .map((endpoint) => (endpoint as { path?: string }).path)
    .filter((path): path is string => typeof path === 'string');

  it('classifies every endpoint the library publishes', () => {
    // A better-auth upgrade that adds a route fails here until somebody decides
    // whether the internet should reach it.
    const classified = new Set<string>([
      ...PUBLIC_AUTH_PATHS,
      ...DISABLED_AUTH_PATHS,
      ...Object.keys(INERT_AUTH_PATHS),
    ]);
    expect(routedPaths.filter((path) => !classified.has(path))).toEqual([]);
  });

  it('names only endpoints that exist, each in exactly one list', () => {
    const disabled = new Set<string>(DISABLED_AUTH_PATHS);
    const all = [...PUBLIC_AUTH_PATHS, ...DISABLED_AUTH_PATHS, ...Object.keys(INERT_AUTH_PATHS)];
    expect(new Set(all).size).toBe(all.length);
    // A typo in disabledPaths would silently leave the real route open.
    expect([...disabled].filter((path) => !routedPaths.includes(path))).toEqual([]);
    // disabledPaths matches exact strings, so a parameterised route in it would
    // be a no-op that only looks like protection.
    expect([...disabled].filter((path) => path.includes(':'))).toEqual([]);
  });

  it('answers 404 on the OTP endpoints that bypassed the form limits', async () => {
    for (const [path, body] of [
      ['/email-otp/send-verification-otp', { email: 'victim@example.org', type: 'sign-in' }],
      ['/sign-in/email-otp', { email: 'victim@example.org', otp: '000000' }],
      [
        '/email-otp/check-verification-otp',
        { email: 'victim@example.org', type: 'sign-in', otp: '000000' },
      ],
      ['/update-user', { name: 'x'.repeat(200) }],
    ] as const) {
      const response = await auth.handler(post(path, body));
      expect(response.status, path).toBe(404);
    }
    expect((await auth.handler(new Request(`${BASE}/ok`))).status).toBe(404);
  });

  it('keeps the session endpoint reachable', async () => {
    const response = await auth.handler(new Request(`${BASE}/get-session`));
    expect(response.status).toBe(200);
  });

  it('still lets the sign-in action mint and redeem codes in-process', async () => {
    // disabledPaths guards the HTTP router only. The action's auth.api calls
    // must keep working, or sign-in is simply broken.
    const email = 'member@example.org';
    const otp = await auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } });
    expect(otp).toMatch(/^\d{6}$/);

    const session = await auth.api.signInEmailOTP({ body: { email, otp } });
    expect(session.user.email).toBe(email);
  });

  it('never mails through better-auth’s own send path', async () => {
    // That path swallows failures; the plugin callback refuses outright.
    const plugin = authPlugins()[0] as { options?: { sendVerificationOTP?: unknown } };
    const send = plugin.options?.sendVerificationOTP as
      ((data: { email: string; otp: string; type: 'sign-in' }) => Promise<void>) | undefined;
    expect(send).toBeTypeOf('function');
    await expect(
      send?.({ email: 'x@example.org', otp: '123456', type: 'sign-in' }),
    ).rejects.toThrow(/sign-in action/);
  });
});
