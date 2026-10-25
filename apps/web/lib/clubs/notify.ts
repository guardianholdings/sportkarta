import {
  CLUB_MATERIALIZE_QUEUE,
  CLUB_NOTIFY_QUEUE,
  type ClubMaterializeJob,
  type ClubNotifyJob,
} from '@sportkarta/lib/clubs';

import { getBoss, recordEnqueueFailure } from '../admin-boss';

/**
 * Enqueue club work for the worker — AFTER the transaction that caused it has
 * committed, never inside it: a mail must not go out for a change that rolled
 * back (the session-mail rule, apps/web/lib/account-deletion.ts).
 *
 * BEST EFFORT, like enqueuePassportEvaluate: a failure is counted on the health
 * page and logged by kind, and the member's action still succeeds. Nothing is
 * lost that matters — the materializer also runs hourly, and a missed booking
 * confirmation is a missed courtesy, not a missed booking.
 *
 * Payloads are ids only (lib/src/clubs/jobs.ts).
 */
async function send(queue: string, data: object, singletonKey?: string): Promise<void> {
  try {
    const boss = await getBoss();
    try {
      await boss.send(queue, data, singletonKey ? { singletonKey } : {});
    } catch (error: unknown) {
      recordEnqueueFailure('send');
      throw error;
    }
  } catch (error: unknown) {
    console.error(
      `[clubs] could not enqueue ${queue}:`,
      error instanceof Error ? error.message : 'unknown',
    );
  }
}

export async function enqueueClubNotify(job: ClubNotifyJob): Promise<void> {
  if (process.env.CLUBS_ENABLED !== 'true') return;
  await send(CLUB_NOTIFY_QUEUE, job);
}

/** Materialize one class now (after create/edit), so its week fills in at once. */
export async function enqueueClubMaterialize(classId: string): Promise<void> {
  const job: ClubMaterializeJob = { classId };
  await send(CLUB_MATERIALIZE_QUEUE, job, classId);
}
