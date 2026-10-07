import { nextCookies } from 'better-auth/next-js';
import { emailOTP } from 'better-auth/plugins';

/**
 * The shape of better-auth that is independent of the database and the
 * environment: which plugins run, how one-time codes behave, and which of its
 * REST endpoints the internet may reach. Kept apart from lib/auth.ts (which is
 * server-only and needs a database) so tests/auth-surface.test.ts can build a
 * real instance from these same pieces and check them against the library.
 */

export const OTP_LENGTH = 6;
/**
 * 30 minutes (Boss decision #31, was 10). Our relay has held sign-in mail for
 * 4–41 minutes before delivery, and a code that expires in transit is a member
 * who cannot sign in. Everything that states the lifetime follows this
 * constant: the mail, the code screen and the privacy page's retention line.
 * The other guards stay as they were: 6 digits, a stored hash, 3 guesses per
 * code, the per-address and per-host limits (lib/auth-rate-limit.ts), and only
 * the newest code counts (tests/auth-providers-flow.test.ts pins that).
 */
export const OTP_TTL_SECONDS = 30 * 60;
export const OTP_MAX_ATTEMPTS = 3;

/**
 * Plugins, in order. Returned fresh per instance, the way better-auth expects.
 *
 * `sendVerificationOTP` is required by the plugin but deliberately unused: the
 * sign-in action mints the code (auth.api.createVerificationOTP) and mails it
 * itself (lib/sign-in-code.ts). better-auth runs this callback inside
 * `runInBackgroundOrAwait`, which catches every error, logs it with the raw
 * recipient, and reports success — so a relay outage would tell the member a
 * code was on its way when none was. The endpoints that would call it are all
 * disabled below; if anything ever reaches it anyway, it refuses loudly rather
 * than sending mail through the path that hides failures.
 */
export function authPlugins() {
  return [
    emailOTP({
      otpLength: OTP_LENGTH,
      expiresIn: OTP_TTL_SECONDS,
      allowedAttempts: OTP_MAX_ATTEMPTS,
      // Only a hash is stored: a database dump must not be replayable.
      storeOTP: 'hashed',
      sendVerificationOTP: () =>
        Promise.reject(
          new Error('One-time codes are mailed by the sign-in action, not by better-auth'),
        ),
    }),
    // Must stay last: lets server actions set the session cookie.
    nextCookies(),
  ];
}

/**
 * better-auth endpoints the BROWSER reaches over HTTP (/api/auth/*). Everything
 * else the site does with auth is an in-process `auth.api.*` call from a server
 * action or server component — which does not pass through the HTTP router, so
 * `disabledPaths` does not affect it.
 *
 *  - /get-session and /sign-out: the session itself;
 *  - /callback/:id: where Google, Apple and Facebook return the visitor (each
 *    ships off, but its callback must work the day its flag is turned on).
 *    Apple returns by form POST, which better-auth answers with a redirect to
 *    the same path as a GET, so the state cookie travels;
 *  - /error: better-auth's own OAuth error page. Nothing sends visitors there
 *    any more (lib/auth-providers.ts points every OAuth error at /vhod), but
 *    the route exists, so it is classified.
 */
export const PUBLIC_AUTH_PATHS = ['/get-session', '/sign-out', '/callback/:id', '/error'] as const;

/**
 * Parameterised routes. `disabledPaths` compares exact paths, so these cannot
 * be named there — each is listed with why it is inert in this deployment.
 */
export const INERT_AUTH_PATHS: Readonly<Record<string, string>> = {
  '/reset-password/:token':
    'password sign-in is off, and /request-password-reset (the only issuer of reset tokens) is disabled',
};

/**
 * Every other better-auth endpoint answers 404. No page uses a better-auth
 * browser client, so these were pure attack surface — most sharply the OTP
 * pair: POST /email-otp/send-verification-otp and /sign-in/email-otp were
 * guarded only by better-auth's per-IP limiter, so the sign-in form's per-address
 * limits (lib/auth-rate-limit.ts) could simply be walked around, while
 * /email-otp/check-verification-otp answered "no such user" for unregistered
 * addresses and /update-user let a member write a display name the profile
 * form's validation would have refused.
 *
 * tests/auth-surface.test.ts builds better-auth from authPlugins() and fails if
 * an endpoint appears in none of these three lists — so a library upgrade that
 * adds a route has to be looked at before it ships.
 */
export const DISABLED_AUTH_PATHS = [
  // Sign-in and sign-up flows the site does not offer over HTTP.
  '/sign-in/social',
  '/sign-in/email',
  '/sign-up/email',
  '/sign-in/email-otp',
  // One-time codes: requested and redeemed only through the sign-in action.
  '/email-otp/send-verification-otp',
  '/email-otp/check-verification-otp',
  '/email-otp/verify-email',
  '/email-otp/request-password-reset',
  '/forget-password/email-otp',
  '/email-otp/reset-password',
  '/email-otp/request-email-change',
  '/email-otp/change-email',
  // Password and email management (there are no passwords).
  '/reset-password',
  '/request-password-reset',
  '/verify-password',
  '/change-password',
  '/verify-email',
  '/send-verification-email',
  '/change-email',
  // Account and session management: done in-app, through validated actions.
  '/update-user',
  '/delete-user',
  '/delete-user/callback',
  '/update-session',
  '/list-sessions',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  // Linked accounts and provider tokens.
  '/link-social',
  '/list-accounts',
  '/unlink-account',
  '/refresh-token',
  '/get-access-token',
  '/account-info',
  // Health probe; the site's own is /api/health.
  '/ok',
] as const;
