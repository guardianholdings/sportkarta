'use server';

import { getDb } from '@sportkarta/db';
import { getLocale, getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import type { TillPreviewState, TillState } from '@/components/clubs/till-form';
import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { isUuid, parseTillLines, parseTillSale } from '@/lib/clubs/input';
import { previewTillSale, recordTillSale, reverseSale } from '@/lib/clubs/shop';

/**
 * The till (0049). shop.sell on a club whose tier has the shop and where the
 * operator has switched it on; a sale opens its receipt. Reversing a sale is
 * charges.void (owner, manager). Every statement carries its own scope.
 */

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function refresh(slug: string): void {
  revalidatePath(`/klub/${slug}/prodazhbi`);
  revalidatePath(`/klub/${slug}/produkti`);
  revalidatePath(`/klub/${slug}/plashtaniya`);
}

export async function tillSaleAction(_prev: TillState, formData: FormData): Promise<TillState> {
  const slug = slugOf(formData);
  const { actor, club } = await requireClubStaff(slug, 'shop.sell');
  if (!featureOn(club, 'shop')) return { error: 'feature_unavailable' };
  const parsed = parseTillSale(formData);
  if (!parsed.ok) return { error: 'invalid', errors: parsed.errors };
  const t = await getTranslations('ClubShop');
  const result = await recordTillSale(getDb(), actor, parsed.value, (number) =>
    t('saleLabel', { number }),
  );
  if (!result.ok) return { error: result.error === 'not_allowed' ? 'readOnly' : result.error };
  refresh(slug);
  return redirect({
    href: { pathname: `/klub/${slug}/prodazhbi/${result.saleId}`, query: { rezultat: 'recorded' } },
    locale: await getLocale(),
  });
}

/**
 * What the cart will cost, offer included, before it is recorded — so the
 * cashier collects what the books will hold. Reads only; called as the cart,
 * the client or the code changes.
 */
export async function previewTillAction(input: {
  slug: string;
  lines: string[];
  memberId: string;
  code: string;
}): Promise<TillPreviewState> {
  const { actor, club } = await requireClubStaff(input.slug, 'shop.sell');
  if (!featureOn(club, 'shop')) return { ok: false, error: 'feature_unavailable' };
  const lines = parseTillLines(input.lines);
  if (!lines) return { ok: false, error: 'invalid' };
  const code = input.code.trim();
  return previewTillSale(getDb(), actor, {
    lines,
    memberId: isUuid(input.memberId) ? input.memberId : null,
    code: code === '' ? null : code,
  });
}

export async function reverseSaleAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'charges.void');
  const saleId = formData.get('saleId');
  const outcome =
    typeof saleId === 'string' && isUuid(saleId)
      ? await reverseSale(getDb(), actor, saleId)
      : 'not_found';
  refresh(slug);
  return redirect({
    href: {
      pathname: `/klub/${slug}/prodazhbi/${typeof saleId === 'string' && isUuid(saleId) ? saleId : ''}`,
      query: { rezultat: outcome === 'ok' ? 'reversed' : outcome },
    },
    locale: await getLocale(),
  });
}
