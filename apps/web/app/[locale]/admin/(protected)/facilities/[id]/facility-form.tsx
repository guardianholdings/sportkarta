'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { useFormAction } from '@/lib/use-form-action';

import type { FacilityEditState } from '../actions';

const INITIAL: FacilityEditState = { error: null };

/**
 * The editor's form element, around fields the server page renders.
 *
 * Client-side only for useFormAction: a coordinate outside Bulgaria or a pin
 * moved out of the ambassador's municipalities used to redirect back to the
 * page, which re-rendered every field from the database — the name, sports and
 * surface just typed were gone (A-2). Now the refusal comes back as state above
 * the button, with the form exactly as the operator left it, and a save that
 * went through says so in the same place.
 */
export function FacilityEditForm({
  action,
  children,
}: {
  action: (state: FacilityEditState, formData: FormData) => Promise<FacilityEditState>;
  children: React.ReactNode;
}) {
  const t = useTranslations('AdminEdit');
  const [state, formProps, pending] = useFormAction(action, INITIAL);

  return (
    <form {...formProps} className="space-y-4 text-body-sm">
      {children}
      {state.error && (
        <p
          role="alert"
          className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-body-sm text-danger"
        >
          {state.error === 'location' ? t('locationInvalid') : t('locationOutOfScope')}
        </p>
      )}
      {state.saved !== undefined && (
        <p
          role="status"
          className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-body-sm text-success"
        >
          {state.saved > 0 ? t('saved', { count: state.saved }) : t('savedNone')}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {t('save')}
      </Button>
    </form>
  );
}
