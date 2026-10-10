'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { isUuid } from '@/lib/admin-data';
import { requireAdmin, requireRole } from '@/lib/auth-session';
import {
  decidePhoto as decidePhotoScoped,
  resolveReport as resolveReportScoped,
  decideFacility as decideFacilityScoped,
  unpublishPhoto as unpublishPhotoScoped,
  isRefusal,
  type DecisionResult,
  type FacilityDecision,
  type PhotoDecision,
  type ReportDecision,
} from '@/lib/moderation';
import { enqueueModerationNotify } from '@/lib/moderation-notify';
import { decideNotice as decideNoticeInDb, type NoticeDecision } from '@/lib/notices';
import { getStorage } from '@/lib/storage';

/**
 * Moderation v2 (Stage 3.3). These actions no longer decide anything
 * themselves: they establish who is calling and hand off to lib/moderation.ts,
 * where the municipality scope is part of the statement. An ambassador acting
 * outside their municipalities updates zero rows, and nothing is logged.
 *
 * requireAdmin here means "ambassador or admin" — the scope, not the rank, is
 * what limits an ambassador.
 *
 * A REFUSAL IS EXPLAINED (0034). Rejecting a photo, taking one down or marking
 * a facility gone posts a `reason` from the form's select; lib/moderation.ts refuses to decide
 * without a valid one, and once the decision has COMMITTED the member it
 * restricted is sent a statement of reasons by the worker. The enqueue is after
 * the transaction on purpose: a queue outage must never undo a decision.
 */

function reasonFrom(formData: FormData | undefined): string | null {
  const value = formData?.get('reason');
  return typeof value === 'string' ? value : null;
}

async function explain(decision: string, result: DecisionResult): Promise<void> {
  if (result.applied && isRefusal(decision) && result.decisionId) {
    await enqueueModerationNotify({ kind: 'decision', decisionId: result.decisionId });
  }
}

export async function decidePhoto(photoId: string, decision: PhotoDecision, formData?: FormData) {
  const user = await requireAdmin();
  if (!isUuid(photoId)) return;
  if (decision !== 'approved' && decision !== 'rejected') return;

  // The storage adapter goes in so a rejection deletes the file — after the
  // decision has committed, never before (lib/moderation.ts).
  const result = await decidePhotoScoped(
    getDb(),
    { id: user.id, role: user.role },
    photoId,
    decision,
    getStorage(),
    reasonFrom(formData),
  );
  await explain(decision, result);
  revalidatePath('/admin/moderation');
}

/**
 * Take a published photo down (notice-and-action). Scoped like every other
 * decision: an ambassador can withdraw only photos in their municipalities, and
 * an out-of-scope id changes nothing and logs nothing. Like a rejection it
 * needs a reason, and the uploader is sent the statement of reasons.
 */
export async function unpublishPhoto(photoId: string, formData?: FormData) {
  const user = await requireAdmin();
  if (!isUuid(photoId)) return;

  const result = await unpublishPhotoScoped(
    getDb(),
    { id: user.id, role: user.role },
    photoId,
    getStorage(),
    reasonFrom(formData),
  );
  await explain('removed', result);
  revalidatePath('/admin/moderation');
}

export async function resolveReport(reportId: string, decision: ReportDecision) {
  const user = await requireAdmin();
  if (!isUuid(reportId)) return;
  if (decision !== 'reviewed' && decision !== 'dismissed') return;

  await resolveReportScoped(getDb(), { id: user.id, role: user.role }, reportId, decision);
  revalidatePath('/admin/moderation');
}

/** Crowd-submitted facilities awaiting a second pair of eyes. */
export async function decideFacility(
  facilityId: string,
  decision: FacilityDecision,
  formData?: FormData,
) {
  const user = await requireAdmin();
  if (!isUuid(facilityId)) return;
  if (decision !== 'verified' && decision !== 'gone') return;

  const result = await decideFacilityScoped(
    getDb(),
    { id: user.id, role: user.role },
    facilityId,
    decision,
    reasonFrom(formData),
  );
  await explain(decision, result);
  revalidatePath('/admin/moderation');
  revalidatePath('/admin/verify');
  // The facility editor decides through this action too (A-4); its list shows
  // the status.
  revalidatePath('/admin/facilities');
}

/**
 * Decide a notice from /signal. ADMIN ONLY — a notice can concern any page, not
 * a municipality, and answering a claim of illegality is the controller's act.
 * The role is checked again inside the UPDATE (lib/notices.ts).
 */
export async function decideNotice(noticeId: string, decision: NoticeDecision, formData: FormData) {
  const user = await requireRole('admin');
  if (!isUuid(noticeId)) return;
  if (decision !== 'actioned' && decision !== 'dismissed') return;

  const result = await decideNoticeInDb(getDb(), user.id, noticeId, decision, reasonFrom(formData));
  if (result.applied && result.notify) {
    await enqueueModerationNotify({ kind: 'notice_decided', noticeId });
  }
  revalidatePath('/admin/moderation');
}
