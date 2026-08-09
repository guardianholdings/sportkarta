'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useActionState, useId } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { googleSignInAction, signInAction, type SignInState } from './actions';

const INITIAL: SignInState = { step: 'email', email: '', error: null };

export function SignInForm({ googleEnabled, next }: { googleEnabled: boolean; next: string }) {
  const t = useTranslations('SignIn');
  const locale = useLocale();
  const [state, action, pending] = useActionState<SignInState, FormData>(signInAction, INITIAL);
  const onCodeStep = state.step === 'code';
  const codeHintId = useId();

  return (
    <div className="space-y-6">
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
              {t('codeHint')}
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

      {googleEnabled && !onCodeStep && (
        <form action={googleSignInAction} className="space-y-2">
          <input type="hidden" name="next" value={next} />
          <div className="text-center text-caption text-text-muted">{t('or')}</div>
          <Button type="submit" variant="secondary" block>
            {t('google')}
          </Button>
        </form>
      )}

      <p className="text-caption text-text-muted">{t('privacyNote')}</p>
    </div>
  );
}
