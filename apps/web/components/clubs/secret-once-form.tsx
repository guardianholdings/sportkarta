'use client';

import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { EMPTY_SECRET_STATE, type SecretFormState } from '@/lib/clubs/secret-form-state';
import { useFormAction } from '@/lib/use-form-action';

/**
 * An office form whose answer is a secret shown ONCE (0057): an API key, a
 * webhook signing secret, a door token — the open-data key form's rule
 * (components/opendata/create-key-form.tsx). Only the action's return value
 * carries the secret, so the form needs the response; it still submits
 * before hydration. The fields are the server page's children.
 */
export function SecretOnceForm({
  action,
  submit,
  strings,
  children,
}: {
  action: (state: SecretFormState, formData: FormData) => Promise<SecretFormState>;
  submit: string;
  strings: { created: string; copyHint: string; errors: Record<string, string> };
  children: ReactNode;
}) {
  const [state, formProps, pending] = useFormAction(action, EMPTY_SECRET_STATE, {
    resetWhen: (next) => next.secret !== null,
  });
  return (
    <div className="space-y-3">
      <form {...formProps} className="space-y-3">
        {children}
        <Button type="submit" disabled={pending}>
          {submit}
        </Button>
      </form>
      {state.error ? (
        <p role="alert" className="text-body-sm text-danger">
          {strings.errors[state.error] ?? strings.errors.invalid ?? state.error}
        </p>
      ) : null}
      {state.secret ? (
        <div
          role="status"
          className="space-y-2 rounded-card border border-warning-border bg-warning-bg p-3"
        >
          <p className="text-body-sm font-semibold text-warning">{strings.created}</p>
          {/* Selectable, never masked: there is no second chance to reveal it. */}
          <p className="overflow-x-auto break-all rounded-md border border-warning-border bg-surface p-2 font-mono text-caption">
            {state.secret}
          </p>
          <p className="text-caption text-warning">{strings.copyHint}</p>
        </div>
      ) : null}
    </div>
  );
}
