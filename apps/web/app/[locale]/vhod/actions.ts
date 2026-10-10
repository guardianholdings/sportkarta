'use server';

import { getLocale } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect as redirectOffSite } from 'next/navigation';

import { getPathname, redirect } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { getAuth, sendSignInCode } from '@/lib/auth';
import { isSignInProvider, resolveSignInProviders, type SignInProvider } from '@/lib/auth-config';
import {
  beginCodeAttempt,
  GLOBAL_SEND_KEY,
  otpEmailRateLimiter,
  otpGlobalSendLimiter,
  otpIpRateLimiter,
} from '@/lib/auth-rate-limit';
import { clientIpFromForwardedFor } from '@/lib/rate-limit';
import { SIGN_IN_PATH, signInDestination, signInHref } from '@/lib/sign-in-destination';

/**
 * Email-OTP sign-in (docs/ROADMAP.md §5). Two steps in one action: request a
 * code, then exchange it for a session.
 *
 * This action is the ONLY way to request or redeem a code — better-auth's REST
 * endpoints for both are disabled (lib/auth-surface.ts) — so the limiters here
 * are the whole defence, not a layer in front of a side door.
 *
 * Nothing here logs the address or the code. Failures are reported with a
 * generic message so the form cannot be used to discover which addresses have
 * accounts.
 */

export type SignInError =
  | 'invalid_email'
  | 'invalid_code'
  | 'throttled'
  | 'verify_throttled'
  | 'mail_unavailable'
  | 'auth_unavailable'
  | 'unknown';

export interface SignInState {
  step: 'email' | 'code';
  /** Echoed back so step two knows which address to verify. */
  email: string;
  error: SignInError | null;
  /**
   * A NEW code went out because the member asked for one. A successful resend
   * used to return exactly the state it started from, so nothing on screen
   * said that the button had done anything (UX audit 2026-10-10).
   */
  resent?: boolean;
}

// Deliberately loose: the mail server is the real authority on deliverability.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CODE_PATTERN = /^\d{6}$/;

async function clientKey(): Promise<string> {
  const headerStore = await headers();
  return clientIpFromForwardedFor(headerStore.get('x-forwarded-for')) ?? 'local';
}

function resolveLocale(value: FormDataEntryValue | null): string {
  const candidate = String(value ?? '').toLowerCase();
  return routing.locales.find((locale) => locale === candidate) ?? routing.defaultLocale;
}

const CAP_WARNING_INTERVAL_MS = 10 * 60 * 1000;
let lastCapWarningAt = 0;

/**
 * The global send cap refusing is an operator event — either a flood or a
 * launch-day peak the cap was not sized for — so it is logged, but at most every
 * ten minutes: under a flood, one line per refused request would bury the log.
 */
function warnGlobalCapReached(): void {
  const now = Date.now();
  if (now - lastCapWarningAt < CAP_WARNING_INTERVAL_MS) return;
  lastCapWarningAt = now;
  console.warn(
    '[auth] hourly sign-in code cap reached (OTP_SEND_LIMIT_PER_HOUR); codes are refused until it frees up',
  );
}

