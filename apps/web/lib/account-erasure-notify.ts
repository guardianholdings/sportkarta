import type { Enqueue } from './account-deletion';
import { getBoss } from './admin-boss';

/**
 * The enqueue hook EVERY erasure hands to deleteAccount — the member's own on
 * /profil and an admin's on /admin/akaunti/[id]. An erased organiser's series
 * is cancelled by a trigger whichever way the account went, so whichever way it
 * went, the members holding RSVPs must get the `series_cancelled` notice; one
 * shared hook is what keeps the two paths from drifting apart.
 *
 * Best-effort, like every session.notify enqueue: deleteAccount calls it after
 * the erasure has COMMITTED, and a queue that is briefly down must not turn a
 * completed erasure into an error page. The message is logged, never the error
 * object (the sesiya actions' rule) — a pg-boss error can carry the payload or
 * the connection string.
 */
export const enqueueErasureNotice: Enqueue = async (queue, data) => {
  try {
    await (await getBoss()).send(queue, data);
  } catch (error: unknown) {
    console.error(
      '[gdpr] could not enqueue session cancellation notice:',
      error instanceof Error ? error.message : 'unknown',
    );
  }
};
