'use client';

import {
  setPassportVisibilityAction,
  type VisibilityFormState,
} from '@/app/[locale]/pasport/actions';
import { Button } from '@/components/ui/button';
import { Link } from '@/i18n/navigation';
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
   * The publish control only. While the member has no display name the button
   * gives way to the reason and a link to the profile, where the name is set;
   * the same words answer a publish the server refused (a stale page).
   */
  nameHelp?: { required: boolean; text: string; link: string };
}) {
  const [state, formProps, pending] = useFormAction(setPassportVisibilityAction, INITIAL);
  const refused = state.error === 'name_required';

  if (nameHelp && (nameHelp.required || refused)) {
    return (
      <div className="space-y-3">
        {/* An alert only when it answers a press: inserted in place of the
            button, it is announced; on a plain page load it is just the
            explanation. */}
        <p role={refused ? 'alert' : undefined} className="text-body-sm text-ink">
          {nameHelp.text}
        </p>
        <Button asChild>
          <Link href="/profil">{nameHelp.link}</Link>
        </Button>
      </div>
    );
  }

  return (
    <form {...formProps} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="isPublic" value={isPublic ? 'true' : 'false'} />
      <input type="hidden" name="showActivity" value={showActivity ? 'true' : 'false'} />
      {/* The Button primitive, not hand-rolled twins: the old pair had no
          visible focus ring, a 34px height and an off-scale radius — on the
          CONSENT control of the whole passport. */}
      <Button type="submit" variant={variant} disabled={pending}>
        {label}
      </Button>
    </form>
  );
}
