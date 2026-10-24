'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { applyForClub } from '@/lib/clubs/apply';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { parseApplication } from '@/lib/clubs/input';
import { enqueueClubNotify } from '@/lib/clubs/notify';
import { clubMemberActionLimiter } from '@/lib/clubs/rate-limit';

export interface ApplyState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
}

/**
 * Apply for a club. Signed in only: the account becomes the owner row, and
 * applyForClub refuses a second pending application or a sixth club. The new
 * club is `pending` — its office opens read-only with the checklist, and the
 * operator approves it in /admin/klubove.
 */
export async function applyAction(_prev: ApplyState, formData: FormData): Promise<ApplyState> {
  requireClubsEnabled();
  const user = await requireUser();
  if (!clubMemberActionLimiter.check(`apply:${user.id}`).allowed) {
    return { error: 'rate_limited' };
  }
  const parsed = parseApplication(formData);
  if (!parsed.ok) return { error: 'invalid', errors: parsed.errors };
  const result = await applyForClub(getDb(), user.id, parsed.value);
  if (!result.ok) return { error: result.error };
  await enqueueClubNotify({ kind: 'application_received', clubId: result.clubId });
  return redirect({ href: `/klub/${result.slug}/tablo`, locale: await getLocale() });
}
