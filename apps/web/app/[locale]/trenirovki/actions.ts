'use server';

import { deleteTraining, getDb, recordTraining, setTrainingConsent } from '@sportkarta/db';
import { normalizeTraining, parseDuration, type TrainingProblem } from '@sportkarta/lib/training';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth-session';

/**
 * Logging a personal training (operator request 2026-07-26).
 *
 * THE MEMBER IS RESOLVED WITH requireUser() AND EVERY WRITE IS KEYED BY THAT ID.
 * Nothing about whose training is being recorded, edited or deleted comes from
 * the form — a hidden user field here would let anyone write into anyone else's
 * history, and delete out of it.
 *
 * NO POINTS ARE AWARDED and nothing is enqueued for badge evaluation. That is
 * the operator decision of 2026-07-26 and it is also why this file is short:
 * a training is a fact about a member, not a transaction against the ledger.
 */

export interface TrainingFormState {
  problems: TrainingProblem[];
  /** Set once, so the form can announce success without a query string. */
  saved?: boolean;
}

const EMPTY: TrainingFormState = { problems: [] };

function optionalInt(raw: FormDataEntryValue | null): number | null {
  const text = String(raw ?? '').trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? Math.trunc(value) : Number.NaN;
}

/**
 * Record one manual training.
 *
 * `source` is hardcoded to `manual` and `evidence` is derived from it rather
 * than read from the form. A form field for either would let a member post
 * `source=garmin&evidence=qr_verified` and mint the top evidence tier for a row
 * they typed — which is the whole thing the CHECK in migration 0027 exists to
 * make impossible, and the application must not be the weaker layer.
 */
export async function logTrainingAction(
  _previous: TrainingFormState,
  formData: FormData,
): Promise<TrainingFormState> {
  const user = await requireUser();

  const durationS = parseDuration(String(formData.get('duration') ?? ''));
  const rawDate = String(formData.get('startedAt') ?? '').trim();
  // A `datetime-local` value has no zone. It is a wall clock the member read off
  // their own life, so it is interpreted as Sofia — the same civil timezone
  // every other boundary in this product uses — rather than as UTC, which would
  // silently shift an evening training into the next day.
  const startedAt = rawDate === '' ? new Date(Number.NaN) : new Date(`${rawDate}:00+03:00`);

  const distanceKm = optionalInt(formData.get('distanceKm'));

  const result = normalizeTraining({
    sport: String(formData.get('sport') ?? ''),
    startedAt,
    durationS: durationS ?? 0,
    distanceM: distanceKm === null ? null : distanceKm * 1000,
    elevationM: optionalInt(formData.get('elevationM')),
    facilityId: String(formData.get('facilityId') ?? '').trim() || null,
    note: String(formData.get('note') ?? ''),
    source: 'manual',
  });

  if (!result.ok) return { problems: result.problems };

  await recordTraining(getDb(), user.id, result.value);
  revalidatePath('/trenirovki');
  revalidatePath('/klasirane');
  return { ...EMPTY, saved: true };
}

/** Remove one of the member's own trainings. Scoped by user id in the SQL itself. */
export async function deleteTrainingAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const id = String(formData.get('id') ?? '').trim();
  if (id === '') return;

  await deleteTraining(getDb(), user.id, id);
  revalidatePath('/trenirovki');
  revalidatePath('/klasirane');
}

/**
 * Grant or withdraw one of the two connected-app consents.
 *
 * The form posts the TARGET state rather than a toggle, matching the passport
 * visibility control, so a double submission converges instead of flapping — and
 * a flapping consent control is one that can leave data stored under a "no".
 *
 * Withdrawal deletes the stored rows inside `setTrainingConsent`; see
 * db/src/training.ts. Nothing here needs to remember that, which is the point.
 */
export async function setTrainingConsentAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const kind = String(formData.get('kind') ?? '');
  if (kind !== 'route' && kind !== 'health') return;
  const granted = String(formData.get('granted') ?? '') === 'true';

  await setTrainingConsent(getDb(), user.id, kind, granted);
  revalidatePath('/trenirovki');
}
