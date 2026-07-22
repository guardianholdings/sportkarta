'use server';

import { getDb, sql } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { isUuid } from '@/lib/admin-data';
import { requireAdmin } from '@/lib/auth-session';

/**
 * Photo moderation v1: status flip on the photo row itself (facility_photos
 * has its own status lifecycle; facility_edits stays a facility-field audit).
 * Guarded on pending so double-clicks are no-ops.
 * TODO(stage-2): attribute decisions (moderated_by/moderated_at columns)
 * before photo moderation drives public content.
 */
export async function decidePhoto(photoId: string, decision: 'approved' | 'rejected') {
  await requireAdmin();
  if (!isUuid(photoId)) return;
  if (decision !== 'approved' && decision !== 'rejected') return;

  const db = getDb();
  await db.execute(sql`
    UPDATE facility_photos SET status = ${decision}::photo_status
    WHERE id = ${photoId} AND status = 'pending'
  `);
  revalidatePath('/admin/moderation');
}

/**
 * Report triage (Stage 2.2): flip a pending anonymous report to reviewed or
 * dismissed. Guarded on pending so repeat clicks are no-ops. The attached
 * photo (if any) is moderated separately via decidePhoto.
 */
export async function resolveReport(reportId: string, decision: 'reviewed' | 'dismissed') {
  await requireAdmin();
  if (!isUuid(reportId)) return;
  if (decision !== 'reviewed' && decision !== 'dismissed') return;

  const db = getDb();
  await db.execute(sql`
    UPDATE facility_reports SET status = ${decision}::report_status
    WHERE id = ${reportId} AND status = 'pending'
  `);
  revalidatePath('/admin/moderation');
}
