import 'server-only';

import { getDb } from '@sportkarta/db';
import { accounts, sessions, users, verifications } from '@sportkarta/db/schema';
import { brandEmailHtml, createMailer, type Mailer } from '@sportkarta/lib/email';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { nextCookies } from 'better-auth/next-js';
import { emailOTP } from 'better-auth/plugins';
import { getTranslations } from 'next-intl/server';

import { routing } from '@/i18n/routing';

import {
  resolveAdminEmails,
  resolveAuthBaseUrl,
  resolveAuthSecret,
  resolveGoogleAuth,
  type GoogleAuthState,
} from './auth-config';
import { syncAdminRole } from './roles';

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
 */

const OTP_LENGTH = 6;
const OTP_TTL_SECONDS = 10 * 60;
const OTP_MAX_ATTEMPTS = 3;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export const OTP_REQUEST_WINDOW_SECONDS = 60;
export const OTP_REQUESTS_PER_WINDOW = 3;

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
 * Requests per minute per IP allowed on the OTP endpoints. This is better-auth's
 * own limiter, which guards the REST API directly — our server-action limiters
 * only see traffic that goes through the form. The e2e suite raises it because
 * every browser in it shares one address.
 */
function otpRequestsPerMinute(): number {
  const configured = Number(process.env.OTP_RATE_LIMIT_PER_MINUTE?.trim());
  return Number.isInteger(configured) && configured > 0 ? configured : OTP_REQUESTS_PER_WINDOW;
}

/** Header our own sign-in action sets so the OTP email matches the UI language. */
export const LOCALE_HEADER = 'x-sportkarta-locale';

function resolveEmailLocale(headerValue: string | null | undefined): string {
  const candidate = headerValue?.trim().toLowerCase();
  return routing.locales.find((locale) => locale === candidate) ?? routing.defaultLocale;
}

/**
 * Deliberately un-annotated: better-auth infers the API surface (including the
 * plugin endpoints and our additional user fields) from this options object,
 * and annotating the return type would erase all of it.
 */
function createAuthInstance(
  secret: string,
  google: GoogleAuthState,
  mailer: Mailer,
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
    // On by default in production only; enabled explicitly so development and
    // CI behave the same way and the limits are actually exercised.
    rateLimit: { enabled: true, storage: 'memory' },
    advanced: {
      // NOT disableIpTracking: that flag also switches off better-auth's entire
      // rate limiter (it returns null before any rule is consulted), which would
      // leave /api/auth/* unthrottled — the form-level limiters in
      // lib/auth-rate-limit.ts never see a direct API call. The address is
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
    plugins: [
      emailOTP({
        otpLength: OTP_LENGTH,
        expiresIn: OTP_TTL_SECONDS,
        allowedAttempts: OTP_MAX_ATTEMPTS,
        // Only a hash is stored: a database dump must not be replayable.
        storeOTP: 'hashed',
        rateLimit: { window: OTP_REQUEST_WINDOW_SECONDS, max: otpRequestsPerMinute() },
        sendVerificationOTP: async ({ email, otp }, ctx) => {
          const locale = resolveEmailLocale(ctx?.request?.headers.get(LOCALE_HEADER));
          const t = await getTranslations({ locale, namespace: 'AuthEmail' });
          const text = t('otpBody', { code: otp, minutes: OTP_TTL_SECONDS / 60 });
          await mailer.send({
            to: email,
            subject: t('otpSubject'),
            text,
            html: brandEmailHtml(text),
          });
        },
      }),
      // Must stay last: lets server actions set the session cookie.
      nextCookies(),
    ],
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

  return createAuthInstance(
    secret,
    google,
    createMailer(process.env),
    resolveAdminEmails(process.env),
  );
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
