'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid, parsePriceRule, parseService, parseWeekHours } from '@/lib/clubs/input';
import { clubTakesPayments } from '@/lib/clubs/payments';
import {
  addPriceRule,
  removePriceRule,
  saveService,
  saveStaffHours,
  setServiceArchived,
} from '@/lib/clubs/services';
import { revalidateClubSurfaces } from '@/lib/clubs/surfaces';

/**
 * Services, prices and trainers' appointment hours (0048). schedule.manage;
 * every statement carries its own scope.
 */

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

async function back(slug: string, rezultat: string, anchor = ''): Promise<never> {
  revalidatePath(`/klub/${slug}/uslugi`);
  revalidateClubSurfaces(slug);
  // `anchor` is one of this file's own literals or a uuid, never user text.
  return redirect({
    href: `/klub/${slug}/uslugi?rezultat=${rezultat}${anchor ? `#${anchor}` : ''}`,
    locale: await getLocale(),
  });
}

export async function saveServiceAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'schedule.manage');
  const parsed = parseService(formData);
  if (!parsed.ok) return back(slug, parsed.errors[0] ?? 'invalid');
  // A service members can only book by paying online needs a club that can
  // take the money; otherwise every booking would be refused.
  if (parsed.value.payment === 'online_required' && !(await clubTakesPayments(actor.clubId))) {
    return back(slug, 'online_unavailable');
  }
  const serviceId = str(formData, 'serviceId');
  const saved = await saveService(
    getDb(),
    actor,
    isUuid(serviceId) ? serviceId : null,
    parsed.value,
  );
  return back(slug, saved ? 'saved' : 'readOnly', saved ? `s-${saved}` : '');
}

export async function archiveServiceAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'schedule.manage');
  const serviceId = str(formData, 'serviceId');
  const archived = str(formData, 'archive') === '1';
  const ok = isUuid(serviceId) && (await setServiceArchived(getDb(), actor, serviceId, archived));
  return back(slug, ok ? 'saved' : 'not_found');
}

export async function addPriceRuleAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'schedule.manage');
  const serviceId = str(formData, 'serviceId');
  const parsed = parsePriceRule(formData);
  if (!isUuid(serviceId) || !parsed.ok) {
    return back(slug, parsed.ok ? 'not_found' : (parsed.errors[0] ?? 'invalid'));
  }
  const ok = await addPriceRule(getDb(), actor, serviceId, parsed.value);
  return back(slug, ok ? 'saved' : 'readOnly', `s-${serviceId}`);
}

export async function removePriceRuleAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'schedule.manage');
  const ruleId = str(formData, 'ruleId');
  const ok = isUuid(ruleId) && (await removePriceRule(getDb(), actor, ruleId));
  return back(slug, ok ? 'saved' : 'not_found');
}

export async function saveStaffHoursAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'schedule.manage');
  const staffUserId = str(formData, 'staffUserId');
  const locationId = str(formData, 'locationId');
  const parsed = parseWeekHours(formData);
  if (staffUserId === '' || !isUuid(locationId) || !parsed.ok) {
    return back(slug, 'hours_invalid', 'trainers');
  }
  const ok = await saveStaffHours(getDb(), actor, staffUserId, locationId, parsed.value);
  return back(slug, ok ? 'saved' : 'readOnly', 'trainers');
}
