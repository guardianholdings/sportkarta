import 'server-only';

import { getDb } from '@sportkarta/db';
import { accounts, sessions, users, verifications } from '@sportkarta/db/schema';
import { createMailer, type Mailer } from '@sportkarta/lib/email';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

import {
  resolveAdminEmails,
  resolveAuthBaseUrl,
  resolveAuthSecret,
  resolveSignInProviders,
  SIGN_IN_PROVIDERS,
  type SignInProviderStates,
} from './auth-config';
import { authOptions, type BetterAuthLogLevel } from './auth-options';
import { syncAdminRole } from './roles';
import { deliverSignInCode, redactLogArgs, type SignInCodeOutcome } from './sign-in-code';

/**
 * better-auth, self-hosted in our own Postgres (docs/ROADMAP.md §0/§5).
 *
 * Sign-in is email OTP through the SMTP abstraction; Google, Apple and Facebook
 * are optional and each ships disabled behind its own flag, so the platform has
 * zero external identity dependencies out of the box. The options themselves
 * live in lib/auth-options.ts, where the flow tests build the same instance.
 *
 * The instance is built lazily and may be null: a production deployment without
 * AUTH_SECRET must degrade to "sign-in unavailable" rather than take down the
 * public map, which is the part of the site that matters most.
 *
 * Almost none of better-auth's REST API is reachable (lib/auth-surface.ts): the
 * site requests and redeems codes through the sign-in server action, where its
 * own limiters apply (lib/auth-rate-limit.ts), and mails the code itself
 * (sendSignInCode below) so a failed send is reported instead of swallowed.
 */

/**
 * Private ranges Caddy and the compose network sit in. better-auth strips the
 * X-Forwarded-For chain from the right down to the first untrusted hop, so
 * naming these makes the real client address resolvable while a client-supplied
 * XFF prefix stays ignorable. Override with TRUSTED_PROXIES when the topology
 * differs.
 */
const DEFAULT_TRUSTED_PROXIES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.1/32'];

function resolveTrustedProxies(): string[] {
  const configured = process.env.TRUSTED_PROXIES?.trim();
  if (!configured) return DEFAULT_TRUSTED_PROXIES;
  return configured
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * better-auth's log sink. Its default prints raw error objects, and those can
 * carry an address (a nodemailer rejection lists its recipients; a constraint
 * violation quotes the row), so production keeps only each error's type and
 * code — the same rule the sign-in action follows. Development sees everything.
 */
function logBetterAuth(level: BetterAuthLogLevel, message: string, ...args: unknown[]): void {
  const detail = process.env.NODE_ENV === 'production' ? redactLogArgs(args) : args;
  const line = `[better-auth] ${message}`;
  if (level === 'error') console.error(line, ...detail);
  else if (level === 'warn') console.warn(line, ...detail);
  else console.info(line, ...detail);
}

/**
 * Deliberately un-annotated: better-auth infers the API surface (including the
 * plugin endpoints and our additional user fields) from the options object,
 * and annotating the return type would erase all of it.
 */
function createAuthInstance(
  secret: string,
  providers: SignInProviderStates,
  adminEmails: ReadonlySet<string>,
) {
  return betterAuth(
    authOptions({
      secret,
      baseURL: resolveAuthBaseUrl(process.env),
      database: drizzleAdapter(getDb(), {
        provider: 'pg',
        // Keys must be the mapped table names (the `modelName` values in
        // lib/auth-options.ts), because the adapter looks the schema up by
        // table name, not by model. Our tables are plural like the rest of the
        // schema, and better-auth's `name` field lives in display_name.
        schema: { users, sessions, accounts, verifications },
      }),
      providers,
      trustedProxies: resolveTrustedProxies(),
      log: logBetterAuth,
      // Bootstrap/revoke the admin role from ADMIN_EMAILS on every sign-in, so
      // the first admin exists without any manual SQL.
      afterSessionCreated: (userId) => syncAdminRole(getDb(), userId, adminEmails),
    }),
  );
}

type Auth = ReturnType<typeof createAuthInstance>;

let cached: Auth | null | undefined;

function buildAuth(): Auth | null {
  const secret = resolveAuthSecret(process.env);
  if (!secret) {
    console.error('[auth] AUTH_SECRET is missing — sign-in is disabled for this deployment');
    return null;
  }

  const providers = resolveSignInProviders(process.env);
  // A flag switched on without (valid) credentials: say which, never what.
  for (const name of SIGN_IN_PROVIDERS) {
    const state = providers[name];
    if (!state.enabled && state.reason !== 'flag_off') {
      console.warn(`[auth] ${name} sign-in is flagged on but off: ${state.reason}`);
    }
  }

  return createAuthInstance(secret, providers, resolveAdminEmails(process.env));
}

/** null when auth cannot run in this environment (see buildAuth). */
export function getAuth(): Auth | null {
  if (cached === undefined) cached = buildAuth();
  return cached;
}

export class AuthUnavailableError extends Error {
  constructor() {
    super('Authentication is not configured');
    this.name = 'AuthUnavailableError';
  }
}

export function requireAuth(): Auth {
  const auth = getAuth();
  if (!auth) throw new AuthUnavailableError();
  return auth;
}

export function isAuthAvailable(): boolean {
  return getAuth() !== null;
}

let mailer: Mailer | undefined;

/**
 * Mint a sign-in code and mail it, in the member's UI language.
 *
 * The locale is an ARGUMENT. It used to ride on a header through better-auth
 * into its send callback, which read `ctx.request.headers` — and an in-process
 * `auth.api.*` call has no `request`, only `headers`, so every code went out in
 * Bulgarian. The code itself is minted by better-auth's server-only
 * createVerificationOTP (hashed, OTP_TTL_SECONDS, 3 attempts) and never leaves
 * this function except inside the mail.
 */
export async function sendSignInCode(email: string, locale: string): Promise<SignInCodeOutcome> {
  const auth = requireAuth();
  mailer ??= createMailer(process.env);
  return deliverSignInCode({
    email,
    issueCode: () => auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } }),
    locale,
    mailer,
    log: (line, detail) => {
      if (detail === undefined) console.error(line);
      else console.error(line, detail);
    },
    verboseErrors: process.env.NODE_ENV !== 'production',
  });
}
