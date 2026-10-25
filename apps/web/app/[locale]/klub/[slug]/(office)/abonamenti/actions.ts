'use server';

import { getDb } from '@sportkarta/db';
import { sofiaToday } from '@sportkarta/lib/clubs';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid, parsePlan, parseSale } from '@/lib/clubs/input';
import { savePlan, sellMembership, setPlanArchived } from '@/lib/clubs/sales';
import { revalidateClubSurfaces } from '@/lib/clubs/surfaces';

export interface SalesState {
  error: string | null;
  errors?: string[];
  saved?: boolean;
}

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

export async function savePlanAction(_prev: SalesState, formData: FormData): Promise<SalesState> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'plans.manage');
  const parsed = parsePlan(formData);
  if (!parsed.ok) return { error: 'invalid', errors: parsed.errors };
  const planIdRaw = formData.get('planId');
  const planId = isUuid(planIdRaw) ? planIdRaw : null;
  const saved = await savePlan(getDb(), actor, planId, parsed.value);
  if (!saved) return { error: 'readOnly' };
  revalidatePath(`/klub/${slug}/abonamenti`);
  // Public plans with prices are on the club page.
  revalidateClubSurfaces(slug);
  return redirect({ href: `/klub/${slug}/abonamenti`, locale: await getLocale() });
}

export async function setPlanArchivedAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'plans.manage');
  const planId = formData.get('planId');
  if (!isUuid(planId)) return;
  await setPlanArchived(getDb(), actor, planId, formData.get('archived') === 'true');
  revalidatePath(`/klub/${slug}/abonamenti`);
  revalidateClubSurfaces(slug);
}

export async function sellAction(_prev: SalesState, formData: FormData): Promise<SalesState> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'sales.manage');
  const parsed = parseSale(formData, sofiaToday());
  if (!parsed.ok) return { error: 'invalid', errors: parsed.errors };
  const result = await sellMembership(getDb(), actor, parsed.value);
  if (!result.ok) return { error: result.error === 'not_allowed' ? 'readOnly' : result.error };
  revalidatePath(`/klub/${slug}/chlenove`);
  revalidatePath(`/klub/${slug}/tablo`);
  return redirect({
    href: {
      pathname: `/klub/${slug}/chlenove/${parsed.value.memberId}`,
      query: { rezultat: 'saved' },
    },
    locale: await getLocale(),
  });
}
