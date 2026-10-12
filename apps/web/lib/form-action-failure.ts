import { unstable_isUnrecognizedActionError, unstable_rethrow } from 'next/navigation';

/**
 * Why a server-action call from the browser came back without a usable answer.
 *
 * - `stale_form`: the server no longer knows the action. Next answers 404 with
 *   `x-nextjs-action-not-found`, which happens when the site was deployed
 *   while the form was open. No action ran, so nothing was saved; the form
 *   has to reload to get the new action ids.
 * - `no_answer`: the call left the browser but its answer never arrived or
 *   couldn't be read: a cut connection (`TypeError: Failed to fetch`) or a
 *   page that isn't an action answer, such as the proxy's 502 during a
 *   deploy ("An unexpected response was received from the server."). The
 *   action may or may not have run.
 */
export type ActionFailure = 'stale_form' | 'no_answer';

/**
 * Sorts an error thrown by a client-side server-action call (B2). Next's own
 * control-flow throws (`redirect()`, `notFound()` and the like) are rethrown
 * untouched, so a successful action still navigates.
 */
export function classifyActionFailure(error: unknown): ActionFailure {
  unstable_rethrow(error);
  return unstable_isUnrecognizedActionError(error) ? 'stale_form' : 'no_answer';
}
