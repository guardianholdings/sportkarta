'use server';

import { getDb } from '@sportkarta/db';
import { addDaysIso, isIsoDate, parseEuroCents, sofiaToday } from '@sportkarta/lib/clubs';
import { getLocale, getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { isUuid, parsePromotion } from '@/lib/clubs/input';
import { generateVoucherCode, savePromotion, setPromotionArchived } from '@/lib/clubs/promotions';
import { revalidateClubSurfaces } from '@/lib/clubs/surfaces';

/**
 * Offers and gift vouchers (0049). plans.manage on a tier with promotions;
 * every statement carries its own scope and the feature check again.
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
  revalidatePath(`/klub/${slug}/promocii`);
  revalidateClubSurfaces(slug);
  // `anchor` is this file's own literal plus a uuid, never user text.
  return redirect({
    href: `/klub/${slug}/promocii?rezultat=${rezultat}${anchor ? `#${anchor}` : ''}`,
    locale: await getLocale(),
  });
}

export async function savePromotionAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor, club } = await requireClubStaff(slug, 'plans.manage');
  if (!featureOn(club, 'promotions')) return back(slug, 'feature_unavailable');
  const parsed = parsePromotion(formData, sofiaToday());
  if (!parsed.ok) return back(slug, parsed.errors[0] ?? 'invalid');
  const saved = await savePromotion(getDb(), actor, null, parsed.value);
  if (!saved.ok) return back(slug, saved.error === 'code_taken' ? 'code_taken' : 'readOnly');
  return back(slug, 'saved', `po-${saved.promotionId}`);
}

/**
 * A gift voucher: an amount off anything, ONE use, a generated code nobody
 * can guess, valid for a year unless the form says otherwise. Used once means
 * used up: a remainder is not kept (the voucher form says so).
 */
export async function createVoucherAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor, club } = await requireClubStaff(slug, 'plans.manage');
  if (!featureOn(club, 'promotions')) return back(slug, 'feature_unavailable');
  const amount = parseEuroCents(str(formData, 'amount'));
  if (amount === null || amount === 0 || amount > 10_000_000) {
    return back(slug, 'promotion_value_invalid');
  }
  const t = await getTranslations('ClubPromotions');
  const today = sofiaToday();
  const until = str(formData, 'endsOn');
  const endsOn = isIsoDate(until) && until >= today ? until : addDaysIso(today, 365);
  // A generated code colliding with a live one is rare; one retry covers it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const code = generateVoucherCode();
    const saved = await savePromotion(getDb(), actor, null, {
      // Named by its code only: a recipient's name would be personal data in
      // a table with no erasure path, printed on receipts.
      name: t('voucherName', { code }),
      code,
      kind: 'amount',
      value: amount,
      target: 'all',
      targetIds: null,
      startsOn: today,
      endsOn,
      maxUses: 1,
      perMemberMax: null,
      newMembersOnly: false,
      minVisits90d: null,
    });
    if (saved.ok) return back(slug, 'voucher_created', `po-${saved.promotionId}`);
    if (saved.error !== 'code_taken') return back(slug, 'readOnly');
  }
  return back(slug, 'code_taken');
}

export async function archivePromotionAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'plans.manage');
  const promotionId = str(formData, 'promotionId');
  const ok = isUuid(promotionId) && (await setPromotionArchived(getDb(), actor, promotionId));
  return back(slug, ok ? 'saved' : 'not_found');
}
