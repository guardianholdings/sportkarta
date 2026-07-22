'use client';

import { useTranslations } from 'next-intl';
import { useActionState } from 'react';

import { Button } from '@/components/ui/button';

import { grantAmbassadorAction, type AmbassadorState } from './actions';

const INITIAL: AmbassadorState = { error: null };

export function GrantForm() {
  const t = useTranslations('AdminAmbassadors');
  const [state, action, pending] = useActionState<AmbassadorState, FormData>(
    grantAmbassadorAction,
    INITIAL,
  );

  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <label className="space-y-1">
        <span className="block text-sm font-medium">{t('grantEmailLabel')}</span>
        <input
          type="email"
          name="email"
          required
          className="w-72 rounded border border-neutral-300 px-3 py-2 text-sm"
        />
      </label>
      <Button type="submit" disabled={pending}>
        {t('grantSubmit')}
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-red-600">
          {t(`error_${state.error}`)}
        </p>
      )}
      {state.granted && (
        <p role="status" className="text-sm text-green-700">
          {t('granted', { email: state.granted })}
        </p>
      )}
    </form>
  );
}
