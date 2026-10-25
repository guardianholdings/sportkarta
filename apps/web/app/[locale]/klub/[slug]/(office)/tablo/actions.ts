'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid } from '@/lib/clubs/input';
import { decideClaim } from '@/lib/clubs/links';

/** Answer a member's claim on a record (dashboard «Чакат потвърждение»). */
export async function decideClaimAction(formData: FormData): Promise<void> {
  const slug = String(formData.get('slug') ?? '');
  const memberId = String(formData.get('memberId') ?? '');
  const approve = formData.get('decision') === 'approve';
  const { actor } = await requireClubStaff(slug, 'members.manage');
  if (!isUuid(memberId)) return;
  await decideClaim(getDb(), actor, memberId, approve);
  revalidatePath(`/klub/${slug}/tablo`);
}
