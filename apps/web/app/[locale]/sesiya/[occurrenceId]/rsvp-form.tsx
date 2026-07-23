'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';

import { rsvpAction, withdrawAction, type RsvpState } from './actions';

/**
 * Join / leave. Two forms rather than one with a hidden intent field: the
 * button a member presses and the action that runs are then the same decision,
 * and a stale rendered page cannot withdraw somebody who meant to join.
 */

interface Props {
  occurrenceId: string;
  attending: boolean;
  labels: {
    join: string;
    joinFull: string;
    leave: string;
    pending: string;
    /** Keyed by SessionErrorCode; the caller passes the whole namespace. */
    errors: Record<string, string>;
    genericError: string;
  };
}

const initial: RsvpState = { status: 'idle' };

export function RsvpForm({ occurrenceId, attending, labels }: Props) {
  const [joinState, join, joining] = useActionState(rsvpAction, initial);
  const [leaveState, leave, leaving] = useActionState(withdrawAction, initial);
  const state = attending ? leaveState : joinState;

  return (
    <div className="space-y-2">
      <form action={attending ? leave : join}>
        <input type="hidden" name="occurrenceId" value={occurrenceId} />
        <Button
          type="submit"
          disabled={joining || leaving}
          variant={attending ? 'secondary' : 'primary'}
        >
          {joining || leaving ? labels.pending : attending ? labels.leave : labels.join}
        </Button>
      </form>
      {state.status === 'error' && (
        <p role="alert" className="text-sm text-red-700">
          {/* Every code has a message; the fallback exists so an unmapped one
              still says something, rather than rendering the raw slug. */}
          {labels.errors[state.error ?? ''] ?? labels.genericError}
        </p>
      )}
    </div>
  );
}
