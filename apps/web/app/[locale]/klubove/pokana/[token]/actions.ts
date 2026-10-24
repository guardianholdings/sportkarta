'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { acceptMemberInvite } from '@/lib/clubs/links';
import { clubMemberActionLimiter } from '@/lib/clubs/rate-limit';
import { acceptStaffInvite, staffInviteByToken } from '@/lib/clubs/staff';

/**
 * Accept an invitation. The token itself says which kind it is (it is looked
 * up in the staff invites first, then the member invites); either way the
 * signed-in account must OWN the invited address, verified — a forwarded
 * link joins nobody to anything.
 */
export async function acceptInviteAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const user = await requireUser();
  const locale = await getLocale();
  const tokenRaw = formData.get('token');
  const token = typeof tokenRaw === 'string' ? tokenRaw : '';
  const back = (greshka: string) =>
    redirect({ href: { pathname: `/klubove/pokana/${token}`, query: { greshka } }, locale });
  if (!clubMemberActionLimiter.check(`invite:${user.id}`).allowed) return back('invalid');
  const db = getDb();

  if (await staffInviteByToken(token)) {
    const result = await acceptStaffInvite(db, user.id, token);
    if (!result.ok) return back(result.error);
    revalidatePath('/klub');
    return redirect({ href: `/klub/${result.slug}/tablo`, locale });
  }
  const result = await acceptMemberInvite(db, user.id, token);
  if (!result.ok) return back(result.error);
  revalidatePath('/klub');
  return redirect({
    href: { pathname: `/klub/${result.slug}/az`, query: { rezultat: 'linked' } },
    locale,
  });
}
