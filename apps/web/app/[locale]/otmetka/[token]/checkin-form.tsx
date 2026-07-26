'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ANALYTICS_EVENTS } from '@/lib/analytics-events';

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
 *
 * WHY THIS TRANSLATES ITSELF instead of taking pre-resolved `labels` props (the
 * shape it had until 2026-07-26): the success string now carries the number of
 * points earned, and that number only exists AFTER the server action returns.
 * A string resolved on the server during the page render cannot have `{points}`
 * filled in later, so the outcome copy has to be resolved here, on the client,
 * once the action has answered. `useTranslations` is available because the root
 * [locale] layout wraps the tree in NextIntlClientProvider — the same reason
 * obekt/[slug]/verify-form.tsx already does this.
 */

type Permission = 'idle' | 'asking' | 'granted' | 'denied' | 'unsupported';

interface Props {
  token: string;
  occurrenceId: string;
}

const initial: CheckinState = { status: 'idle' };

/**
 * Outcome and error codes are mapped to LITERAL message keys rather than
 * interpolated (`t('outcome.' + code)`), for two reasons: the keys stay
 * greppable from the catalogue, and next-intl throws on a key that does not
 * exist — so a new outcome code arriving from the domain layer would crash the
 * success screen instead of falling back.
 */
const OUTCOME_KEYS = {
  scored: 'outcome.scored',
  unscored_method: 'outcome.unscored_method',
  unscored_no_location: 'outcome.unscored_no_location',
  unscored_out_of_range: 'outcome.unscored_out_of_range',
  unscored_daily_cap: 'outcome.unscored_daily_cap',
  unscored_already: 'outcome.unscored_already',
} as const;

const ERROR_KEYS = {
  rate_limited: 'error.rate_limited',
  disabled: 'disabled',
  invalid_checkin_token: 'error.invalid_checkin_token',
  occurrence_cancelled: 'error.occurrence_cancelled',
  occurrence_not_found: 'error.occurrence_not_found',
  checkin_window_closed: 'error.checkin_window_closed',
  not_organizer: 'error.not_organizer',
} as const;

function outcomeKey(outcome: string | undefined): string {
  return OUTCOME_KEYS[outcome as keyof typeof OUTCOME_KEYS] ?? OUTCOME_KEYS.unscored_method;
}

function errorKey(code: string | undefined): string {
  return ERROR_KEYS[code as keyof typeof ERROR_KEYS] ?? 'error.generic';
}

export function CheckinForm({ token, occurrenceId }: Props) {
  const t = useTranslations('Checkin');
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
    const points = state.pointsAwarded ?? 0;
    // "scored" is the only outcome that names a figure, and it must never name
    // a zero: the anti-abuse layer never refuses a check-in, so an attendance
    // that earned nothing is a recorded fact, not a failure, and "you received
    // 0 points" reads as a punishment for it. If the ledger paid nothing, fall
    // back to the neutral recorded-only sentence.
    const scoredWithPoints = state.outcome === 'scored' && points > 0;
    return (
      <p role="status" className="rounded-card border border-line bg-paper-sunk p-4">
        {scoredWithPoints
          ? t(OUTCOME_KEYS.scored, { points })
          : t(state.outcome === 'scored' ? OUTCOME_KEYS.unscored_method : outcomeKey(state.outcome))}
      </p>
    );
  }

  return (
    <form action={submit} className="space-y-3">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="occurrenceId" value={occurrenceId} />
      <input type="hidden" name="lat" ref={latRef} />
      <input type="hidden" name="lon" ref={lonRef} />

      {/* C1: THAT a check-in was attempted, never its outcome. The unscored
          results (out of range, daily cap) describe the anti-abuse layer's
          behaviour toward one person, which is a behavioural record rather than
          a product metric — see rule 2 in lib/analytics-events.ts. */}
      <Button
        type="submit"
        disabled={pending}
        data-umami-event={ANALYTICS_EVENTS.checkinSubmit}
      >
        {pending ? t('pending') : t('submit')}
      </Button>

      {permission === 'asking' && <p className="text-body-sm text-text-muted">{t('locating')}</p>}
      {(permission === 'denied' || permission === 'unsupported') && (
        <p className="text-body-sm text-warning">{t('locationDenied')}</p>
      )}
      {permission === 'granted' && (
        <p className="text-body-sm text-text-muted">{t('locationHint')}</p>
      )}

      {state.status === 'error' && (
        <p role="alert" className="text-body-sm text-danger">
          {t(errorKey(state.error))}
        </p>
      )}
    </form>
  );
}
