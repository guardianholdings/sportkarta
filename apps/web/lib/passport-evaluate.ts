import { getBoss, PASSPORT_EVALUATE_QUEUE } from '@/lib/admin-boss';

/**
 * Ask the worker to re-fold a member's badges, after their write committed.
 *
 * CALL IT AFTER THE TRANSACTION, NEVER INSIDE ONE. Badge evaluation reads a
 * member's whole history (`passportEvents` is unbounded by design), and inside
 * `checkIn` a failure could roll back an attendance — breaking the rule the
 * whole anti-abuse layer rests on: attendance is a fact and is ALWAYS recorded,
 * only the payment stops. So the domain function commits first, and this runs
 * afterwards.
 *
 * BEST EFFORT, DELIBERATELY. Every failure is logged and swallowed. A member
 * must never see their contribution fail because a queue was unreachable, and
 * nothing is lost when it does: `ownPassport()` still evaluates on their next
 * /pasport visit exactly as it always did, and the insert is ON CONFLICT DO
 * NOTHING, so the job is an accelerator rather than the system of record.
 *
 * The message, never the error object — a pg-boss connection error can embed
 * the connection string.
 */
export async function enqueuePassportEvaluate(userId: string): Promise<void> {
  try {
    const boss = await getBoss();
    await boss.send(PASSPORT_EVALUATE_QUEUE, { userId });
  } catch (error: unknown) {
    console.error(
      '[passport] could not enqueue badge evaluation:',
      error instanceof Error ? error.message : 'unknown',
    );
  }
}
