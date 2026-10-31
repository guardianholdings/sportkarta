'use server';

import { getDb } from '@sportkarta/db';
import { isIsoDate, parseClock } from '@sportkarta/lib/clubs';
import { SOFIA_TZ, zonedToDate } from '@sportkarta/lib/recurrence';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid, parseResource, parseWeekHours } from '@/lib/clubs/input';
import {
  ResourceChangeRefused,
  addResourceBlock,
  removeResourceBlock,
  saveLocationHours,
  saveResource,
  setResourceArchived,
} from '@/lib/clubs/resources';

/**
 * Courts, rooms and equipment, opening hours and closures (0048). Each action
 * re-gates with requireClubStaff; the domain functions scope every statement.
 */

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

async function back(slug: string, rezultat: string): Promise<never> {
  revalidatePath(`/klub/${slug}/resursi`);
  return redirect({
    href: { pathname: `/klub/${slug}/resursi`, query: { rezultat } },
    locale: await getLocale(),
  });
}

export async function saveResourceAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const parsed = parseResource(formData);
  if (!parsed.ok) return back(slug, parsed.errors[0] ?? 'invalid');
  const resourceId = str(formData, 'resourceId');
  let saved: string | null;
  try {
    saved = await saveResource(
      getDb(),
      actor,
      isUuid(resourceId) ? resourceId : null,
      parsed.value,
    );
  } catch (error: unknown) {
    if (error instanceof ResourceChangeRefused) return back(slug, error.code);
    throw error;
  }
  return back(slug, saved ? 'saved' : 'readOnly');
}

export async function archiveResourceAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const resourceId = str(formData, 'resourceId');
  const archived = str(formData, 'archive') === '1';
  const outcome = isUuid(resourceId)
    ? await setResourceArchived(getDb(), actor, resourceId, archived)
    : 'not_found';
  return back(
    slug,
    outcome === 'ok' ? 'saved' : outcome === 'busy' ? 'resource_busy' : 'not_found',
  );
}

export async function saveHoursAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const locationId = str(formData, 'locationId');
  const parsed = parseWeekHours(formData);
  if (!isUuid(locationId) || !parsed.ok) return back(slug, 'hours_invalid');
  const ok = await saveLocationHours(getDb(), actor, locationId, parsed.value);
  return back(slug, ok ? 'saved' : 'readOnly');
}

/** Sofia wall clock on a civil date → the instant. */
function instant(date: string, clock: string): Date | null {
  const minutes = parseClock(clock);
  if (!isIsoDate(date) || minutes === null) return null;
  const [year, month, day] = date.split('-').map(Number);
  return zonedToDate(
    {
      year: year ?? 0,
      month: month ?? 1,
      day: day ?? 1,
      hour: Math.floor(minutes / 60),
      minute: minutes % 60,
    },
    SOFIA_TZ,
  );
}

export async function addBlockAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'schedule.manage');
  const resourceId = str(formData, 'resourceId');
  const startsAt = instant(str(formData, 'date'), str(formData, 'from'));
  const endsAt = instant(str(formData, 'endDate') || str(formData, 'date'), str(formData, 'to'));
  if (!isUuid(resourceId) || !startsAt || !endsAt || endsAt <= startsAt) {
    return back(slug, 'block_invalid');
  }
  const result = await addResourceBlock(getDb(), actor, {
    resourceId,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    reason: str(formData, 'reason') === 'training' ? 'training' : 'other',
  });
  return back(
    slug,
    result === 'ok' ? 'saved' : result === 'conflict' ? 'block_conflict' : 'readOnly',
  );
}

export async function removeBlockAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'schedule.manage');
  const blockId = str(formData, 'blockId');
  const ok = isUuid(blockId) && (await removeResourceBlock(getDb(), actor, blockId));
  return back(slug, ok ? 'saved' : 'not_found');
}
