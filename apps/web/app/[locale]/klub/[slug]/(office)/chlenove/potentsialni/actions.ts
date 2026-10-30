'use server';

import { getDb } from '@sportkarta/db';
import { sofiaToday } from '@sportkarta/lib/clubs';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import {
  isUuid,
  parseLeadLost,
  parseLeadPlan,
  parseLeadSource,
  parseMember,
} from '@/lib/clubs/input';
import { changeLead } from '@/lib/clubs/leads';
import { createMember } from '@/lib/clubs/members';

/**
 * The prospects pipeline (0052). members.manage (front of house); every
 * statement in lib/clubs/leads.ts carries its own scope — what is checked
 * here only decides where to send the person back to: the board, or the
 * member's page when the form came from there (`from=member`).
 */

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

async function back(
  slug: string,
  rezultat: string,
  memberId: string | null = null,
): Promise<never> {
  revalidatePath(`/klub/${slug}/chlenove/potentsialni`);
  // A uuid or nothing — never caller text.
  const href = memberId
    ? `/klub/${slug}/chlenove/${memberId}?rezultat=${rezultat}`
    : `/klub/${slug}/chlenove/potentsialni?rezultat=${rezultat}`;
  return redirect({ href, locale: await getLocale() });
}

/** A new prospect from the board: a record and its lead in one insert. */
export async function addLeadAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'members.manage');
  const member = parseMember(formData);
  if (!member.ok) return back(slug, member.errors[0] ?? 'invalid');
  const source = parseLeadSource(formData);
  if (!source.ok) return back(slug, source.errors[0] ?? 'invalid');
  const created = await createMember(getDb(), actor, member.value, 'staff', {
    source: source.value,
  });
  if (!created.ok) return back(slug, created.error === 'not_allowed' ? 'readOnly' : created.error);
  return back(slug, 'lead_added');
}

/** One change to a card: contacted, the next step, lost, back, off the board, or on it. */
export async function leadAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'members.manage');
  const memberRaw = formData.get('memberId');
  const memberId = typeof memberRaw === 'string' && isUuid(memberRaw) ? memberRaw : null;
  const fromMember = formData.get('from') === 'member' ? memberId : null;
  if (!memberId) return back(slug, 'not_found');
  const op = formData.get('op');
  let ok: boolean;
  switch (op) {
    case 'open': {
      const source = parseLeadSource(formData);
      if (!source.ok) return back(slug, source.errors[0] ?? 'invalid', fromMember);
      ok = await changeLead(getDb(), actor, memberId, { kind: 'open', source: source.value });
      break;
    }
    case 'contacted':
      ok = await changeLead(getDb(), actor, memberId, { kind: 'contacted' });
      break;
    case 'plan': {
      const plan = parseLeadPlan(formData, sofiaToday());
      if (!plan.ok) return back(slug, plan.errors[0] ?? 'invalid', fromMember);
      ok = await changeLead(getDb(), actor, memberId, { kind: 'plan', ...plan.value });
      break;
    }
    case 'lost': {
      const reason = parseLeadLost(formData);
      if (!reason.ok) return back(slug, reason.errors[0] ?? 'invalid', fromMember);
      ok = await changeLead(getDb(), actor, memberId, { kind: 'lost', reason: reason.value });
      break;
    }
    case 'reopen':
      ok = await changeLead(getDb(), actor, memberId, { kind: 'reopen' });
      break;
    case 'remove':
      ok = await changeLead(getDb(), actor, memberId, { kind: 'remove' });
      break;
    default:
      return back(slug, 'invalid', fromMember);
  }
  return back(slug, ok ? 'lead_saved' : 'readOnly', fromMember);
}
