import 'server-only';

import { getDb } from '@sportkarta/db';
import { accounts, sessions, users, verifications } from '@sportkarta/db/schema';
import { createMailer, type Mailer } from '@sportkarta/lib/email';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { getTranslations } from 'next-intl/server';

import {
  resolveAdminEmails,
  resolveAuthBaseUrl,
  resolveAuthSecret,
  resolveGoogleAuth,
  type GoogleAuthState,
} from './auth-config';
import { authPlugins, DISABLED_AUTH_PATHS } from './auth-surface';
import { syncAdminRole } from './roles';
import { deliverSignInCode, redactLogArgs, type SignInCodeOutcome } from './sign-in-code';

/**
 * better-auth, self-hosted in our own Postgres (docs/ROADMAP.md §0/§5).
 *
 * Sign-in is email OTP through the SMTP abstraction; Google is optional and
 * ships disabled, so the platform has zero external identity dependencies out
 * of the box.
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

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

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

type BetterAuthLogLevel = 'debug' | 'info' | 'warn' | 'error';

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
 * plugin endpoints and our additional user fields) from this options object,
 * and annotating the return type would erase all of it.
 */
function createAuthInstance(
  secret: string,
  google: GoogleAuthState,
  adminEmails: ReadonlySet<string>,
) {
  return betterAuth({
    appName: 'POPS',
    secret,
    baseURL: resolveAuthBaseUrl(process.env),
    database: drizzleAdapter(getDb(), {
      provider: 'pg',
      // Keys must be the mapped table names (the `modelName` values below),
      // because the adapter looks the schema up by table name, not by model.
      // Our tables are plural like the rest of the schema, and better-auth's
      // `name` field lives in the display_name column.
      schema: { users, sessions, accounts, verifications },
    }),
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
    account: { modelName: 'accounts' },
    verification: { modelName: 'verifications' },
    emailAndPassword: { enabled: false },
    // Every REST endpoint the browser does not need answers 404. In-process
    // `auth.api.*` calls (the server actions) never go through this check.
    disabledPaths: [...DISABLED_AUTH_PATHS],
    logger: { log: logBetterAuth },
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
      ipAddress: { trustedProxies: resolveTrustedProxies() },
    },
    databaseHooks: {
      session: {
        create: {
          // Last stop before the insert: no visitor IP reaches storage.
          // sessions.ip_address additionally has a CHECK as the backstop, so a
          // regression here fails loudly instead of silently retaining IPs.
          before: (session) => Promise.resolve({ data: { ...session, ipAddress: null } }),
          after: async (session) => {
            // Bootstrap/revoke the admin role from ADMIN_EMAILS on every
            // sign-in, so the first admin exists without any manual SQL.
            await syncAdminRole(getDb(), session.userId, adminEmails);
          },
        },
      },
    },
    ...(google.enabled
      ? {
          socialProviders: {
            google: { clientId: google.clientId, clientSecret: google.clientSecret },
          },
        }
      : {}),
    plugins: authPlugins(),
  });
}

type Auth = ReturnType<typeof createAuthInstance>;

let cached: Auth | null | undefined;

function buildAuth(): Auth | null {
  const secret = resolveAuthSecret(process.env);
  if (!secret) {
    console.error('[auth] AUTH_SECRET is missing — sign-in is disabled for this deployment');
    return null;
  }

  const google = resolveGoogleAuth(process.env);
  if (!google.enabled && google.reason === 'missing_credentials') {
    console.warn('[auth] AUTH_GOOGLE_ENABLED=true but credentials are missing — Google is off');
  }

  return createAuthInstance(secret, google, resolveAdminEmails(process.env));
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
 * createVerificationOTP (hashed, 10 minutes, 3 attempts, exactly as before) and
 * never leaves this function except inside the mail.
 */
export async function sendSignInCode(email: string, locale: string): Promise<SignInCodeOutcome> {
  const auth = requireAuth();
  const t = await getTranslations({ locale, namespace: 'AuthEmail' });
  mailer ??= createMailer(process.env);
  return deliverSignInCode({
    email,
    issueCode: () => auth.api.createVerificationOTP({ body: { email, type: 'sign-in' } }),
    translate: (key, values) => t(key, values),
    mailer,
    log: (line, detail) => {
      if (detail === undefined) console.error(line);
      else console.error(line, detail);
    },
    verboseErrors: process.env.NODE_ENV !== 'production',
  });
}
