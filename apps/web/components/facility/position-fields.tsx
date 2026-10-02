'use client';

import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import {
  createPositionController,
  type PositionController,
  type PositionPhase,
} from './position-controller';

export type { PositionPhase } from './position-controller';

/**
 * The two hidden lat/lon inputs every contribution form posts, plus the one-line
 * status the contributor reads.
 *
 * WHY A COMPONENT RATHER THAN FIVE COPIES: add, verify, condition, the
 * anonymous report and the /otmetka check-in all need the same fix, the same
 * failure modes and the same honest wording. A second hand-rolled copy is how
 * "we ask for location" becomes "we ask for location on three of the four
 * screens".
 *
 * THE COORDINATES NEVER ENTER REACT STATE. They are written straight onto the
 * hidden inputs through refs: a value in state is a value that can be
 * serialised into a payload, a log or an error report later. Only the
 * permission phase — which carries no position — is state.
 *
 * IT NEVER BLOCKS SUBMISSION. The button is not disabled while locating and the
 * form posts fine with empty fields. Operator decision 2026-08-07: a
 * contribution made without a fix is accepted and recorded, it simply does not
 * publish or score. Blocking would trade a large number of honest edits for a
 * faker's thirty seconds in devtools.
 */

/**
 * The position hook: a thin React shell over position-controller.ts, which
 * holds the rules (when the browser may be asked, how overlapping taps
 * resolve) where a unit test can reach them.
 *
 * `askOnMount` is ONLY for a component that mounts FROM a tap — the report
 * form's body, which exists because the visitor just tapped «Съобщи проблем».
 * Everything else leaves it off and asks from the button in PositionNotice.
 */
export function usePosition(options: { askOnMount?: boolean } = {}): {
  phase: PositionPhase;
  latRef: React.RefObject<HTMLInputElement | null>;
  lonRef: React.RefObject<HTMLInputElement | null>;
  request: () => void;
} {
  const { askOnMount = false } = options;
  const latRef = useRef<HTMLInputElement>(null);
  const lonRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<PositionPhase>('idle');
  const controller = useRef<PositionController | null>(null);

  useEffect(() => {
    const created = createPositionController(
      {
        geolocation: 'geolocation' in navigator ? navigator.geolocation : undefined,
        isSecureContext: window.isSecureContext,
        // Absent outside a secure context and in old browsers; the typings
        // say otherwise.
        permissions: (navigator as Partial<Navigator>).permissions,
      },
      {
        setPhase,
        writeFix: (latitude, longitude) => {
          if (latRef.current) latRef.current.value = String(latitude);
          if (lonRef.current) lonRef.current.value = String(longitude);
        },
      },
    );
    controller.current = created;
    void created.start({ askOnMount });
    return () => {
      created.dispose();
      if (controller.current === created) controller.current = null;
    };
  }, [askOnMount]);

  const request = useCallback(() => {
    controller.current?.request();
  }, []);

  return { phase, latRef, lonRef, request };
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

export interface PositionLabels {
  idle: string;
  locating: string;
  granted: string;
  denied: string;
  unavailable: string;
  unsupported: string;
  insecure: string;
  /** The tap target: «Използвай моето местоположение». */
  request: string;
}

/**
 * The member-facing copy for add, verify and condition. The anonymous report
 * brings its own (Report.location): it has no points and always waits for a
 * moderator, so the members' wording would promise it things it cannot do.
 */
export function useContributeLocationLabels(): PositionLabels {
  const t = useTranslations('Contribute');
  return {
    idle: t('locationIdle'),
    locating: t('locating'),
    granted: t('locationGranted'),
    denied: t('locationDenied'),
    unavailable: t('locationUnavailable'),
    unsupported: t('locationUnsupported'),
    insecure: t('locationInsecure'),
    request: t('locationRetry'),
  };
}

/** Phases worth a warning box rather than a neutral line. */
const WARNING_PHASES = new Set<PositionPhase>(['denied', 'unavailable', 'unsupported', 'insecure']);

/**
 * Whether the tap target is on screen. Exported for the tests.
 *
 * It stays in EVERY state until a fix is granted — including 'asking', which
 * is exactly where a dropped request leaves a member with nothing else to tap,
 * and 'denied', where it is how the member retries after unblocking the site.
 * The only exceptions are the two states in which the browser refuses before
 * it ever asks, where a button could only fail again.
 */
export function showsRequestButton(phase: PositionPhase): boolean {
  return phase !== 'granted' && phase !== 'unsupported' && phase !== 'insecure';
}

/**
 * The status line. Deliberately states the CONSEQUENCE rather than the mechanism
 * — "this will wait for review" is what the contributor needs to decide whether
 * to walk over, and it is also the honest thing to say before they spend effort
 * on a form whose result will be held back.
 *
 * `aria-live` rather than `role="status"`: the thanks line after a submit is
 * the form's one status region, and a second one would make "the status" of
 * the form ambiguous to assistive technology (and to the e2e suite).
 */
export function PositionNotice({
  phase,
  labels,
  onRequest,
}: {
  phase: PositionPhase;
  labels: PositionLabels;
  onRequest: () => void;
}) {
  const warning = WARNING_PHASES.has(phase);
  const message = {
    idle: labels.idle,
    asking: labels.locating,
    granted: labels.granted,
    denied: labels.denied,
    unavailable: labels.unavailable,
    unsupported: labels.unsupported,
    insecure: labels.insecure,
  }[phase];

  // One stable element whatever the phase: a live region that is swapped for
  // another element is not announced, so only its classes and text change.
  const box =
    phase === 'granted'
      ? ''
      : warning
        ? 'rounded-md border border-warning-border bg-warning-bg p-3'
        : 'rounded-md border border-line bg-paper-sunk p-3';

  return (
    <div className={`flex flex-col items-start gap-2 ${box}`}>
      <p
        aria-live="polite"
        className={warning ? 'text-caption text-warning' : 'text-caption text-text-muted'}
      >
        {message}
      </p>
      {showsRequestButton(phase) && (
        <Button type="button" variant="secondary" size="sm" onClick={onRequest}>
          {labels.request}
        </Button>
      )}
    </div>
  );
}
