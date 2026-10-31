'use client';

import {
  setPassportVisibilityAction,
  type VisibilityFormState,
} from '@/app/[locale]/pasport/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useFormAction } from '@/lib/use-form-action';

const INITIAL: VisibilityFormState = { error: null };

/**
 * One passport-visibility button, as its own form.
 *
 * A client component for one reason: a REFUSED publish (no display name, S-1)
 * must be answered in words beside the button that caused it, and the answer
 * only exists once the action has returned. The panel around it stays a server
 * component, and `useFormAction` keeps the `action` prop on the form, so the
 * button still posts before hydration.
 *
 * Every string arrives resolved, so this reads no message namespace in the
 * browser (i18n/client-messages.ts stays as it is).
 */
export function VisibilityForm({
  isPublic,
  showActivity,
  label,
  variant = 'primary',
  nameHelp,
}: {
  /** The TARGET state the button posts — never "flip it" (see the panel). */
  isPublic: boolean;
  showActivity: boolean;
  label: string;
  variant?: 'primary' | 'secondary';
  /**
   * The publish control only. While the member has no display name, the form
   * asks for one beside the button and posts both together (UX audit,
   * «Publish passport»: it used to send them to /profil and back). The same
   * field answers a publish the server refused (a stale page).
   */
  nameHelp?: { required: boolean; text: string; label: string; tooLong: string };
}) {
  const [state, formProps, pending] = useFormAction(setPassportVisibilityAction, INITIAL);
  const askName = Boolean(nameHelp && (nameHelp.required || state.error !== null));

  return (
    <form {...formProps} className="flex flex-col gap-3">
      <input type="hidden" name="isPublic" value={isPublic ? 'true' : 'false'} />
      <input type="hidden" name="showActivity" value={showActivity ? 'true' : 'false'} />
      {askName && nameHelp && (
        <>
          {/* An alert only when it answers a press; on a plain page load it is
              just the explanation. */}
          <p
            role={state.error === 'name_required' ? 'alert' : undefined}
            className="text-body-sm text-ink"
          >
            {nameHelp.text}
          </p>
          <label className="flex flex-col gap-1.5">
            <span className="text-caption font-medium text-ink-soft">{nameHelp.label}</span>
            <Input
              type="text"
              name="displayName"
              required
              maxLength={60}
              autoComplete="nickname"
              aria-invalid={state.error !== null}
            />
          </label>
          {state.error === 'name_too_long' && (
            <p role="alert" className="text-body-sm text-danger">
              {nameHelp.tooLong}
            </p>
          )}
        </>
      )}
      {/* The Button primitive, not hand-rolled twins: the old pair had no
          visible focus ring, a 34px height and an off-scale radius — on the
          CONSENT control of the whole passport. */}
      <div>
        <Button type="submit" variant={variant} disabled={pending}>
          {label}
        </Button>
      </div>
    </form>
  );
}
