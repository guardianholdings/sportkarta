'use server';

import { getDb } from '@sportkarta/db';
import { isClubRole } from '@sportkarta/lib/clubs';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import {
  isUuid,
  parsePayRate,
  parseStaffInvite,
  parseStaffProfile,
  parseTimeOff,
} from '@/lib/clubs/input';
import { enqueueClubNotify } from '@/lib/clubs/notify';
import { clubMemberActionLimiter } from '@/lib/clubs/rate-limit';
import {
  addTimeOff,
  changeStaffRole,
  inviteStaff,
  removeStaff,
  removeTimeOff,
  revokeStaffInvite,
  setPayRate,
  updateOwnProfile,
} from '@/lib/clubs/staff';

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
  // A club invites a handful of people, ever: a burst is somebody using the
  // POPS sender as a relay.
  if (!clubMemberActionLimiter.check(`staff-invite:${actor.clubId}`).allowed) {
    return { error: 'rate_limited' };
  }
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

/** One's own public profile (name, bio, the opt-in to appear on the club page). */
export async function profileAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'office.view');
  const parsed = parseStaffProfile(formData);
  if (!parsed.ok) return back(slug, parsed.errors[0] ?? 'invalid');
  const ok = await updateOwnProfile(getDb(), actor, parsed.value);
  revalidatePath(`/klub/${slug}/ekip`);
  revalidatePath(`/klub/${slug}`);
  return back(slug, ok ? 'saved' : 'readOnly');
}

/** Pay terms — report data only; a tier with staff pay (the SQL checks it too). */
export async function payAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor, club } = await requireClubStaff(slug, 'staff.manage');
  if (!featureOn(club, 'staff_pay')) return back(slug, 'feature_unavailable');
  const userId = formData.get('userId');
  const parsed = parsePayRate(formData);
  if (typeof userId !== 'string' || !parsed.ok) {
    return back(slug, parsed.ok ? 'invalid' : (parsed.errors[0] ?? 'invalid'));
  }
  const ok = await setPayRate(getDb(), actor, userId, parsed.value);
  revalidatePath(`/klub/${slug}/ekip`);
  return back(slug, ok ? 'saved' : 'readOnly');
}

export async function timeOffAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'staff.view');
  const parsed = parseTimeOff(formData);
  if (!parsed.ok) return back(slug, parsed.errors[0] ?? 'invalid');
  const result = await addTimeOff(getDb(), actor, parsed.value);
  revalidatePath(`/klub/${slug}/ekip`);
  return back(
    slug,
    result === 'ok' ? 'saved' : result === 'overlaps' ? 'time_off_overlaps' : 'readOnly',
  );
}

export async function removeTimeOffAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'staff.view');
  const blockId = formData.get('blockId');
  const ok = isUuid(blockId) && (await removeTimeOff(getDb(), actor, blockId));
  revalidatePath(`/klub/${slug}/ekip`);
  return back(slug, ok ? 'saved' : 'not_found');
}
