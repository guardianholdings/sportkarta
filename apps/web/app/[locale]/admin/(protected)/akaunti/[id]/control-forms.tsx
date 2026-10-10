'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useId } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useFormAction } from '@/lib/use-form-action';

import type { ControlState } from './actions';

/**
 * The two account controls that take typed input (0033). The one-click ones
 * (lift, reset name, force private, end sessions) are plain forms with a
 * ConfirmButton on the page itself; these two need a round trip that can come
 * back with an error, so they hold useFormAction — which, unlike a bare
 * useActionState, leaves the reason or the typed email in place for a retry
 * (A-2).
 */

const INITIAL: ControlState = { error: null, done: false };

type BoundControl = (prev: ControlState, formData: FormData) => Promise<ControlState>;

export function SuspendForm({ action, maxLength }: { action: BoundControl; maxLength: number }) {
  const t = useTranslations('AdminAccounts.controls');
  const [state, formProps, pending] = useFormAction(action, INITIAL);
  const hintId = useId();

  return (
    <form {...formProps} className="space-y-2">
      {/* The hint is described-by, not inside the label, so the field's
          accessible name stays the short label alone. */}
      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{t('suspendReasonLabel')}</span>
        <Textarea
          name="reason"
          required
          maxLength={maxLength}
          rows={2}
          size="sm"
          aria-describedby={hintId}
        />
      </label>
      <p id={hintId} className="text-caption text-text-muted">
        {t('suspendReasonHint')}
      </p>
      {state.error && (
        <p role="alert" className="text-body-sm text-danger">
          {t(`error.${state.error}`)}
        </p>
      )}
      <Button type="submit" variant="danger" size="sm" disabled={pending}>
        {t('suspendSubmit')}
      </Button>
    </form>
  );
}

export function EraseForm({ action, email }: { action: BoundControl; email: string }) {
  const t = useTranslations('AdminAccounts.controls');
  const locale = useLocale();
  const [state, formProps, pending] = useFormAction(action, INITIAL);

  return (
    <form {...formProps} className="space-y-2">
      {/* Locale only, for the redirect back to the list. The expected
          confirmation is read from the database, never from this form. */}
      <input type="hidden" name="locale" value={locale} />
      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">
          {t('eraseConfirmLabel', { email })}
        </span>
        <Input type="text" name="confirmation" required autoComplete="off" spellCheck={false} />
      </label>
      {state.error && (
        <p role="alert" className="text-body-sm text-danger">
          {t(`error.${state.error}`)}
        </p>
      )}
      <Button type="submit" variant="danger" size="sm" disabled={pending}>
        {t('eraseSubmit')}
      </Button>
    </form>
  );
}
