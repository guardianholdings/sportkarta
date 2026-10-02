/**
 * The geolocation state machine behind `usePosition` (position-fields.tsx),
 * kept free of React so the one property that matters most — WHEN the browser
 * is asked — is provable in a plain unit test (tests/position-fields.test.ts).
 *
 * THE QUESTION IS ONLY EVER PUT FROM A TAP.
 *
 * Until 2026-09 the hook also asked on mount, "because it costs nothing where
 * it works". It cost a great deal: the anonymous report form mounts on every
 * facility page, so every visitor arriving from search got a location prompt
 * before touching anything — and the reflex answer to that is Block,
 * remembered for the whole origin, after which no form on the site could ever
 * get a fix again. Safari refused the gesture-less call anyway.
 *
 * So `request()` is called from the «Използвай моето местоположение» button,
 * from a check-in tap, or from the tap that opened a form (`askOnMount`) — and
 * `start()` on its own never puts the question. It only READS the permission
 * state (which never prompts) to do two things that ask nobody anything:
 * fetch silently for a member who already allowed it, and say up front that a
 * member has blocked it.
 */

export type PositionPhase =
  /** Nobody has asked yet, and the browser has not said no. */
  | 'idle'
  | 'asking'
  | 'granted'
  /** PERMISSION_DENIED: the browser will not ask again until the member unblocks the site. */
  | 'denied'
  /** Allowed (or never refused), but no fix came back: timeout, no signal. */
  | 'unavailable'
  | 'unsupported'
  | 'insecure';

/** The part of a PermissionStatus the controller reads and listens to. */
export type PermissionWatch = Pick<
  PermissionStatus,
  'state' | 'addEventListener' | 'removeEventListener'
>;

/** What the controller needs from the browser; the tests pass fakes. */
export interface PositionEnvironment {
  geolocation: Pick<Geolocation, 'getCurrentPosition'> | undefined;
  isSecureContext: boolean;
  permissions:
    { query: (descriptor: { name: 'geolocation' }) => Promise<PermissionWatch> } | undefined;
}

export interface PositionController {
  /** Put the question. Call ONLY from a user's tap. */
  request: () => void;
  /** On mount. Never prompts unless `askOnMount` says the mount was a tap. */
  start: (options: { askOnMount: boolean }) => Promise<void>;
  /** On unmount: late callbacks become no-ops and nothing new is asked. */
  dispose: () => void;
}

/**
 * What a component mounting with no tap behind it may do, given what the
 * Permissions API says.
 *
 * - 'granted' → fetch. The browser cannot show a prompt for a permission the
 *   member already gave, so this asks NOBODY anything; it only spares a
 *   returning member a tap.
 * - 'denied' → say so up front, with the way to undo it, rather than offering a
 *   button that fails instantly and silently.
 * - 'prompt', unknown, or no Permissions API (older Safari) → wait for a tap.
 *   Fetching here IS the prompt-on-load this module exists to prevent.
 */
export function mountDecision(state: PermissionState | null): 'fetch' | 'denied' | 'wait' {
  if (state === 'granted') return 'fetch';
  if (state === 'denied') return 'denied';
  return 'wait';
}

/** Same budget as ever: a member on a pitch watching a spinner is worse than an unscored contribution. */
export const POSITION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 8000,
  maximumAge: 60_000,
};

export function createPositionController(
  env: PositionEnvironment,
  sink: {
    setPhase: (phase: PositionPhase) => void;
    /** Writes the fix into the form. The coordinates go nowhere else. */
    writeFix: (latitude: number, longitude: number) => void;
  },
): PositionController {
  let phase: PositionPhase = 'idle';
  let latestRequest = 0;
  let hasFix = false;
  let disposed = false;
  let watched: PermissionWatch | null = null;

  function set(next: PositionPhase) {
    if (disposed) return;
    phase = next;
    sink.setPhase(next);
  }

  function blocked(): 'unsupported' | 'insecure' | null {
    if (!env.geolocation) return 'unsupported';
    // Geolocation is a secure-context API. Over plain HTTP the object still
    // EXISTS — so the check above passes — but every call fails immediately
    // with PERMISSION_DENIED and the browser never shows a prompt. Reported as
    // 'denied', that produced the one message a contributor cannot act on:
    // "turn location on" to somebody who was never asked.
    if (!env.isSecureContext) return 'insecure';
    return null;
  }

  /**
   * Taps may overlap — a member who sees "locating…" hang (Safari has been
   * seen to drop a request without calling either callback) will tap again.
   * The rule that keeps overlapping requests honest: ANY success wins and is
   * final; a failure only counts if it answers the newest request and no fix
   * has arrived.
   */
  function request() {
    if (disposed) return;
    const reason = blocked();
    if (reason) {
      set(reason);
      return;
    }
    if (hasFix) return;
    const id = ++latestRequest;
    set('asking');
    env.geolocation?.getCurrentPosition(
      (position) => {
        if (disposed) return;
        sink.writeFix(position.coords.latitude, position.coords.longitude);
        hasFix = true;
        set('granted');
      },
      (error) => {
        if (hasFix || id !== latestRequest) return;
        // Only PERMISSION_DENIED is something the member has to go and undo in
        // the browser's settings. A timeout or "no signal" is worth another
        // tap, and telling that member to "unblock the site" would be wrong.
        set(error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      POSITION_OPTIONS,
    );
  }

  /**
   * The permission changed while this form was on screen. A signed-in member
   * sees the verify AND the condition form on one facility page, each with its
   * own button, and /dobavi has the pin picker's own locate button beside the
   * form: answering the question in one place used to leave every other form
   * still waiting for its own tap. The same rule as on mount applies — act
   * only on an answer already given, which cannot put up a prompt.
   */
  function onPermissionChange() {
    if (disposed || hasFix || !watched) return;
    const decision = mountDecision(watched.state);
    // 'asking' is this form's own request, which will answer for itself.
    if (decision === 'fetch' && phase !== 'asking') request();
    else if (decision === 'denied' && phase === 'idle') set('denied');
    // Unblocked in the browser's settings: stop saying the site is blocked.
    else if (decision === 'wait' && phase === 'denied') set('idle');
  }

  async function start({ askOnMount }: { askOnMount: boolean }) {
    const reason = blocked();
    if (reason) {
      // A synchronous fact about the browser, not a question to the member:
      // say it now instead of offering a button that can only fail.
      set(reason);
      return;
    }
    if (askOnMount) request();
    if (!env.permissions) return;
    let status: PermissionWatch | null = null;
    try {
      status = await env.permissions.query({ name: 'geolocation' });
    } catch {
      // Safari before 16 throws on the 'geolocation' name: that is "unknown",
      // which means waiting for a tap.
    }
    if (!status || disposed) return;
    watched = status;
    status.addEventListener('change', onPermissionChange);
    if (askOnMount) return;
    const decision = mountDecision(status.state);
    if (decision === 'fetch') request();
    // Only over an untouched notice: if the member has tapped in the meantime,
    // their own request's answer is the truer one.
    else if (decision === 'denied' && phase === 'idle') set('denied');
  }

  return {
    request,
    start,
    dispose: () => {
      disposed = true;
      watched?.removeEventListener('change', onPermissionChange);
      watched = null;
    },
  };
}
