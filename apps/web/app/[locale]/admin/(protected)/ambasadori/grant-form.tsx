'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { useFormAction } from '@/lib/use-form-action';

import { grantAmbassadorAction, type AmbassadorState } from './actions';

const INITIAL: AmbassadorState = { error: null };

export function GrantForm() {
  const t = useTranslations('AdminAmbassadors');
  // A mistyped address comes back with the address still in the field to
  // correct; a grant clears it for the next one (A-2).
  const [state, formProps, pending] = useFormAction(grantAmbassadorAction, INITIAL, {
    resetWhen: (next) => next.granted !== undefined,
  });

  return (
    <form {...formProps} className="flex flex-wrap items-end gap-3">
      <label className="space-y-1">
        <span className="block text-caption font-medium text-ink-soft">{t('grantEmailLabel')}</span>
        <input
          type="email"
          name="email"
          required
          className="h-11 w-72 rounded-md border border-line-strong bg-surface px-3 text-body-sm text-ink focus-visible:shadow-[var(--ring)]"
        />
      </label>
      <Button type="submit" disabled={pending}>
        {t('grantSubmit')}
      </Button>
      {state.error && (
        <p role="alert" className="text-body-sm text-danger">
          {t(`error_${state.error}`)}
        </p>
      )}
      {state.granted && (
        <p role="status" className="text-body-sm text-success">
          {t('granted', { email: state.granted })}
        </p>
      )}
    </form>
  );
}
