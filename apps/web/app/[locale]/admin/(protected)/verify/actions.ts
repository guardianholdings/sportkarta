'use server';

import { getDb } from '@sportkarta/db';
import { sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

import { isUuid } from '@/lib/admin-data';
import { requireAdmin } from '@/lib/admin-session';

export type VerifyDecision = 'active' | 'gone';

/**
 * One decision = one status flip + one audit row. Guarded on the current
 * status so double-fires and stale cards are no-ops ({ ok: false }).
 */
export async function decideFacility(
  facilityId: string,
  decision: VerifyDecision,
): Promise<{ ok: boolean }> {
  const { actor } = await requireAdmin();
  if (!isUuid(facilityId)) return { ok: false };
  if (decision !== 'active' && decision !== 'gone') return { ok: false };

  const db = getDb();
  let ok = false;
  await db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE facilities SET status = ${decision}::facility_status
      WHERE id = ${facilityId} AND status = 'needs_verification'
      RETURNING id
    `);
    if (updated.rows.length === 0) return;
    await tx.execute(sql`
      INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
      VALUES (${facilityId}, ${actor}, 'crowd', 'status',
              '"needs_verification"'::jsonb, ${JSON.stringify(decision)}::jsonb)
    `);
    ok = true;
  });

  revalidatePath('/admin/verify');
  revalidatePath('/admin');
  return { ok };
}
