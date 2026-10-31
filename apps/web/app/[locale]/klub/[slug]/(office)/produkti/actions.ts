'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { featureOn } from '@/lib/clubs/features';
import { isUuid, parseProduct, parseStock } from '@/lib/clubs/input';
import { recordStock, saveProduct, setProductArchived } from '@/lib/clubs/shop';

/**
 * Products and their stock (0049). shop.manage on a club whose tier has the
 * shop and where the operator has switched it on; every statement carries
 * its own scope and the feature check again.
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
  revalidatePath(`/klub/${slug}/produkti`);
  revalidatePath(`/klub/${slug}/prodazhbi`);
  // `anchor` is this file's own literal plus a uuid, never user text.
  return redirect({
    href: `/klub/${slug}/produkti?rezultat=${rezultat}${anchor ? `#${anchor}` : ''}`,
    locale: await getLocale(),
  });
}

export async function saveProductAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor, club } = await requireClubStaff(slug, 'shop.manage');
  if (!featureOn(club, 'shop')) return back(slug, 'feature_unavailable');
  const parsed = parseProduct(formData);
  if (!parsed.ok) return back(slug, parsed.errors[0] ?? 'invalid');
  const productId = str(formData, 'productId');
  const saved = await saveProduct(
    getDb(),
    actor,
    isUuid(productId) ? productId : null,
    parsed.value,
  );
  if (!saved.ok) return back(slug, saved.error === 'sku_taken' ? 'sku_taken' : 'readOnly');
  return back(slug, 'saved', `pd-${saved.productId}`);
}

export async function archiveProductAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'shop.manage');
  const productId = str(formData, 'productId');
  const archived = str(formData, 'archive') === '1';
  const outcome = isUuid(productId)
    ? await setProductArchived(getDb(), actor, productId, archived)
    : 'not_found';
  return back(slug, outcome === 'ok' ? 'saved' : outcome);
}

export async function stockAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor, club } = await requireClubStaff(slug, 'shop.manage');
  if (!featureOn(club, 'shop')) return back(slug, 'feature_unavailable');
  const parsed = parseStock(formData);
  if (!parsed.ok) return back(slug, parsed.errors[0] ?? 'invalid');
  const outcome = await recordStock(getDb(), actor, parsed.value);
  return back(
    slug,
    {
      ok: 'stock_saved',
      unchanged: 'stock_unchanged',
      too_large: 'stock_count_too_far',
      not_allowed: 'readOnly',
    }[outcome],
    `pd-${parsed.value.productId}`,
  );
}
