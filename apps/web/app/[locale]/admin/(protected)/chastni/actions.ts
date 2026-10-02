'use server';

import { getDb, sql } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { recordAdminAction } from '@/lib/admin-actions';
import { requireRole } from '@/lib/auth-session';

/**
 * The private-venues switches (0018). Both write the TARGET state the button
 * posted rather than "flip it", so a double submit settles instead of
 * flapping (same pattern as the digest panel). Admin-only: the master switch
 * publishes/unpublishes a whole category nationally, and per-business rows
 * gate someone's commercial presence — neither is municipality-scoped
 * moderation, so ambassadors are excluded.
 *
 * Each switch that actually changes something writes an `admin_actions` row in
 * the same transaction (0033), so "paid venues went live nationally last
 * Tuesday" has an author. The UPDATE only matches when the value differs, which
 * is what keeps a double submit from logging the same decision twice.
 */

export async function setShowPaidAction(formData: FormData): Promise<void> {
  const admin = await requireRole('admin');
  const value = formData.get('value') === 'true' ? 'true' : 'false';
  await getDb().transaction(async (tx) => {
    const changed = await tx.execute(sql`
      UPDATE app_settings SET value = ${value}, updated_at = now()
      WHERE key = 'public_show_paid' AND value IS DISTINCT FROM ${value}
      RETURNING key
    `);
    if (changed.rows.length === 0) return;
    await recordAdminAction(tx, admin.id, {
      action: 'setting_changed',
      detail: { key: 'public_show_paid', value },
    });
  });
  revalidatePath('/admin/chastni');
}

export async function setBusinessVisibleAction(formData: FormData): Promise<void> {
  const admin = await requireRole('admin');
  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id <= 0) return;
  const visible = formData.get('visible') === 'true';
  await getDb().transaction(async (tx) => {
    const changed = await tx.execute(sql`
      UPDATE businesses SET visible = ${visible}
      WHERE id = ${id} AND visible IS DISTINCT FROM ${visible}
      RETURNING id
    `);
    if (changed.rows.length === 0) return;
    await recordAdminAction(tx, admin.id, {
      action: 'business_visibility_changed',
      detail: { businessId: id, visible },
    });
  });
  revalidatePath('/admin/chastni');
}
