'use server';

import { getDb } from '@sportkarta/db';
import { sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { isUuid } from '@/lib/admin-data';
import { requireAdmin } from '@/lib/admin-session';

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
