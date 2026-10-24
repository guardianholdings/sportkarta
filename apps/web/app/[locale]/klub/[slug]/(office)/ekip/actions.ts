'use server';

import { getDb } from '@sportkarta/db';
import { isClubRole } from '@sportkarta/lib/clubs';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid, parseStaffInvite } from '@/lib/clubs/input';
import { enqueueClubNotify } from '@/lib/clubs/notify';
import { changeStaffRole, inviteStaff, removeStaff, revokeStaffInvite } from '@/lib/clubs/staff';

/** The team screen's actions; every one re-gated, every write scoped in SQL. */

export interface TeamState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
}

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

export async function inviteStaffAction(_prev: TeamState, formData: FormData): Promise<TeamState> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'staff.manage');
  const parsed = parseStaffInvite(formData);
  if (!parsed.ok) return { error: 'invalid', errors: parsed.errors };
  const result = await inviteStaff(getDb(), actor, parsed.value);
  if (!result.ok) return { error: result.error === 'not_allowed' ? 'readOnly' : result.error };
  await enqueueClubNotify({ kind: 'staff_invite', inviteId: result.inviteId });
  revalidatePath(`/klub/${slug}/ekip`);
  return { error: null, saved: true };
}

export async function revokeInviteAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'staff.manage');
  const inviteId = formData.get('inviteId');
  if (isUuid(inviteId)) await revokeStaffInvite(getDb(), actor, inviteId);
  revalidatePath(`/klub/${slug}/ekip`);
}

async function back(slug: string, outcome: string): Promise<never> {
  return redirect({
    href: { pathname: `/klub/${slug}/ekip`, query: { rezultat: outcome } },
    locale: await getLocale(),
  });
}

export async function changeRoleAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'staff.manage');
  const userId = formData.get('userId');
  const role = formData.get('role');
  if (typeof userId !== 'string' || !isClubRole(role)) return back(slug, 'invalid');
  const result = await changeStaffRole(getDb(), actor, userId, role);
  revalidatePath(`/klub/${slug}/ekip`);
  return back(slug, result.ok ? 'saved' : result.error);
}

export async function removeStaffAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  // Anyone on the team may LEAVE; removing somebody else needs staff.manage,
  // which removeStaff checks in SQL.
  const { actor } = await requireClubStaff(slug, 'staff.view');
  const userId = formData.get('userId');
  if (typeof userId !== 'string') return back(slug, 'invalid');
  const result = await removeStaff(getDb(), actor, userId);
  revalidatePath(`/klub/${slug}/ekip`);
  if (result.ok && userId === actor.userId) {
    return redirect({ href: '/klub', locale: await getLocale() });
  }
  return back(slug, result.ok ? 'saved' : result.error);
}
