'use client';

import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';
import { useFormAction } from '@/lib/use-form-action';

import { rsvpAction, withdrawAction, type RsvpState } from './actions';

/**
 * Join / leave. Two forms rather than one with a hidden intent field: the
 * button a member presses and the action that runs are then the same decision,
 * and a stale rendered page cannot withdraw somebody who meant to join.
 *
 * LEAVING ASKS FIRST (S-7). The joined button turns into «Отписвам се» in the
 * same place the member just tapped, and a second tap used to withdraw them at
 * once — for a waitlisted member that is a place in the queue they cannot get
 * back, because re-joining draws a new ticket at the back. Joining does not ask:
 * it costs nothing to undo.
 */

interface Props {
  occurrenceId: string;
  /** The viewer's own RSVP, or null when they are not signed up. */
  status: 'going' | 'waitlisted' | null;
  /** Session at capacity — joining takes a waitlist place, and the button says so. */
  full: boolean;
  /** «Имате запазено място…» / «Вие сте номер 2…», already resolved; null when not signed up. */
  statusText: string | null;
  labels: {
    join: string;
    joinFull: string;
    leave: string;
    pending: string;
    /** The confirmation before withdrawing a place… */
    leaveConfirm: string;
    /** …and before leaving the waitlist, which says re-joining goes to the back. */
    leaveConfirmWaitlisted: string;
    /** Keyed by SessionErrorCode; the caller passes the whole namespace. */
    errors: Record<string, string>;
    genericError: string;
  };
}

const initial: RsvpState = { status: 'idle' };

export function RsvpForm({ occurrenceId, status, full, statusText, labels }: Props) {
  // useFormAction rather than useActionState: nothing here is typed, but the
  // hook is the one form contract in the app, and it keeps a pre-hydration tap
  // posting to the action.
  const [joinState, joinForm, joining] = useFormAction(rsvpAction, initial);
  const [leaveState, leaveForm, leaving] = useFormAction(withdrawAction, initial);
  const attending = status !== null;
  const state = attending ? leaveState : joinState;
  const pending = joining || leaving;

  return (
    <div className="space-y-2">
      {/* ALWAYS in the DOM, so the change it reports is announced: a join
          re-renders the page with the new status, and a live region that only
          appears together with its text is one many screen readers never read.
          Empty, it is sr-only and takes no space. */}
      <p role="status" className={statusText ? 'text-body-sm text-ink-soft' : 'sr-only'}>
        {statusText}
      </p>
      <form {...(attending ? leaveForm : joinForm)}>
        <input type="hidden" name="occurrenceId" value={occurrenceId} />
        {/* C1: join is recruitment, leave is churn — the event value follows
            the action. Still a closed-vocabulary reference on both branches
            (lib/analytics-events.ts). */}
        {attending ? (
          <ConfirmButton
            message={status === 'waitlisted' ? labels.leaveConfirmWaitlisted : labels.leaveConfirm}
            disabled={pending}
            className={buttonVariants({ variant: 'secondary' })}
            data-umami-event={ANALYTICS_EVENTS.sessionRsvpLeave}
          >
            {pending ? labels.pending : labels.leave}
          </ConfirmButton>
        ) : (
          <Button
            type="submit"
            disabled={pending}
            data-umami-event={ANALYTICS_EVENTS.sessionRsvpJoin}
          >
            {pending ? labels.pending : full ? labels.joinFull : labels.join}
          </Button>
        )}
      </form>
      {state.status === 'error' && (
        <p role="alert" className="text-body-sm text-danger">
          {/* Every code has a message; the fallback exists so an unmapped one
              still says something, rather than rendering the raw slug. */}
          {labels.errors[state.error ?? ''] ?? labels.genericError}
        </p>
      )}
    </div>
  );
}