export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const auth = getAuth();
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const locale = resolveLocale(formData.get('locale'));
  /**
   * Two escape hatches from the code step, both plain submit buttons so the
   * form still works without JavaScript. Without them a member whose code never
   * arrives — or who mistyped the address — has no way forward but the browser
   * back button, on the screen with the highest drop-off in the product.
   *
   * `restart` returns to the email step (nothing is sent). `resend` re-runs the
   * email step, so it goes through the same rate limiters as a first request.
   */
  if (formData.get('restart') === '1') return { step: 'email', email, error: null };
  const resend = formData.get('resend') === '1';
  const step = resend ? 'email' : formData.get('step') === 'code' ? 'code' : 'email';

  if (!auth) return { step: 'email', email, error: 'auth_unavailable' };
  if (!EMAIL_PATTERN.test(email)) return { step: 'email', email, error: 'invalid_email' };

  if (step === 'email') {
    const ip = await clientKey();
    if (!otpIpRateLimiter.check(ip).allowed || !otpEmailRateLimiter.check(email).allowed) {
      /**
       * A REFUSED RESEND MUST NOT EVICT THE MEMBER FROM THE CODE STEP.
       *
       * The email limiter allows 5 sends per 10 minutes. Somebody tapping
       * "resend" a couple of times while slow mail is in flight would otherwise
       * be thrown back to the email screen — where they are throttled too — with
       * no way to return, while a perfectly valid code sits in their inbox for
       * up to ten minutes. The throttle is reported in place: they still have
       * the code field, and the code they already have still works.
       */
      return { step: resend ? 'code' : 'email', email, error: 'throttled' };
    }
    // Checked last, so a request the per-client limits refuse does not use up
    // the site-wide allowance. Not the member's doing, so not "too many
    // attempts": no code can be sent right now.
    if (!otpGlobalSendLimiter.check(GLOBAL_SEND_KEY).allowed) {
      warnGlobalCapReached();
      return { step: resend ? 'code' : 'email', email, error: 'mail_unavailable' };
    }

    // The code is mailed HERE, not by better-auth, so a failed send reaches the
    // member as an error instead of «Изпратихме код» for a code that never left.
    const outcome = await sendSignInCode(email, locale);
    return outcome === 'sent'
      ? { step: 'code', email, error: null, ...(resend ? { resent: true } : {}) }
      : { step: 'email', email, error: outcome };
  }

  const code = String(formData.get('code') ?? '').trim();
  if (!CODE_PATTERN.test(code)) return { step: 'code', email, error: 'invalid_code' };

  /**
   * Brute-force bound. better-auth allows 3 guesses per code, but a new code
   * resets that count, and it applies no limit at all to in-process calls — so
   * this is what caps guesses per address (and per host) over time.
   */
  const attempt = beginCodeAttempt(email, await clientKey());
  if (!attempt) return { step: 'code', email, error: 'verify_throttled' };

  try {
    await auth.api.signInEmailOTP({
      body: { email, otp: code },
      headers: await headers(),
    });
  } catch (error) {
    // Wrong, expired or already-used code — all the same message to the user,
    // and all one counted failure. Detail is logged only outside production
    // (it can name the address).
    if (process.env.NODE_ENV !== 'production') {
      console.error('[auth] code verification failed:', error);
    }
    return { step: 'code', email, error: 'invalid_code' };
  }
  attempt.succeeded();

  // In the language the member signed in with, whatever prefix `next` carried.
  return redirect({ href: signInDestination(formData.get('next')), locale });
}

/**
 * Sign-in with Google, Apple or Facebook — whichever are on. better-auth returns
 * the URL to hand the visitor off to; the provider sends them back to
 * /api/auth/callback/<provider>, and from there to `next` on success or to the
 * sign-in page on failure, with the reason (`error=`) and the provider named,
 * in the language they started in, so /vhod can say what happened instead of
 * showing better-auth's bare error page.
 */
export async function providerSignInAction(formData: FormData): Promise<void> {
  const auth = getAuth();
  const locale = resolveLocale(formData.get('locale'));
  const provider = formData.get('provider');
  if (
    !auth ||
    !isSignInProvider(provider) ||
    !resolveSignInProviders(process.env)[provider].enabled
  ) {
    return redirect({ href: SIGN_IN_PATH, locale });
  }

  const destination = signInDestination(formData.get('next'));
  const response = await auth.api.signInSocial({
    body: {
      provider,
      callbackURL: getPathname({ href: destination, locale }),
      errorCallbackURL: getPathname({
        href: oauthErrorHref(provider, formData.get('next')),
        locale,
      }),
    },
    headers: await headers(),
  });

  // Off to the provider: an absolute URL, so the plain Next redirect, not the i18n one.
  if (response.url) return redirectOffSite(response.url);
  return redirect({ href: SIGN_IN_PATH, locale });
}

/** /vhod?[next=…&]provider=…; better-auth appends `&error=<code>`. */
function oauthErrorHref(provider: SignInProvider, next: FormDataEntryValue | null) {
  const href = signInHref(typeof next === 'string' ? next : null);
  return { pathname: href.pathname, query: { ...href.query, provider } };
}

/** Signing out keeps the language: the home page in the locale the member was reading. */
export async function signOutAction(): Promise<void> {
  const auth = getAuth();
  if (auth) {
    await auth.api.signOut({ headers: await headers() });
  }
  return redirect({ href: '/', locale: await getLocale() });
}
