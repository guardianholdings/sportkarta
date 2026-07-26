'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth-session';
import { enqueuePassportEvaluate } from '@/lib/passport-evaluate';
import { checkinSecret } from '@/lib/checkin-config';
import { contributionRateLimiter } from '@/lib/contribution-rate-limit';
import { checkIn, type CheckinOutcome } from '@/lib/sessions/checkin';
import { SessionError } from '@/lib/sessions/errors';

/**
 * Redeeming a scanned check-in QR (docs/ROADMAP.md §7, Stage 5.4).
 *
 * WHO IS CHECKED IN IS THE SESSION COOKIE, NEVER THE FORM. The token names an
 * occurrence and is displayed once to everybody in the park; the only thing
 * that decides whose attendance this is, is who is signed in on the request.
 * There is deliberately no `userId` field to tamper with.
 *
 * The coordinates ARE taken from the form, because only the browser has them.
 * They are handed straight to the check-in query, turned into a distance in
 * metres, and never stored — see lib/sessions/checkin.ts and migration 0014.
 * They are also never trusted: the geofence is a cost, not a proof.
 */

export interface CheckinState {
  status: 'idle' | 'ok' | 'error';
  /** i18n key suffix under Checkin.error.* */
  error?: string;
  outcome?: CheckinOutcome;
  pointsAwarded?: number;
  distanceM?: number | null;
}

/**
 * A coordinate the browser actually produced, or null.
 *
 * Out-of-range and non-numeric values become null rather than an error: a
 * member whose phone reported nonsense should still be checked in, unpaid,
 * rather than shown a validation failure they cannot act on.
 */
function coordinate(value: FormDataEntryValue | null, limit: number): number | null {
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > limit) return null;
  return parsed;
}

export async function redeemCheckinAction(
  _prev: CheckinState,
  formData: FormData,
): Promise<CheckinState> {
  const user = await requireUser();
  if (!contributionRateLimiter.check(user.id).allowed) {
    return { status: 'error', error: 'rate_limited' };
  }

  const token = String(formData.get('token') ?? '');
  const occurrenceId = String(formData.get('occurrenceId') ?? '');
  const secret = checkinSecret();
  if (!secret) return { status: 'error', error: 'disabled' };

  try {
    const result = await checkIn(getDb(), {
      occurrenceId,
      // Both are the signed-in account. The QR authorises the SESSION, not the
      // person; the person is the cookie.
      userId: user.id,
      actorId: user.id,
      method: 'qr',
      token,
      secret,
      lat: coordinate(formData.get('lat'), 90),
      lon: coordinate(formData.get('lon'), 180),
    });
    revalidatePath(`/sesiya/${occurrenceId}`);
    // Enqueued for EVERY outcome, including the unscored ones: participation
    // badges count the attendance FACT, not the payment, so a check-in that
    // earned no points can still complete a badge.
    await enqueuePassportEvaluate(user.id);
    return {
      status: 'ok',
      outcome: result.outcome,
      pointsAwarded: result.pointsAwarded,
      distanceM: result.distanceM,
    };
  } catch (error: unknown) {
    if (error instanceof SessionError) return { status: 'error', error: error.code };
    throw error;
  }
}
