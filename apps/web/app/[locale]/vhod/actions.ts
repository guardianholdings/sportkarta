'use server';

import { MailNotConfiguredError } from '@sportkarta/lib/email';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { routing } from '@/i18n/routing';
import { getAuth, LOCALE_HEADER } from '@/lib/auth';
import { otpEmailRateLimiter, otpIpRateLimiter } from '@/lib/auth-rate-limit';
import { clientIpFromForwardedFor } from '@/lib/rate-limit';
import { safeRedirectOr } from '@/lib/safe-redirect';

/**
 * Email-OTP sign-in (docs/ROADMAP.md §5). Two steps in one action: request a
 * code, then exchange it for a session.
 *
 * Nothing here logs the address or the code. Failures are reported with a
 * generic message so the form cannot be used to discover which addresses have
 * accounts.
 */

export type SignInError =
  | 'invalid_email'
  | 'invalid_code'
  | 'throttled'
  | 'mail_unavailable'
  | 'auth_unavailable'
  | 'unknown';

export interface SignInState {
  step: 'email' | 'code';
  /** Echoed back so step two knows which address to verify. */
  email: string;
  error: SignInError | null;
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

export async function signInAction(_prev: SignInState, formData: FormData): Promise<SignInState> {
  const auth = getAuth();
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase();
  const locale = resolveLocale(formData.get('locale'));
  const step = formData.get('step') === 'code' ? 'code' : 'email';

  if (!auth) return { step: 'email', email, error: 'auth_unavailable' };
  if (!EMAIL_PATTERN.test(email)) return { step: 'email', email, error: 'invalid_email' };

  if (step === 'email') {
    const ip = await clientKey();
    if (!otpIpRateLimiter.check(ip).allowed || !otpEmailRateLimiter.check(email).allowed) {
      return { step: 'email', email, error: 'throttled' };
    }

    try {
      await auth.api.sendVerificationOTP({
        body: { email, type: 'sign-in' },
        // The locale header is what makes the code arrive in the language the
        // member is reading the site in.
        headers: new Headers({ [LOCALE_HEADER]: locale }),
      });
      return { step: 'code', email, error: null };
    } catch (error) {
      if (error instanceof MailNotConfiguredError) {
        console.error('[auth] OTP requested but no mail transport is configured');
        return { step: 'email', email, error: 'mail_unavailable' };
      }
      // Production logs get the error type only — the message can carry the
      // address. Local development gets the whole thing, or nothing is
      // debuggable.
      console.error(
        '[auth] sending a sign-in code failed:',
        process.env.NODE_ENV === 'production'
          ? error instanceof Error
            ? error.name
            : typeof error
          : error,
      );
      return { step: 'email', email, error: 'unknown' };
    }
  }

  const code = String(formData.get('code') ?? '').trim();
  if (!CODE_PATTERN.test(code)) return { step: 'code', email, error: 'invalid_code' };

  try {
    await auth.api.signInEmailOTP({
      body: { email, otp: code },
      headers: await headers(),
    });
  } catch (error) {
    // Wrong, expired or already-used code — all the same message to the user.
    // Detail is logged only outside production (it can name the address).
    if (process.env.NODE_ENV !== 'production') {
      console.error('[auth] code verification failed:', error);
    }
    return { step: 'code', email, error: 'invalid_code' };
  }

  const next = String(formData.get('next') ?? '');
  redirect(safeRedirectOr(next, '/profil'));
}

/**
 * Google sign-in. Only reachable when the provider is configured; better-auth
 * returns the URL to hand the visitor off to.
 */
export async function googleSignInAction(formData: FormData): Promise<void> {
  const auth = getAuth();
  if (!auth) redirect('/vhod');

  const next = String(formData.get('next') ?? '');
  const response = await auth.api.signInSocial({
    body: {
      provider: 'google',
      callbackURL: safeRedirectOr(next, '/profil'),
    },
    headers: await headers(),
  });

  redirect(response.url ?? '/vhod');
}

export async function signOutAction(): Promise<void> {
  const auth = getAuth();
  if (auth) {
    await auth.api.signOut({ headers: await headers() });
  }
  redirect('/');
}
