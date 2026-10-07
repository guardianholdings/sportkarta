'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useActionState, useId } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import type { OAuthError } from '@/lib/oauth-error';
import { SIGN_IN_PROVIDER_NAMES, type SignInProvider } from '@/lib/sign-in-providers';

import { providerSignInAction, signInAction, type SignInState } from './actions';

const INITIAL: SignInState = { step: 'email', email: '', error: null };

export function SignInForm({
  providers,
  codeMinutes,
  oauthError,
  next,
}: {
  /** The providers that are on, in display order (lib/auth-config.ts). */
  providers: SignInProvider[];
  /** The code's lifetime, from OTP_TTL_SECONDS. */
  codeMinutes: number;
  /** Why a provider sent the visitor back here, if it did (lib/oauth-error.ts). */
  oauthError: OAuthError | null;
  next: string;
}) {
  const t = useTranslations('SignIn');
  const locale = useLocale();
  const [state, action, pending] = useActionState<SignInState, FormData>(signInAction, INITIAL);
  const onCodeStep = state.step === 'code';
  const codeHintId = useId();

  return (
    <div className="space-y-6">
      {oauthError && !onCodeStep && (
        <p role="alert" className="text-body-sm text-danger">
          <OAuthErrorLine error={oauthError} googleOn={providers.includes('google')} />
        </p>
      )}

      <form action={action} className="space-y-4">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="step" value={state.step} />

        {onCodeStep ? (
          <>
            {/*
              On the code step the address is no longer an input. It was a
              read-only field, which looked editable, took a tab stop, and left
              the member no way to act on a typo. It is now a sentence that
              states where the code went — the only place a wrong address can be
              caught — plus a real control to go back and change it. The value
              still posts, as a hidden field.
            */}
            <input type="hidden" name="email" value={state.email} />
            <p className="text-body-sm text-ink-soft">
              {t.rich('codeSentTo', {
                email: state.email,
                addr: (chunks) => (
                  <span className="font-semibold break-all text-ink">{chunks}</span>
                ),
              })}
            </p>

            <label className="block space-y-1.5">
              <span className="text-body-sm font-medium text-ink">{t('codeLabel')}</span>
              <Input
                type="text"
                name="code"
                required
                autoFocus
                // One-time code: let the platform offer it from the mail app,
                // and never let a password manager store it.
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                invalid={state.error === 'invalid_code'}
                aria-describedby={codeHintId}
                className="text-center font-mono text-body-lg tracking-[0.4em]"
              />
            </label>
            {/*
              Outside the <label>: text nested in a label joins the field's
              ACCESSIBLE NAME, so a screen reader used to announce
              "Код от имейла Кодът е валиден 10 минути" as the field's name.
              Hints belong in aria-describedby.
            */}
            <p id={codeHintId} className="text-caption text-text-muted">
              {t('codeHint', { minutes: codeMinutes })}
            </p>
          </>
        ) : (
          <label className="block space-y-1.5">
            <span className="text-body-sm font-medium text-ink">{t('emailLabel')}</span>
            <Input
              type="email"
              name="email"
              required
              autoFocus
              autoComplete="email"
              inputMode="email"
              defaultValue={state.email}
              invalid={state.error === 'invalid_email'}
            />
          </label>
        )}

        {state.error && (
          <p role="alert" className="text-body-sm text-danger">
            {t(`error_${state.error}`)}
          </p>
        )}

        <Button type="submit" block disabled={pending}>
          {pending
            ? onCodeStep
              ? t('verifying')
              : t('sending')
            : onCodeStep
              ? t('submitCode')
              : t('submitEmail')}
        </Button>

        {onCodeStep && (
          /*
            The two escape hatches. Both are plain submits carrying an intent
            flag (see vhod/actions.ts), so they work without JavaScript. Without
            them the code step is a trap: a member whose mail never arrives, or
            who mistyped the address, can only recover by knowing to reload.
          */
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {/*
              `formNoValidate` on BOTH, and it is load-bearing. The code field is
              `required` with a 6-digit pattern, so without it the browser's own
              constraint validation refuses to submit while the box is empty —
              which is precisely the state a member is in when they need these
              buttons. The escape hatches would have been unreachable exactly
              when they matter. Neither button carries a code, and the server
              ignores the field on both paths.
            */}
            <Button
              type="submit"
              name="resend"
              value="1"
              formNoValidate
              variant="ghost"
              size="sm"
              disabled={pending}
            >
              {t('resend')}
            </Button>
            <Button
              type="submit"
              name="restart"
              value="1"
              formNoValidate
              variant="ghost"
              size="sm"
              disabled={pending}
            >
              {t('changeEmail')}
            </Button>
          </div>
        )}
      </form>

      {onCodeStep ? (
        /*
          Slow mail is the commonest reason a member never gets past this
          screen (our relay has held codes for up to 41 minutes), so the step
          says what to expect, where to look, which code counts — and offers the
          ways in that need no mail at all. A plain block, not a labelled
          region: its heading mentions „кода“, and a region named after it
          would also answer to the code field's label (getByLabel, screen
          reader label lists).
        */
        <div className="space-y-3">
          <h2 className="text-body-sm font-semibold text-ink">{t('codeHelpTitle')}</h2>
          <ul className="list-disc space-y-1 pl-5 text-body-sm text-ink-soft">
            <li>{t('codeHelpDelay')}</li>
            <li>{t('codeHelpSpam')}</li>
            <li>{t('codeHelpNewest')}</li>
          </ul>
          {providers.length > 0 && (
            <>
              <p className="text-body-sm text-ink-soft">{t('codeHelpProviders')}</p>
              <ProviderButtons providers={providers} locale={locale} next={next} />
            </>
          )}
        </div>
      ) : (
        providers.length > 0 && (
          <div className="space-y-2">
            <div className="text-center text-caption text-text-muted">{t('or')}</div>
            <ProviderButtons providers={providers} locale={locale} next={next} />
          </div>
        )
      )}

      {/* Signing in is when the account contract starts (GDPR Art. 6(1)(b)), so
          it is where the terms are named — with the privacy notice beside them. */}
      <p className="text-caption text-text-muted">
        {t.rich('privacyNote', {
          terms: (chunks) => (
            <Link href="/usloviya" className="font-medium text-link hover:text-link-hover">
              {chunks}
            </Link>
          ),
          privacy: (chunks) => (
            <Link href="/privacy" className="font-medium text-link hover:text-link-hover">
              {chunks}
            </Link>
          ),
        })}
      </p>
    </div>
  );
}

