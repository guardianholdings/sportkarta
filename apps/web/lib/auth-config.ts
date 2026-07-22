/**
 * Pure configuration resolution for better-auth (docs/ROADMAP.md §5).
 *
 * Kept free of any better-auth import so the feature-flag and fail-closed rules
 * are unit-testable, and so the sign-in page can ask "is Google on?" without
 * constructing an auth instance.
 */

export interface AuthEnv {
  AUTH_SECRET?: string | undefined;
  AUTH_URL?: string | undefined;
  NEXT_PUBLIC_SITE_URL?: string | undefined;
  AUTH_GOOGLE_ENABLED?: string | undefined;
  GOOGLE_CLIENT_ID?: string | undefined;
  GOOGLE_CLIENT_SECRET?: string | undefined;
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

/**
 * Google login is optional by design: the platform must be deployable with zero
 * external identity dependencies (ROADMAP §0). It turns on only when the flag
 * is explicitly "true" AND both credentials are present — a half-configured
 * provider stays off rather than producing a button that dead-ends.
 */
export function resolveGoogleAuth(env: AuthEnv): GoogleAuthState {
  if (env.AUTH_GOOGLE_ENABLED?.trim().toLowerCase() !== 'true') {
    return { enabled: false, reason: 'flag_off' };
  }
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return { enabled: false, reason: 'missing_credentials' };
  return { enabled: true, clientId, clientSecret };
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
