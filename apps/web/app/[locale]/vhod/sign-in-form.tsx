'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';

import { googleSignInAction, signInAction, type SignInState } from './actions';

const INITIAL: SignInState = { step: 'email', email: '', error: null };

export function SignInForm({ googleEnabled, next }: { googleEnabled: boolean; next: string }) {
  const t = useTranslations('SignIn');
  const locale = useLocale();
  const [state, action, pending] = useActionState<SignInState, FormData>(signInAction, INITIAL);
  const onCodeStep = state.step === 'code';

  return (
    <div className="space-y-6">
      <form action={action} className="space-y-4">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="step" value={state.step} />

        <label className="block space-y-1">
          <span className="text-body-sm font-medium">{t('emailLabel')}</span>
          <input
            type="email"
            name="email"
            required
            autoFocus={!onCodeStep}
            autoComplete="email"
            inputMode="email"
            defaultValue={state.email}
            readOnly={onCodeStep}
            className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 read-only:bg-paper-sunk"
          />
        </label>

        {onCodeStep && (
          <label className="block space-y-1">
            <span className="text-body-sm font-medium">{t('codeLabel')}</span>
            <input
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
              className="w-full rounded-md border border-line-strong bg-surface px-3 py-2 tracking-widest"
            />
            <span className="block text-caption text-text-muted">{t('codeHint')}</span>
          </label>
        )}

        {state.error && (
          <p role="alert" className="text-body-sm text-danger">
            {t(`error_${state.error}`)}
          </p>
        )}

        <Button type="submit" disabled={pending} className="w-full">
          {onCodeStep ? t('submitCode') : t('submitEmail')}
        </Button>
      </form>

      {googleEnabled && (
        <form action={googleSignInAction} className="space-y-2">
          <input type="hidden" name="next" value={next} />
          <div className="text-center text-caption text-text-muted">{t('or')}</div>
          <Button type="submit" variant="secondary" className="w-full">
            {t('google')}
          </Button>
        </form>
      )}

      <p className="text-caption text-text-muted">{t('privacyNote')}</p>
    </div>
  );
}
