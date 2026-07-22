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
          <span className="text-sm font-medium">{t('emailLabel')}</span>
          <input
            type="email"
            name="email"
            required
            autoFocus={!onCodeStep}
            autoComplete="email"
            inputMode="email"
            defaultValue={state.email}
            readOnly={onCodeStep}
            className="w-full rounded border border-neutral-300 px-3 py-2 read-only:bg-neutral-100"
          />
        </label>

        {onCodeStep && (
          <label className="block space-y-1">
            <span className="text-sm font-medium">{t('codeLabel')}</span>
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
              className="w-full rounded border border-neutral-300 px-3 py-2 tracking-widest"
            />
            <span className="block text-xs text-neutral-500">{t('codeHint')}</span>
          </label>
        )}

        {state.error && (
          <p role="alert" className="text-sm text-red-600">
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
          <div className="text-center text-xs text-neutral-500">{t('or')}</div>
          <Button type="submit" variant="outline" className="w-full">
            {t('google')}
          </Button>
        </form>
      )}

      <p className="text-xs text-neutral-500">{t('privacyNote')}</p>
    </div>
  );
}
