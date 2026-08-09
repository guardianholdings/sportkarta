'use client';

import { useActionState } from 'react';

import { createApiKeyAction } from '@/app/[locale]/danni/klyuchove/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EMPTY_KEY_STATE } from '@/lib/opendata/key-form-state';

/**
 * Issuing an API key (Stage 6.1).
 *
 * A CLIENT COMPONENT, unlike the other panels in this app, and for one reason:
 * the key is shown ONCE. Only the action's return value carries it, so the form
 * needs the response — a plain `<form action={…}>` re-renders the page and the
 * plaintext is gone. `useActionState` still submits without JavaScript (React
 * 19 progressive enhancement), so this is not a form that only works after
 * hydration; it is a form whose result needs a place to land.
 *
 * The key is deliberately NOT redirected into a URL, put in a query parameter
 * or stored in a cookie for the next render — all three would write a live
 * credential somewhere it outlives the moment.
 */
export function CreateKeyForm({
  strings,
}: {
  strings: {
    labelField: string;
    labelHint: string;
    create: string;
    created: string;
    copyHint: string;
    errors: Record<string, string>;
  };
}) {
  const [state, action, pending] = useActionState(createApiKeyAction, EMPTY_KEY_STATE);

  return (
    <div className="space-y-3">
      <form action={action} className="space-y-2">
        <label className="block text-body-sm font-medium" htmlFor="label">
          {strings.labelField}
        </label>
        <Input id="label" name="label" type="text" maxLength={60} required />
        <p className="text-caption text-ink-soft">{strings.labelHint}</p>
        <Button type="submit" disabled={pending}>
          {strings.create}
        </Button>
      </form>

      {state.error ? (
        <p className="text-body-sm text-danger">{strings.errors[state.error] ?? state.error}</p>
      ) : null}

      {state.issued ? (
        <div className="space-y-2 rounded-card border border-warning-border bg-warning-bg p-3">
          <p className="text-body-sm font-medium text-warning">{strings.created}</p>
          {/* Selectable, not a link and not masked: the member has to be able
              to copy it, and there is no second chance to reveal it. */}
          <p className="overflow-x-auto rounded-md border border-warning-border bg-surface p-2 font-mono text-caption">
            {state.issued.key}
          </p>
          <p className="text-caption text-warning">{strings.copyHint}</p>
        </div>
      ) : null}
    </div>
  );
}
