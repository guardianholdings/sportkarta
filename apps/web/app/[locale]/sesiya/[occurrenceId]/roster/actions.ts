'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth-session';
import { rosterRateLimiter } from '@/lib/contribution-rate-limit';
import { enqueuePassportEvaluate } from '@/lib/passport-evaluate';
import { checkIn } from '@/lib/sessions/checkin';
import { SessionError } from '@/lib/sessions/errors';

/**
 * Manual check-in from the organiser's roster deck (Stage 4.3).
 *
 * Fire-and-forget by design, like the admin one-click actions: the deck
 * re-renders from the database after every submit, so the row's state IS the
 * feedback, and a failed attempt (already checked in, window closed, occurrence
 * cancelled) simply leaves the row as it was. `checkIn` re-authorizes in SQL —
 * organiser of THIS series or admin, AND the member must hold an active RSVP
 * on this occurrence (`not_attending` otherwise) — so a forged member id
 * writes nothing, and the write is idempotent on (occurrence_id, user_id).
 *
 * An organiser check-in is a vouch: recorded, NEVER scored
 * (play_session_checkins_only_qr_scores), and `recorded_by` names the voucher.
 *
 * Badge evaluation is enqueued only for a check-in that was actually RECORDED
 * just now. It used to run in `finally` — after a refusal as well, and for
 * whatever member id the caller posted — so any account could queue unlimited
 * worker jobs by submitting random ids to a roster it does not organise.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function markPresentAction(occurrenceId: string, memberId: string): Promise<void> {
  const user = await requireUser();
  if (!UUID_RE.test(occurrenceId) || memberId === '') return;
  // Fire-and-forget like the rest of the deck: a throttled tick simply leaves
  // the row as it was, which is what the organiser sees.
  if (!rosterRateLimiter.check(user.id).allowed) return;

  let recorded = false;
  try {
    const result = await checkIn(getDb(), {
      occurrenceId,
      userId: memberId,
      actorId: user.id,
      method: 'organizer',
    });
    recorded = result.created;
  } catch (error: unknown) {
    if (error instanceof SessionError) return;
    throw error;
  } finally {
    revalidatePath(`/sesiya/${occurrenceId}/roster`);
    revalidatePath(`/sesiya/${occurrenceId}`);
  }

  // The MEMBER whose attendance was recorded, not the organiser who recorded
  // it: the badge belongs to whoever showed up. After the commit, never inside.
  if (recorded) await enqueuePassportEvaluate(memberId);
}
