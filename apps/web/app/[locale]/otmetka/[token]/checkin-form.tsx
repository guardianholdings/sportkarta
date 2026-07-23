'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import { redeemCheckinAction, type CheckinState } from './actions';

/**
 * The member's side of a QR check-in (docs/ROADMAP.md §7, Stage 5.4).
 *
 * A client component for exactly one reason: only the browser can answer
 * `navigator.geolocation`. Everything else is a plain form post.
 *
 * THE LOCATION IS OPTIONAL AND THE PAGE SAYS SO. Declining the permission
 * prompt still checks you in — it just does not pay — so the button is enabled
 * from the start and never waits on the prompt. A check-in flow that blocks
 * until somebody grants location access would strand every member who tapped
 * "no" once, months ago, and cannot remember how to undo it.
 *
 * The coordinates go into hidden fields and travel exactly once, to be turned
 * into a distance in metres server-side. They are never stored (migration 0014).
 */

type Permission = 'idle' | 'asking' | 'granted' | 'denied' | 'unsupported';

interface Props {
  token: string;
  occurrenceId: string;
  labels: {
    submit: string;
    pending: string;
    locating: string;
    locationDenied: string;
    locationHint: string;
    outcomes: Record<string, string>;
    errors: Record<string, string>;
    genericError: string;
  };
}

const initial: CheckinState = { status: 'idle' };

export function CheckinForm({ token, occurrenceId, labels }: Props) {
  const [state, submit, pending] = useActionState(redeemCheckinAction, initial);
  const [permission, setPermission] = useState<Permission>('idle');
  const latRef = useRef<HTMLInputElement>(null);
  const lonRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setPermission('unsupported');
      return;
    }
    setPermission('asking');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        // Written straight into the form fields rather than into React state:
        // the value is used once, at submit, and keeping it out of state keeps
        // it out of anything that might later serialise the component.
        if (latRef.current) latRef.current.value = String(position.coords.latitude);
        if (lonRef.current) lonRef.current.value = String(position.coords.longitude);
        setPermission('granted');
      },
      () => {
        setPermission('denied');
      },
      // A short timeout: a member standing on a pitch waiting for a spinner is
      // worse than a member checked in without points.
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
  }, []);

  if (state.status === 'ok') {
    return (
      <p role="status" className="rounded border border-neutral-200 bg-neutral-50 p-4">
        {labels.outcomes[state.outcome ?? ''] ?? labels.outcomes.scored}
      </p>
    );
  }

  return (
    <form action={submit} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="occurrenceId" value={occurrenceId} />
      <input type="hidden" name="lat" ref={latRef} />
      <input type="hidden" name="lon" ref={lonRef} />

      <Button type="submit" disabled={pending}>
        {pending ? labels.pending : labels.submit}
      </Button>

      {permission === 'asking' && <p className="text-sm text-neutral-500">{labels.locating}</p>}
      {(permission === 'denied' || permission === 'unsupported') && (
        <p className="text-sm text-amber-800">{labels.locationDenied}</p>
      )}
      {permission === 'granted' && (
        <p className="text-sm text-neutral-500">{labels.locationHint}</p>
      )}

      {state.status === 'error' && (
        <p role="alert" className="text-sm text-red-700">
          {labels.errors[state.error ?? ''] ?? labels.genericError}
        </p>
      )}
    </form>
  );
}
