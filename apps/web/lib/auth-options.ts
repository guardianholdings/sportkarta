import type { BetterAuthOptions } from 'better-auth';

import type { SignInProviderStates } from './auth-config';
import {
  accountOptions,
  oauthErrorFallbackUrl,
  socialProviderOptions,
  stripProviderTokens,
  trustedOriginsFor,
} from './auth-providers';
import { authPlugins, DISABLED_AUTH_PATHS } from './auth-surface';

/**
 * The whole better-auth configuration, minus the two things that differ
 * between production and the tests: the database (Postgres via drizzle in
 * lib/auth.ts, better-auth's in-memory adapter in tests/auth-providers-flow
 * .test.ts) and what happens after a session is created (the admin-role sync,
 * which needs our own database). Everything else — the providers, the linking
 * rules, the hooks, the REST surface — is this one object, so the flow tests
 * exercise exactly what production runs.
 */

export type BetterAuthLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AuthOptionsInput {
  secret: string;
  /** The site's origin, e.g. https://pops.bg (lib/auth-config.ts resolveAuthBaseUrl). */
  baseURL: string;
  /** Postgres through drizzle in production; better-auth's memory adapter in tests. */
  database: BetterAuthOptions['database'];
  providers: SignInProviderStates;
  trustedProxies: string[];
  log: (level: BetterAuthLogLevel, message: string, ...args: unknown[]) => void;
  /** Runs after every session insert: the admin bootstrap/revoke in production. */
  afterSessionCreated: (userId: string) => Promise<void>;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

/** The endpoint a code is redeemed through (in-process, from the sign-in action). */
const EMAIL_CODE_SIGN_IN_PATH = '/sign-in/email-otp';

export function authOptions(input: AuthOptionsInput) {
  return {
    appName: 'POPS',
    secret: input.secret,
    baseURL: input.baseURL,
    database: input.database,
    user: {
      modelName: 'users',
      fields: { name: 'displayName' },
      additionalFields: {
        homeCity: { type: 'string', required: false, input: true },
        // input:false on both — a client must never be able to declare itself
        // an adult or an admin. is_minor comes from the profile action's DOB
        // derivation, role from the allowlist sync below.
        isMinor: { type: 'boolean', required: false, defaultValue: false, input: false },
        role: { type: 'string', required: false, defaultValue: 'user', input: false },
      },
    },
    session: {
      modelName: 'sessions',
      expiresIn: SESSION_TTL_SECONDS,
      updateAge: 60 * 60 * 24,
      // Short-lived signed cookie cache: most requests then need no session
      // SELECT, while a revoked session still dies within five minutes.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    account: accountOptions(),
    verification: { modelName: 'verifications' },
    emailAndPassword: { enabled: false },
    // Every REST endpoint the browser does not need answers 404. In-process
    // `auth.api.*` calls (the server actions) never go through this check.
    disabledPaths: [...DISABLED_AUTH_PATHS],
    logger: { log: input.log },
    // On by default in production only; enabled explicitly so development and
    // CI behave the same way. It now guards only what is still public
    // (/get-session, /sign-out, the OAuth callback); the OTP throttles live in
    // lib/auth-rate-limit.ts, in front of the only path that reaches OTP.
    rateLimit: { enabled: true, storage: 'memory' },
    advanced: {
      // NOT disableIpTracking: that flag also switches off better-auth's entire
      // rate limiter (it returns null before any rule is consulted), which would
      // leave the public /api/auth/* endpoints unthrottled. The address is
      // instead used transiently for rate limiting and dropped before the
      // session row is written (databaseHooks below), which is exactly what the
      // privacy page promises.
      ipAddress: { trustedProxies: input.trustedProxies },
    },
    // An OAuth failure whose own error URL is lost (expired state, a tampered
    // callback) lands on the sign-in page, not on better-auth's bare one.
    onAPIError: { errorURL: oauthErrorFallbackUrl(input.baseURL) },
    trustedOrigins: trustedOriginsFor(input.providers),
    socialProviders: socialProviderOptions(input.providers),
    databaseHooks: {
      user: {
        update: {
          /**
           * PRE-HIJACK GUARD. Somebody can open an account through Facebook
           * with an address they do not own: Meta's address is unverified, so
           * the account is created unverified. When the real owner later
           * redeems an email code, better-auth proves the address and — before
           * marking it verified — strips the account's password and sessions
           * (revokeUnprovenAccountAccess), but NOT its social links: the
           * stranger's Facebook link would keep opening the owner's account.
           *
           * This runs at exactly that moment — inside the code redemption,
           * after the code has been checked, while the account is still
           * unverified — and drops every provider link on it, then every
           * session again (one could have been minted through a link in
           * between). The owner's own session is created after this. A member
           * who really did open the account through Facebook simply links it
           * again by signing in with the code, then with a provider that
           * vouches for the address; Facebook stays email-code-only for them.
           */
          before: async (data, ctx) => {
            if (data.emailVerified !== true || ctx?.path !== EMAIL_CODE_SIGN_IN_PATH) return;
            const body: unknown = ctx.body;
            const email =
              body && typeof body === 'object' && 'email' in body && typeof body.email === 'string'
                ? body.email.toLowerCase()
                : null;
            if (!email) return;
            const adapter = ctx.context.internalAdapter;
            const found = await adapter.findUserByEmail(email);
            if (!found || found.user.emailVerified) return;
            const links = (await adapter.findAccounts(found.user.id)).filter(
              (account) => account.providerId !== 'credential',
            );
            if (links.length === 0) return;
            for (const link of links) await adapter.deleteAccount(link.id);
            await adapter.deleteUserSessions(found.user.id);
            // No address, no user id: the count is what an operator needs.
            input.log(
              'warn',
              `a sign-in code proved an unverified address; dropped ${links.length} unproven provider link(s)`,
            );
          },
        },
      },
      account: {
        create: { before: stripProviderTokens },
        update: { before: stripProviderTokens },
      },
      session: {
        create: {
          // Last stop before the insert: no visitor IP reaches storage.
          // sessions.ip_address additionally has a CHECK as the backstop, so a
          // regression here fails loudly instead of silently retaining IPs.
          before: (session) => Promise.resolve({ data: { ...session, ipAddress: null } }),
          after: async (session) => {
            await input.afterSessionCreated(session.userId);
          },
        },
      },
    },
    plugins: authPlugins(),
  } satisfies BetterAuthOptions;
}
