'use server';

import { getDb } from '@sportkarta/db';
import { CLUB_CANCEL_REASONS, sofiaToday, type ClubCancelReason } from '@sportkarta/lib/clubs';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { clubCheckIn } from '@/lib/clubs/checkin';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid, parseMember, parsePause } from '@/lib/clubs/input';
import { decideClaim, inviteMemberToLink, unlinkRecord } from '@/lib/clubs/links';
import {
  createMember,
  eraseMember,
  issueMemberCard,
  setMemberArchived,
  updateMember,
} from '@/lib/clubs/members';
import { enqueueClubNotify } from '@/lib/clubs/notify';
import { cancelMembership, pauseMembership, resumeMembership, voidCharge } from '@/lib/clubs/sales';

/**
 * The member screens' actions. Each re-gates with requireClubStaff for the
 * permission it needs; the domain function scopes the statement again.
 */

export interface MemberState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
  /** A freshly issued card key — shown once, never put in a URL. */
  key?: string;
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function slugOf(formData: FormData): string {
  const slug = str(formData, 'slug');
  return /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function refresh(slug: string, memberId?: string): void {
  revalidatePath(`/klub/${slug}/chlenove`);
  if (memberId) revalidatePath(`/klub/${slug}/chlenove/${memberId}`);
  revalidatePath(`/klub/${slug}/tablo`);
}

async function toCard(slug: string, memberId: string, outcome?: string): Promise<never> {
  return redirect({
    href: {
      pathname: `/klub/${slug}/chlenove/${memberId}`,
      query: outcome ? { rezultat: outcome } : {},
    },
    locale: await getLocale(),
  });
}

export async function saveMemberAction(
  _prev: MemberState,
  formData: FormData,
): Promise<MemberState> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'members.manage');
  const parsed = parseMember(formData);
  if (!parsed.ok) return { error: 'invalid', errors: parsed.errors };
  const memberIdRaw = str(formData, 'memberId');
  const result = isUuid(memberIdRaw)
    ? await updateMember(getDb(), actor, memberIdRaw, parsed.value)
    : await createMember(getDb(), actor, parsed.value);
  if (!result.ok) return { error: result.error === 'not_allowed' ? 'readOnly' : result.error };
  refresh(slug, result.memberId);
  return toCard(slug, result.memberId, 'saved');
}

const CANCEL_REASONS = new Set<string>(CLUB_CANCEL_REASONS);

/** One-click operations on a member's card, dispatched by `op`. */
export async function memberOpAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const op = str(formData, 'op');
  const memberId = str(formData, 'memberId');
  if (!isUuid(memberId)) return;
  const db = getDb();
  let outcome = 'saved';

  switch (op) {
    case 'archive':
    case 'restore': {
      const { actor } = await requireClubStaff(slug, 'members.manage');
      if (!(await setMemberArchived(db, actor, memberId, op === 'archive'))) outcome = 'readOnly';
      break;
    }
    case 'erase': {
      const { actor } = await requireClubStaff(slug, 'members.erase');
      if (await eraseMember(db, actor, memberId)) {
        refresh(slug);
        return redirect({
          href: { pathname: `/klub/${slug}/chlenove`, query: { rezultat: 'erased' } },
          locale: await getLocale(),
        });
      }
      outcome = 'not_allowed';
      break;
    }
    case 'invite': {
      const { actor } = await requireClubStaff(slug, 'members.manage');
      const result = await inviteMemberToLink(db, actor, memberId);
      if (result.ok) {
        await enqueueClubNotify({ kind: 'member_invite', inviteId: result.inviteId });
        outcome = 'invited';
      } else {
        outcome = result.error === 'not_allowed' ? 'readOnly' : result.error;
      }
      break;
    }
    case 'approve':
    case 'decline': {
      const { actor } = await requireClubStaff(slug, 'members.manage');
      if (!(await decideClaim(db, actor, memberId, op === 'approve'))) outcome = 'not_found';
      break;
    }
    case 'unlink': {
      const { actor } = await requireClubStaff(slug, 'members.manage');
      if (!(await unlinkRecord(db, { kind: 'staff', actor }, memberId))) outcome = 'not_found';
      break;
    }
    case 'resume': {
      const { actor } = await requireClubStaff(slug, 'sales.manage');
      const membershipId = str(formData, 'membershipId');
      if (
        !isUuid(membershipId) ||
        !(await resumeMembership(db, actor, membershipId, sofiaToday()))
      ) {
        outcome = 'not_found';
      }
      break;
    }
    case 'cancel': {
      const { actor } = await requireClubStaff(slug, 'sales.manage');
      const membershipId = str(formData, 'membershipId');
      const reason = str(formData, 'reason');
      if (!isUuid(membershipId) || !CANCEL_REASONS.has(reason)) {
        outcome = 'reason_invalid';
      } else if (!(await cancelMembership(db, actor, membershipId, reason as ClubCancelReason))) {
        outcome = 'not_found';
      }
      break;
    }
    case 'void': {
      const { actor } = await requireClubStaff(slug, 'charges.void');
      const chargeId = str(formData, 'chargeId');
      if (!isUuid(chargeId) || !(await voidCharge(db, actor, chargeId))) outcome = 'not_found';
      break;
    }
    case 'checkin': {
      const { actor } = await requireClubStaff(slug, 'attendance.record');
      const result = await clubCheckIn(db, { method: 'desk', actor, memberId });
      outcome =
        result.status === 'recorded'
          ? result.covered
            ? 'checked_in'
            : 'checked_in_uncovered'
          : result.status;
      break;
    }
    default:
      return;
  }
  refresh(slug, memberId);
  return toCard(slug, memberId, outcome);
}

export async function pauseAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'sales.manage');
  const memberId = str(formData, 'memberId');
  if (!isUuid(memberId)) return;
  const parsed = parsePause(formData);
  let outcome = 'saved';
  if (!parsed.ok) outcome = parsed.errors[0] ?? 'invalid';
  else {
    const result = await pauseMembership(getDb(), actor, parsed.value);
    if (!result.ok) outcome = result.error === 'not_allowed' ? 'readOnly' : result.error;
  }
  refresh(slug, memberId);
  return toCard(slug, memberId, outcome);
}

export async function issueCardAction(
  _prev: MemberState,
  formData: FormData,
): Promise<MemberState> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'members.manage');
  const memberId = str(formData, 'memberId');
  if (!isUuid(memberId)) return { error: 'not_found' };
  const key = await issueMemberCard(getDb(), actor, memberId);
  if (!key) return { error: 'readOnly' };
  refresh(slug, memberId);
  return { error: null, key };
}
