import type { KeyObject } from 'node:crypto';

import { parseApplePrivateKey } from './apple-client-secret';
import { SIGN_IN_PROVIDERS, type SignInProvider } from './sign-in-providers';

/**
 * Pure configuration resolution for better-auth (docs/ROADMAP.md §5).
 *
 * Kept free of any better-auth import so the feature-flag and fail-closed rules
 * are unit-testable, and so the sign-in page can ask "which providers are on?"
 * without constructing an auth instance.
 */

export interface AuthEnv {
  AUTH_SECRET?: string | undefined;
  AUTH_URL?: string | undefined;
  NEXT_PUBLIC_SITE_URL?: string | undefined;
  AUTH_GOOGLE_ENABLED?: string | undefined;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
  AUTH_APPLE_ENABLED?: string | undefined;
  /** The Services ID (Apple's client_id on the web), not the app's bundle ID. */
  APPLE_CLIENT_ID?: string | undefined;
  APPLE_TEAM_ID?: string | undefined;
  APPLE_KEY_ID?: string | undefined;
  /** The .p8 key: the file as is, with `\n` escapes, or its base64 body. */
  APPLE_PRIVATE_KEY?: string | undefined;
  AUTH_FACEBOOK_ENABLED?: string | undefined;
  FACEBOOK_CLIENT_ID?: string | undefined;
  FACEBOOK_CLIENT_SECRET?: string | undefined;
  ADMIN_EMAILS?: string | undefined;
  NODE_ENV?: string | undefined;
}

/**
 * Development-only fallback secret. Production without AUTH_SECRET yields no
 * secret at all (see resolveAuthSecret) — a predictable secret in production
 * would let anyone forge a session cookie.
 */
const DEV_SECRET = 'sportkarta-development-only-secret-do-not-use-in-production';
const MIN_SECRET_LENGTH = 32;

/**
 * Values that are published in the repository and therefore worthless as
 * secrets, however long they are. The Stage 1 token scheme refused its own
 * committed test token in production for the same reason.
 */
const PUBLISHED_SECRETS = new Set([
  DEV_SECRET,
  // .env.example placeholder — long enough to pass the length check.
  'change-me-to-at-least-32-random-characters',
]);

export type GoogleAuthState =
  | { enabled: true; clientId: string; clientSecret: string }
  | { enabled: false; reason: 'flag_off' | 'missing_credentials' };

export type AppleAuthState =
  | { enabled: true; clientId: string; teamId: string; keyId: string; privateKey: KeyObject }
  | { enabled: false; reason: 'flag_off' | 'missing_credentials' | 'invalid_private_key' };

export type FacebookAuthState =
  | { enabled: true; clientId: string; clientSecret: string }
  | { enabled: false; reason: 'flag_off' | 'missing_credentials' };

/** The sign-in providers besides the email code: lib/sign-in-providers.ts. */
export {
  isSignInProvider,
  SIGN_IN_PROVIDER_NAMES,
  SIGN_IN_PROVIDERS,
  type SignInProvider,
} from './sign-in-providers';

function flagOn(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

/**
 * Every provider is optional by design: the platform must be deployable with
 * zero external identity dependencies (ROADMAP §0). Each turns on only when its
 * own flag is explicitly "true" AND all of its credentials are present — a
 * half-configured provider stays off rather than producing a button that
 * dead-ends.
 */
export function resolveGoogleAuth(env: AuthEnv): GoogleAuthState {
  if (!flagOn(env.AUTH_GOOGLE_ENABLED)) return { enabled: false, reason: 'flag_off' };
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return { enabled: false, reason: 'missing_credentials' };
  return { enabled: true, clientId, clientSecret };
}

/**
 * Apple has no static client secret: we sign one with the .p8 key at runtime
 * (lib/apple-client-secret.ts). A key that does not parse as an EC P-256
 * private key keeps the provider off — better a missing button than one that
 * fails at Apple's token endpoint after the visitor has already approved.
 */
export function resolveAppleAuth(env: AuthEnv): AppleAuthState {
  if (!flagOn(env.AUTH_APPLE_ENABLED)) return { enabled: false, reason: 'flag_off' };
  const clientId = env.APPLE_CLIENT_ID?.trim();
  const teamId = env.APPLE_TEAM_ID?.trim();
  const keyId = env.APPLE_KEY_ID?.trim();
  const rawKey = env.APPLE_PRIVATE_KEY?.trim();
  if (!clientId || !teamId || !keyId || !rawKey) {
    return { enabled: false, reason: 'missing_credentials' };
  }
  const privateKey = parseApplePrivateKey(rawKey);
  if (!privateKey) return { enabled: false, reason: 'invalid_private_key' };
  return { enabled: true, clientId, teamId, keyId, privateKey };
}

export function resolveFacebookAuth(env: AuthEnv): FacebookAuthState {
  if (!flagOn(env.AUTH_FACEBOOK_ENABLED)) return { enabled: false, reason: 'flag_off' };
  const clientId = env.FACEBOOK_CLIENT_ID?.trim();
  const clientSecret = env.FACEBOOK_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return { enabled: false, reason: 'missing_credentials' };
  return { enabled: true, clientId, clientSecret };
}

export interface SignInProviderStates {
  google: GoogleAuthState;
  apple: AppleAuthState;
  facebook: FacebookAuthState;
}

export function resolveSignInProviders(env: AuthEnv): SignInProviderStates {
  return {
    google: resolveGoogleAuth(env),
    apple: resolveAppleAuth(env),
    facebook: resolveFacebookAuth(env),
  };
}

/** The providers whose buttons the sign-in screens show, in display order. */
export function enabledSignInProviders(env: AuthEnv): SignInProvider[] {
  const states = resolveSignInProviders(env);
  return SIGN_IN_PROVIDERS.filter((provider) => states[provider].enabled);
}

/** null = auth cannot run. Callers degrade (503) instead of crashing the site. */
export function resolveAuthSecret(env: AuthEnv): string | null {
  const secret = env.AUTH_SECRET?.trim();
  const isProduction = env.NODE_ENV === 'production';
  if (secret && secret.length >= MIN_SECRET_LENGTH) {
    // A published placeholder in production is the same as having no secret:
    // anyone could forge a session cookie with it.
    if (!(isProduction && PUBLISHED_SECRETS.has(secret))) return secret;
  }
  if (isProduction) return null;
  return DEV_SECRET;
}

export function resolveAuthBaseUrl(env: AuthEnv): string {
  return (
    env.AUTH_URL?.trim() ||
    env.NEXT_PUBLIC_SITE_URL?.trim() ||
    'http://localhost:3000'
  ).replace(/\/+$/, '');
}

/**
 * Bootstrap allowlist: these addresses become admins on sign-in, which is how
 * the first admin exists at all without anyone opening a terminal or editing
 * the database by hand. Everyone else starts as 'user'.
 */
export function resolveAdminEmails(env: AuthEnv): ReadonlySet<string> {
  const emails = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.includes('@') && entry.length > 2);
  return new Set(emails);
}

export function isAuthConfigured(env: AuthEnv): boolean {
  return resolveAuthSecret(env) !== null;
}
