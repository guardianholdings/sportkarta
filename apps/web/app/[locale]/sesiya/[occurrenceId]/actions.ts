'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { getBoss, SESSION_NOTIFY_QUEUE } from '@/lib/admin-boss';
import { requireUser } from '@/lib/auth-session';
import { contributionRateLimiter } from '@/lib/contribution-rate-limit';
import { SessionError } from '@/lib/sessions/errors';
import { rsvp, withdraw } from '@/lib/sessions/rsvp';

/**
 * Joining and leaving a session (docs/ROADMAP.md §6, Stage 4.2).
 *
 * NOTHING IS SENT FROM A REQUEST. Both actions enqueue `session.notify` and
 * return; the worker resolves account ids to addresses at send time and claims
 * the notification ledger before the SMTP handoff. Sending inline would tie a
 * member's "I'm in" button to the availability of a mail relay, and would put
 * an SMTP timeout inside a form submission.
 *
 * The enqueue is deliberately AFTER the transaction has committed and is
 * deliberately not awaited into the failure path: a queue that is briefly down
 * must not roll back an RSVP that already succeeded. The cost is an
 * occasionally missing confirmation email, which is the cheaper failure — and
 * the reminder job will still find them.
 */

export interface RsvpState {
  status: 'idle' | 'ok' | 'error';
  /** i18n key suffix under Session.error.* */
  error?: string;
  rsvpStatus?: 'going' | 'waitlisted';
  position?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Best-effort enqueue. A failure here is logged and swallowed on purpose — see
 * the file header. The message, never the error object: a pg-boss connection
 * error can embed the connection string.
 */
async function notify(payload: Record<string, unknown>): Promise<void> {
  try {
    const boss = await getBoss();
    await boss.send(SESSION_NOTIFY_QUEUE, payload);
  } catch (error: unknown) {
    console.error(
      '[sesiya] could not enqueue session notification:',
      error instanceof Error ? error.message : 'unknown',
    );
  }
}

export async function rsvpAction(_prev: RsvpState, formData: FormData): Promise<RsvpState> {
  const user = await requireUser();
  if (!contributionRateLimiter.check(user.id).allowed) {
    return { status: 'error', error: 'rate_limited' };
  }
  const occurrenceId = String(formData.get('occurrenceId') ?? '');
  if (!UUID_RE.test(occurrenceId)) return { status: 'error', error: 'occurrence_not_found' };

  try {
    const result = await rsvp(getDb(), user.id, occurrenceId);
    if (result.joined) {
      await notify({
        reason: result.status === 'going' ? 'rsvp_confirmed' : 'rsvp_waitlisted',
        occurrenceId,
        // Account ids, never addresses: a job row outlives the account it names.
        userIds: [user.id],
      });
    }
    revalidatePath(`/sesiya/${occurrenceId}`);
    return { status: 'ok', rsvpStatus: result.status, position: result.position };
  } catch (error: unknown) {
    if (error instanceof SessionError) return { status: 'error', error: error.code };
    throw error;
  }
}

export async function withdrawAction(_prev: RsvpState, formData: FormData): Promise<RsvpState> {
  const user = await requireUser();
  const occurrenceId = String(formData.get('occurrenceId') ?? '');
  if (!UUID_RE.test(occurrenceId)) return { status: 'error', error: 'occurrence_not_found' };

  try {
    const { promoted } = await withdraw(getDb(), user.id, occurrenceId);
    if (promoted.length > 0) {
      // Stage 4.1 promotes by arithmetic, with no code running — so this is the
      // one place anybody learns a spot opened. Without it a member finds out
      // by refreshing the page, which they have no reason to do.
      await notify({ reason: 'promoted', occurrenceId, userIds: promoted });
    }
    revalidatePath(`/sesiya/${occurrenceId}`);
    return { status: 'ok' };
  } catch (error: unknown) {
    if (error instanceof SessionError) return { status: 'error', error: error.code };
    throw error;
  }
}
