'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { isUuid } from '@/lib/admin-data';
import { requireAdmin } from '@/lib/auth-session';
import {
  decidePhoto as decidePhotoScoped,
  resolveReport as resolveReportScoped,
  decideFacility as decideFacilityScoped,
  type FacilityDecision,
  type PhotoDecision,
  type ReportDecision,
} from '@/lib/moderation';

/**
 * Moderation v2 (Stage 3.3). These actions no longer decide anything
 * themselves: they establish who is calling and hand off to lib/moderation.ts,
 * where the municipality scope is part of the statement. An ambassador acting
 * outside their municipalities updates zero rows, and nothing is logged.
 *
 * requireAdmin here means "ambassador or admin" — the scope, not the rank, is
 * what limits an ambassador.
 */

export async function decidePhoto(photoId: string, decision: PhotoDecision) {
  const user = await requireAdmin();
  if (!isUuid(photoId)) return;
  if (decision !== 'approved' && decision !== 'rejected') return;

  await decidePhotoScoped(getDb(), { id: user.id, role: user.role }, photoId, decision);
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
export async function decideFacility(facilityId: string, decision: FacilityDecision) {
  const user = await requireAdmin();
  if (!isUuid(facilityId)) return;
  if (decision !== 'verified' && decision !== 'gone') return;

  await decideFacilityScoped(getDb(), { id: user.id, role: user.role }, facilityId, decision);
  revalidatePath('/admin/moderation');
  revalidatePath('/admin/verify');
}
