'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { isUuid } from '@/lib/admin-data';
import { requireAdmin } from '@/lib/auth-session';
import { decideFacility as decideFacilityScoped } from '@/lib/moderation';
import { enqueueModerationNotify } from '@/lib/moderation-notify';

export type VerifyDecision = 'active' | 'gone';

/**
 * The one-keystroke verify deck. Since Stage 3.3 it routes through the scoped
 * moderation path, so an ambassador can only clear cards inside their own
 * municipalities and every decision lands in the accountability log — the deck
 * is a faster interface to moderation, not a second door into it.
 *
 * Guarded on the current status, so double-fires and stale cards are no-ops.
 */
export async function decideFacility(
  facilityId: string,
  decision: VerifyDecision,
): Promise<{ ok: boolean }> {
  const user = await requireAdmin();
  if (!isUuid(facilityId)) return { ok: false };
  if (decision !== 'active' && decision !== 'gone') return { ok: false };

  const result = await decideFacilityScoped(
    getDb(),
    { id: user.id, role: user.role },
    facilityId,
    // The deck speaks in target statuses; the log speaks in decisions.
    decision === 'active' ? 'verified' : 'gone',
    // The deck asks one question — "is it there?" — so its G key has exactly
    // one meaning, and that is the reason logged and sent to the author (0033).
    // Any other ground belongs on /admin/moderation, which asks for it.
    decision === 'gone' ? 'does_not_exist' : null,
  );
  const { applied } = result;
  if (applied && decision === 'gone' && result.decisionId) {
    await enqueueModerationNotify({ kind: 'decision', decisionId: result.decisionId });
  }

  revalidatePath('/admin/verify');
  revalidatePath('/admin');
  return { ok: applied };
}
