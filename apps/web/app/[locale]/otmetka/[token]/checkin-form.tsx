'use client';

import { useTranslations } from 'next-intl';
import { useActionState, useEffect, useRef, useState } from 'react';

import { usePosition, type PositionPhase } from '@/components/facility/position-fields';
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
 * prompt still checks you in — it just does not pay. A check-in flow that
 * blocks until somebody grants location access would strand every member who
 * tapped "no" once, months ago, and cannot remember how to undo it.
 *
 * BUT THE TAP WAITS FOR THE FIX. A check-in is recorded ONCE per member and
 * occurrence (`ON CONFLICT DO NOTHING`, lib/sessions/checkin.ts): a check-in
 * sent without coordinates is final, and a second scan only answers "already
 * checked in". So the natural action — scan, tap straight away — used to lose
 * the points for good whenever the tap beat the location fix. Now the tap asks
 * for the position (the tap is the gesture a browser wants behind that
 * question), waits for it, and only then posts. Recording WITHOUT a position
 * is still possible, but only as a deliberate second choice («без точки»)
 * once asking has failed or is taking a while — never by accident.
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

/**
 * The line under the button, per phase — literal keys, for the same reasons as
 * OUTCOME_KEYS. Idle and granted both read as the promise about what the
 * position is used for; everything else says what went wrong and what the
 * member can still do.
 */
export const PHASE_KEYS = {
  idle: 'locationHint',
  asking: 'locating',
  granted: 'locationHint',
  denied: 'locationDenied',
  unavailable: 'locationUnavailable',
  unsupported: 'locationUnsupported',
  insecure: 'locationInsecure',
} as const satisfies Record<PositionPhase, string>;

const PHASE_WARNS: Record<PositionPhase, boolean> = {
  idle: false,
  asking: false,
  granted: false,
  denied: true,
  unavailable: true,
  unsupported: true,
  insecure: true,
};

/**
 * Whether a tap on «Отбелязвам присъствие» may post right away. Exported for
 * the tests. Only with a fix in hand — or where no fix can ever come (no
 * geolocation, or an insecure origin that refuses before asking), in which case
 * waiting would only strand the member.
 */
export function submitsImmediately(phase: PositionPhase): boolean {
  return phase === 'granted' || phase === 'unsupported' || phase === 'insecure';
}

/**
 * How long a check-in tap waits on an unanswered request before the «без точки»
 * choice appears beside it. Long enough that the member who is about to get a
 * fix is not invited to give it up; short enough that one whose request was
 * dropped is not left staring at "locating…".
 */
export const UNSCORED_OFFER_AFTER_MS = 3_000;

/**
 * Whether the deliberate «без точки» choice is on screen. Exported for the
 * tests. Offered once asking has visibly failed, or once a tap has waited
 * UNSCORED_OFFER_AFTER_MS on a request that may never answer (Safari has been
 * seen to drop one silently), so a member is never left with no way to record
 * their attendance — and never offered it in the instant before a fix lands.
 */
export function offersUnscored(phase: PositionPhase, stalled: boolean): boolean {
  if (phase === 'denied' || phase === 'unavailable') return true;
  return stalled && phase === 'asking';
}

export function CheckinForm({ token, occurrenceId }: Props) {
  const t = useTranslations('Checkin');
  const [state, submit, pending] = useActionState(redeemCheckinAction, initial);
  // Never asks on load: a member who already allowed location gets the fix
  // silently, everybody else is asked by the check-in tap itself.
  const { phase, latRef, lonRef, request } = usePosition();
  const formRef = useRef<HTMLFormElement>(null);
  // Set by a check-in tap that is waiting for the fix; cleared once it posts.
  const [waiting, setWaiting] = useState(false);
  // That tap has waited UNSCORED_OFFER_AFTER_MS with no answer.
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    setStalled(false);
    if (!waiting || phase !== 'asking') return;
    const timer = setTimeout(() => setStalled(true), UNSCORED_OFFER_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waiting, phase]);

  useEffect(() => {
    if (!waiting || phase !== 'granted') return;
    setWaiting(false);
    // The fix is already in the hidden inputs (written before the phase
    // flipped), so this posts WITH it. requestSubmit rather than a direct call
    // to the action so the form goes through the same path as a tap.
    formRef.current?.requestSubmit();
  }, [waiting, phase]);

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
          : t(
              state.outcome === 'scored' ? OUTCOME_KEYS.unscored_method : outcomeKey(state.outcome),
            )}
      </p>
    );
  }

  function onCheckinClick(event: React.MouseEvent<HTMLButtonElement>) {
    if (submitsImmediately(phase)) return;
    // Hold the post and ask instead; the effect above posts once the fix lands.
    // A repeat tap while waiting asks again, which is the only recourse when a
    // request was dropped without an answer.
    event.preventDefault();
    setWaiting(true);
    request();
  }

  return (
    <form ref={formRef} action={submit} className="space-y-3">
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
        onClick={onCheckinClick}
        data-umami-event={ANALYTICS_EVENTS.checkinSubmit}
      >
        {pending ? t('pending') : t('submit')}
      </Button>

      <p
        aria-live="polite"
        className={
          PHASE_WARNS[phase] ? 'text-body-sm text-warning' : 'text-body-sm text-text-muted'
        }
      >
        {t(PHASE_KEYS[phase])}
      </p>

      {offersUnscored(phase, stalled) && (
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          disabled={pending}
          // Deliberate: posts with whatever the hidden fields hold (nothing),
          // and stops a late fix from posting a second time behind it.
          onClick={() => setWaiting(false)}
        >
          {t('submitWithoutLocation')}
        </Button>
      )}

      {state.status === 'error' && (
        <p role="alert" className="text-body-sm text-danger">
          {t(errorKey(state.error))}
        </p>
      )}
    </form>
  );
}
