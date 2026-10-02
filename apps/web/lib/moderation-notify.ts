import { getBoss } from '@/lib/admin-boss';

/**
 * Moderation mail (migration 0034) — the web app's half, which only ENQUEUES.
 * The worker (apps/worker/src/moderation-mail-job.ts) resolves the recipient at
 * send time and claims the idempotency ledger, so the payload is an id and a
 * kind and never an address: a job row outlives the account it would name.
 */
export const MODERATION_NOTIFY_QUEUE = 'moderation.notify';

export type ModerationNotifyJob =
  | { kind: 'decision'; decisionId: number }
  | { kind: 'notice_received' | 'notice_decided'; noticeId: string };

/**
 * Ask the worker to send one moderation mail, AFTER the decision committed.
 *
 * BEST EFFORT, like `enqueuePassportEvaluate`: a moderator's decision must never
 * fail because a queue was unreachable, and the decision itself is already
 * durable. What is lost is the courtesy copy, which is why the failure is
 * logged — by category, never with the payload's ids or the error object (a
 * pg-boss connection error can embed the connection string).
 */
export async function enqueueModerationNotify(job: ModerationNotifyJob): Promise<void> {
  try {
    const boss = await getBoss();
    await boss.send(MODERATION_NOTIFY_QUEUE, job);
  } catch (error: unknown) {
    console.error(
      `[moderation] could not enqueue ${job.kind} mail:`,
      error instanceof Error ? error.message : 'unknown',
    );
  }
}
