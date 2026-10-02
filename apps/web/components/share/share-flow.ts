import type { SharePayload } from '@sportkarta/lib/share';

/**
 * The OS-share attempt behind `ShareSheet`'s main button, as a plain async
 * function over an injected navigator — so every branch can be exercised in
 * Node, where there is no share sheet to tap.
 *
 * Two defects shaped it, both of which made the most-used share do less than it
 * looked like it did:
 *
 * 1. THE FILE SHARE CARRIED NO LINK. The story image is tried first on every
 *    phone that can share files, and that branch passed the caption without the
 *    URL — so a friend received a picture and a sentence and no way to the
 *    page. The URL now rides in the text, the one field every target keeps
 *    alongside a file (a separate `url` makes some targets drop the file).
 *
 * 2. A FAILED SHARE DID NOTHING. The catch swallowed every rejection as if it
 *    were a cancel. But `share()` must run inside the tap's user activation,
 *    and the story is fetched first: on a slow connection the activation lapses
 *    (Safari: after about five seconds), `share()` rejects with
 *    NotAllowedError, and the button went dead. Now the fetch is capped so the
 *    share starts while the tap still counts, and anything but the member's own
 *    cancel opens the fallback panel.
 */

/**
 * How long a tap waits for the story image before sharing without it. Well
 * inside the activation window, so the text share that follows still counts as
 * the member's own gesture.
 */
export const STORY_WAIT_MS = 2500;

/** The slice of `Navigator` this needs — injectable for tests. */
export interface ShareNavigator {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
}

export type ShareOutcome = 'shared' | 'cancelled' | 'panel';

/** The caption with the link on its own line — what a file share must carry. */
export function captionWithLink(payload: SharePayload): string {
  return `${payload.text}\n${payload.url}`;
}

/** The member dismissing the OS sheet — the one rejection that is not a failure. */
export function isShareCancel(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** Resolves to the promise's value, or to null once `ms` has passed. */
export function within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(null);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Try the OS share sheet: the story file when there is one in time and the
 * browser takes files, the text + link otherwise. `'panel'` tells the caller to
 * open its fallback panel — no share API, or a share that failed for any reason
 * other than the member's own cancel.
 */
export async function attemptShare(
  nav: ShareNavigator | null,
  payload: SharePayload,
  storyFile: () => Promise<File | null>,
  waitMs = STORY_WAIT_MS,
): Promise<ShareOutcome> {
  if (!nav || typeof nav.share !== 'function') return 'panel';
  try {
    const file = payload.storyPath ? await within(storyFile(), waitMs) : null;
    // `canShare` must be asked BEFORE sharing: Safari throws rather than
    // returning false when handed files it will not take, and the throw is
    // indistinguishable from the member cancelling.
    if (file && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
      await nav.share({ files: [file], text: captionWithLink(payload), title: payload.text });
      return 'shared';
    }
    await nav.share({ text: payload.text, url: payload.url });
    return 'shared';
  } catch (error) {
    // A cancelled sheet rejects too, and opening the panel then would punish
    // the member for changing their mind. Every OTHER rejection — lapsed
    // activation, a refused payload — is a share that did not happen, and a
    // button that silently does nothing is the dead control this component's
    // own rules forbid.
    return isShareCancel(error) ? 'cancelled' : 'panel';
  }
}
