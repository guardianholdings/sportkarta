'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The two hidden lat/lon inputs every contribution form posts, plus the one-line
 * status the contributor reads.
 *
 * WHY A COMPONENT RATHER THAN FOUR COPIES: add, verify, condition and the
 * anonymous report all need the same fix, the same failure modes and the same
 * honest wording, and the /otmetka check-in form had already worked this out
 * once. A second hand-rolled copy is how "we ask for location" becomes "we ask
 * for location on three of the four screens".
 *
 * THE COORDINATES NEVER ENTER REACT STATE. They are written straight onto the
 * hidden inputs through refs, exactly as `checkin-form.tsx` does and for the
 * reason its comment gives: a value in state is a value that can be serialised
 * into a payload, a log or an error report later. Only the permission phase —
 * which carries no position — is state.
 *
 * IT NEVER BLOCKS SUBMISSION. The button is not disabled while locating and the
 * form posts fine with empty fields. Operator decision 2026-08-07: a
 * contribution made without a fix is accepted and recorded, it simply does not
 * publish or score. Blocking would trade a large number of honest edits for a
 * faker's thirty seconds in devtools.
 */
export type PositionPhase = 'asking' | 'granted' | 'denied' | 'unsupported' | 'insecure';

export function usePosition(): {
  phase: PositionPhase;
  latRef: React.RefObject<HTMLInputElement | null>;
  lonRef: React.RefObject<HTMLInputElement | null>;
} {
  const latRef = useRef<HTMLInputElement>(null);
  const lonRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<PositionPhase>('asking');

  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setPhase('unsupported');
      return;
    }
    // Geolocation is a secure-context API. Over plain HTTP the object still
    // EXISTS — so the check above passes — but every call fails immediately
    // with PERMISSION_DENIED and the browser never shows a prompt. Reported
    // as 'denied', that produced the one message a contributor cannot act on:
    // "turn location on" to somebody who was never asked and has nothing to
    // turn on. Name the real reason instead.
    if (!window.isSecureContext) {
      setPhase('insecure');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (latRef.current) latRef.current.value = String(position.coords.latitude);
        if (lonRef.current) lonRef.current.value = String(position.coords.longitude);
        setPhase('granted');
      },
      () => {
        setPhase('denied');
      },
      // Same budget as the check-in form: somebody standing on a pitch watching a
      // spinner is worse than a contribution recorded without a fix.
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
  }, []);

  return { phase, latRef, lonRef };
}

export function PositionFields({
  latRef,
  lonRef,
}: {
  latRef: React.RefObject<HTMLInputElement | null>;
  lonRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <>
      {/* NEVER name these lat/lon: the add-facility form also posts the
          FACILITY's pin under those names, and FormData.get() returns the
          first match — the member's fix (or an empty string, headless) would
          silently replace the coordinates the contributor actually picked. */}
      <input type="hidden" name="positionLat" ref={latRef} />
      <input type="hidden" name="positionLon" ref={lonRef} />
    </>
  );
}

/**
 * The status line. Deliberately states the CONSEQUENCE rather than the mechanism
 * — "this will wait for review" is what the contributor needs to decide whether
 * to walk over, and it is also the honest thing to say before they spend effort
 * on a form whose result will be held back.
 */
export function PositionNotice({
  phase,
  labels,
}: {
  phase: PositionPhase;
  labels: { locating: string; granted: string; denied: string; insecure?: string };
}) {
  if (phase === 'asking') {
    return <p className="text-caption text-text-muted">{labels.locating}</p>;
  }
  if (phase === 'granted') {
    return <p className="text-caption text-text-muted">{labels.granted}</p>;
  }
  return (
    <p className="rounded-md border border-warning-border bg-warning-bg p-3 text-caption text-warning">
      {phase === 'insecure' ? (labels.insecure ?? labels.denied) : labels.denied}
    </p>
  );
}
