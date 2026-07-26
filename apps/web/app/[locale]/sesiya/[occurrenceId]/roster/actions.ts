'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth-session';
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
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function markPresentAction(occurrenceId: string, memberId: string): Promise<void> {
  const user = await requireUser();
  if (!UUID_RE.test(occurrenceId) || memberId === '') return;

  try {
    await checkIn(getDb(), {
      occurrenceId,
      userId: memberId,
      actorId: user.id,
      method: 'organizer',
    });
  } catch (error: unknown) {
    if (error instanceof SessionError) return;
    throw error;
  } finally {
    // The MEMBER whose attendance was recorded, not the organiser who
    // recorded it: the badge belongs to whoever showed up.
    await enqueuePassportEvaluate(memberId);
    revalidatePath(`/sesiya/${occurrenceId}/roster`);
    revalidatePath(`/sesiya/${occurrenceId}`);
  }
}
