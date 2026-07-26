'use server';

import { getDb, sql } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { requireRole } from '@/lib/auth-session';

/**
 * The private-venues switches (0018). Both write the TARGET state the button
 * posted rather than "flip it", so a double submit settles instead of
 * flapping (same pattern as the digest panel). Admin-only: the master switch
 * publishes/unpublishes a whole category nationally, and per-business rows
 * gate someone's commercial presence — neither is municipality-scoped
 * moderation, so ambassadors are excluded.
 */

export async function setShowPaidAction(formData: FormData): Promise<void> {
  await requireRole('admin');
  const value = formData.get('value') === 'true' ? 'true' : 'false';
  await getDb().execute(
    sql`UPDATE app_settings SET value = ${value}, updated_at = now() WHERE key = 'public_show_paid'`,
  );
  revalidatePath('/admin/chastni');
}

export async function setBusinessVisibleAction(formData: FormData): Promise<void> {
  await requireRole('admin');
  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id <= 0) return;
  const visible = formData.get('visible') === 'true';
  await getDb().execute(sql`UPDATE businesses SET visible = ${visible} WHERE id = ${id}`);
  revalidatePath('/admin/chastni');
}
