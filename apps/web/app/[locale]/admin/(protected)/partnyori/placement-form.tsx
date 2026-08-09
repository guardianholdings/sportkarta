'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import type { PlacementState } from './ad-actions';

/**
 * Add-a-placement form (docs/MONETISATION.md M4).
 *
 * Labels arrive PRE-TRANSLATED as props (the campaign-form rule): a client
 * component that called getTranslations would pull the whole message catalogue
 * into the browser bundle.
 *
 * There is no EDIT form, and that is a choice rather than an omission. A
 * placement is four facts and a file, sold for a fixed period; changing any of
 * them is a different sale. Delete-and-re-add keeps the exclusion constraint the
 * single arbiter of "one live ad per slot per period" — an edit form would have
 * to reason about moving a window across another placement's, which is exactly
 * the arithmetic the database already does correctly.
 */

export interface PlacementFormLabels {
  slot: string;
  slots: Record<string, string>;
  creative: string;
  creativeHint: string;
  url: string;
  altBg: string;
  altEn: string;
  altHint: string;
  startsOn: string;
  endsOn: string;
  submit: string;
  saved: string;
  errors: Record<string, string>;
  genericError: string;
}

const INITIAL: PlacementState = { error: null };

export function PlacementForm({
  action,
  labels,
  partnerId,
  slots,
}: {
  action: (state: PlacementState, formData: FormData) => Promise<PlacementState>;
  labels: PlacementFormLabels;
  partnerId: number;
  slots: readonly string[];
}) {
  const [state, formAction, pending] = useActionState<PlacementState, FormData>(action, INITIAL);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="partnerId" value={partnerId} />

      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{labels.slot}</span>
        {/* Raw select, matching campaign-form: the ui/select component is not
            what that file uses and consistency inside the admin beats it. */}
        <select
          name="slot"
          required
          className="rounded-md border border-line-strong bg-surface px-3 py-2 text-body-sm"
        >
          {slots.map((slot) => (
            <option key={slot} value={slot}>
              {labels.slots[slot] ?? slot}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{labels.creative}</span>
        <Input type="file" name="creative" accept="image/jpeg,image/png,image/webp" required />
        <span className="text-caption text-text-muted">{labels.creativeHint}</span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{labels.url}</span>
        <Input type="url" name="url" required maxLength={300} placeholder="https://" />
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{labels.altBg}</span>
        <Input type="text" name="altBg" required maxLength={200} />
        <span className="text-caption text-text-muted">{labels.altHint}</span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-caption font-medium text-ink-soft">{labels.altEn}</span>
        <Input type="text" name="altEn" maxLength={200} />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-ink-soft">{labels.startsOn}</span>
          <Input type="date" name="startsOn" required />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-caption font-medium text-ink-soft">{labels.endsOn}</span>
          <Input type="date" name="endsOn" required />
        </label>
      </div>

      {state.error && (
        <p role="alert" className="text-body-sm text-danger">
          {labels.errors[state.error] ?? labels.genericError}
        </p>
      )}
      {state.saved && (
        <p role="status" className="text-body-sm text-success">
          {labels.saved}
        </p>
      )}

      <Button type="submit" disabled={pending}>
        {labels.submit}
      </Button>
    </form>
  );
}
