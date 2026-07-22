'use client';

import { useActionState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

import { loginAction, type LoginState } from './actions';

export function LoginForm() {
  const t = useTranslations('AdminLogin');
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, {
    error: null,
  });

  return (
    <form action={action} className="space-y-4">
      <label className="block space-y-1">
        <span className="text-sm font-medium">{t('tokenLabel')}</span>
        <input
          type="password"
          name="token"
          required
          autoFocus
          autoComplete="off"
          className="w-full rounded border border-neutral-300 px-3 py-2"
        />
      </label>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {state.error === 'throttled' ? t('throttled') : t('error')}
        </p>
      )}
      <Button type="submit" disabled={pending} className="w-full">
        {t('submit')}
      </Button>
      <p className="text-xs text-neutral-500">{t('todo')}</p>
    </form>
  );
}