function OAuthErrorLine({ error, googleOn }: { error: OAuthError; googleOn: boolean }) {
  const t = useTranslations('SignIn');
  const provider = error.provider ? SIGN_IN_PROVIDER_NAMES[error.provider] : null;
  switch (error.kind) {
    case 'account_not_linked':
      // Decision (a): the address already has a profile, and this provider may
      // not open it. Point at the ways that can — Google only when it is on and
      // was not the one that just failed.
      return googleOn && error.provider !== 'google'
        ? t('oauthError_account_not_linked_google')
        : t('oauthError_account_not_linked');
    case 'email_not_found':
      return provider
        ? t('oauthError_email_not_found', { provider })
        : t('oauthError_email_not_found_unnamed');
    case 'cancelled':
      return provider ? t('oauthError_cancelled', { provider }) : t('oauthError_failed_unnamed');
    case 'failed':
      return provider ? t('oauthError_failed', { provider }) : t('oauthError_failed_unnamed');
  }
}

/**
 * One form, one submit button per provider: works without JavaScript, and the
 * action re-checks that the provider named is really on.
 */
function ProviderButtons({
  providers,
  locale,
  next,
}: {
  providers: SignInProvider[];
  locale: string;
  next: string;
}) {
  const t = useTranslations('SignIn');
  return (
    <form action={providerSignInAction} className="space-y-2">
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="next" value={next} />
      {providers.map((provider) =>
        provider === 'apple' ? (
          <AppleButton key={provider} label={t('apple')} />
        ) : (
          <Button
            key={provider}
            type="submit"
            name="provider"
            value={provider}
            variant="secondary"
            block
          >
            {t(provider)}
          </Button>
        ),
      )}
    </form>
  );
}

/**
 * Sign in with Apple, drawn to Apple's Human Interface Guidelines for the web:
 * the black style, Apple's logo to the left of the title, the system font, and
 * the same size and shape as the other sign-in buttons (never less prominent).
 * Built in-house rather than with Apple's JS button, which would load a script
 * from Apple on every visit to /vhod — before anyone has chosen Apple.
 */
function AppleButton({ label }: { label: string }) {
  return (
    <Button
      type="submit"
      name="provider"
      value="apple"
      block
      className="bg-black font-[system-ui] text-white hover:bg-black/85 active:bg-black/85"
      iconLeft={
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
        </svg>
      }
    >
      {label}
    </Button>
  );
}
