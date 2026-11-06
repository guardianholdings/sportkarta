import { unstable_isUnrecognizedActionError, unstable_rethrow } from 'next/navigation';

/**
 * Why a server-action call from the browser came back without a usable answer.
 *
 * - `stale_form`: the server no longer knows the action. Next answers 404 with
 *   `x-nextjs-action-not-found`. Action ids are salted with
 *   `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`: without a fixed one every build
 *   mints a new key and every deploy invalidates every open form (what this
 *   was written against); with the stable key of PR #50 (derived from
 *   `AUTH_SECRET` at build time) an ordinary deploy keeps every id, and this
 *   is the safety net for what the key does not cover: an action renamed or
 *   moved between builds, a key rotation, a build made without the key. No
 *   action ran, so nothing was saved; the form has to reload to get the new
 *   action ids.
 * - `no_answer`: the call left the browser but its answer never arrived or
 *   couldn't be read: a cut connection (`TypeError: Failed to fetch`) or a
 *   page that isn't an action answer, such as the proxy's 502 during a
 *   deploy ("An unexpected response was received from the server."). The
 *   action may or may not have run.
 *
 * An error the ACTION threw is neither. React forwards it to the browser as
 * an Error with a string `digest` (in production and in development), and it
 * is rethrown here, so it goes on to the error page as before, with its retry
 * and its error report: sending again would only fail again. The add action
 * never gets this far, its own net answers with a reference code
 * (lib/contributions/unexpected-failure.ts).
 */
export type ActionFailure = 'stale_form' | 'no_answer';

/**
 * Sorts an error thrown by a client-side server-action call (B2). Next's own
 * control-flow throws (`redirect()`, `notFound()` and the like) are rethrown
 * untouched, so a successful action still navigates.
 */
export function classifyActionFailure(error: unknown): ActionFailure {
  unstable_rethrow(error);
  if (unstable_isUnrecognizedActionError(error)) return 'stale_form';
  if (thrownByTheAction(error)) throw error;
  return 'no_answer';
}

/** A server-thrown error arrives with a `digest`; the browser's own throws have none. */
function thrownByTheAction(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'digest' in error &&
    typeof (error as { digest?: unknown }).digest === 'string'
  );
}
