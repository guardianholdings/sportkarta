'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { isUuid } from '@/lib/clubs/input';
import { claimRecord } from '@/lib/clubs/links';
import { enqueueClubNotify } from '@/lib/clubs/notify';
import { clubMemberActionLimiter } from '@/lib/clubs/rate-limit';

/**
 * «Това съм аз» / «Това не съм аз» on a record that carries this account's
 * verified address. Claiming makes a PENDING link the desk approves —
 * linking is always the member's act, and a club can only invite. The SQL in
 * claimRecord re-checks the verified address match; a forged id does nothing.
 */
export async function claimAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const user = await requireUser();
  const locale = await getLocale();
  const back = (rezultat: string) =>
    redirect({ href: { pathname: '/klub', query: { rezultat } }, locale });
  if (!clubMemberActionLimiter.check(`claim:${user.id}`).allowed) return back('rate_limited');
  const memberId = formData.get('memberId');
  const decision = formData.get('decision') === 'decline' ? 'decline' : 'claim';
  if (typeof memberId !== 'string' || !isUuid(memberId)) return back('not_found');
  const result = await claimRecord(getDb(), user.id, memberId, decision);
  if (!result.ok) return back('not_found');
  if (decision === 'claim') await enqueueClubNotify({ kind: 'claim_pending', memberId });
  revalidatePath('/klub');
  return back(decision === 'claim' ? 'claimed' : 'declined');
}
