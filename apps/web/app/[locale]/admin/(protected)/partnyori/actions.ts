'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireRole } from '@/lib/auth-session';
import { discardContributionPhoto, storeContributionPhoto } from '@/lib/contributions/photo-upload';
import { ContributionError } from '@/lib/contributions/errors';
import {
  buildPartnerInput,
  createPartner,
  partnerBySlug,
  PartnerInputError,
  setPartnerLogo,
  setPartnerVisible,
  updatePartner,
} from '@/lib/partners';
import { revalidatePartnerSurfaces } from '@/lib/partner-surfaces';

/**
 * Partner registry actions (docs/MONETISATION.md M1). `requireRole('admin')`
 * on EVERY action, not `requireAdmin()` — the latter admits ambassadors, and
 * who the NGO partners with is not a moderation decision.
 *
 * Every action here also revalidates the public partner surfaces
 * (lib/partner-surfaces.ts). A partner's visibility, window and tier are half
 * of `PARTNER_RENDERABLE`, which decides whether their ads and their headline
 * logo render, and two of those pages are cached for an hour: hiding an
 * advertiser must take their creative off the city and weekly pages now, not
 * when the cache turns over.
 *
 * The logo file is uploaded BEFORE the row write and discarded on failure
 * (the dobavi rule: an uploaded file must not dangle); replacing a logo
 * deletes the old key after the row points at the new one.
 */

export interface PartnerState {
  /** i18n key suffix under AdminPartners.error_*. */
  error: string | null;
  saved?: boolean;
}

function errorState(error: unknown): PartnerState {
  if (error instanceof PartnerInputError) return { error: error.code };
  if (error instanceof ContributionError) return { error: error.code };
  if (error instanceof Error && /partners_slug_unique/.test(error.message)) {
    return { error: 'slug_taken' };
  }
  throw error;
}

async function storeLogoIfPresent(formData: FormData): Promise<string | null> {
  const file = formData.get('logo');
  if (!(file instanceof File) || file.size === 0) return null;
  return storeContributionPhoto(file, 'partners');
}

export async function createPartnerAction(
  _prev: PartnerState,
  formData: FormData,
): Promise<PartnerState> {
  await requireRole('admin');
  let logoKey: string | null = null;
  let slug: string;
  try {
    const input = buildPartnerInput(formData);
    logoKey = await storeLogoIfPresent(formData);
    const db = getDb();
    await createPartner(db, input);
    if (logoKey) await setPartnerLogo(db, input.slug, logoKey);
    slug = input.slug;
  } catch (error: unknown) {
    await discardContributionPhoto(logoKey);
    return errorState(error);
  }
  revalidatePath('/admin/partnyori');
  revalidatePath('/partnyori');
  revalidatePartnerSurfaces();
  // The i18n redirect keeps an /en admin in /en (A-14).
  return redirect({ href: `/admin/partnyori/${slug}`, locale: await getLocale() });
}

export async function updatePartnerAction(
  currentSlug: string,
  _prev: PartnerState,
  formData: FormData,
): Promise<PartnerState> {
  await requireRole('admin');
  let logoKey: string | null = null;
  let nextSlug: string;
  try {
    const input = buildPartnerInput(formData);
    logoKey = await storeLogoIfPresent(formData);
    const db = getDb();
    const existing = await partnerBySlug(db, currentSlug);
    if (!existing) return { error: 'not_found' };
    const updated = await updatePartner(db, currentSlug, input);
    if (!updated) return { error: 'not_found' };
    if (logoKey) {
      await setPartnerLogo(db, input.slug, logoKey);
      // Old file only after the row points elsewhere — best effort.
      if (existing.logoPath && existing.logoPath !== logoKey) {
        await discardContributionPhoto(existing.logoPath);
      }
    }
    nextSlug = input.slug;
  } catch (error: unknown) {
    await discardContributionPhoto(logoKey);
    return errorState(error);
  }
  revalidatePath('/admin/partnyori');
  revalidatePath('/partnyori');
  revalidatePartnerSurfaces();
  if (nextSlug !== currentSlug) {
    redirect({ href: `/admin/partnyori/${nextSlug}`, locale: await getLocale() });
  }
  return { error: null, saved: true };
}

/** Posts the TARGET state (0018 rule) — a double submit settles. */
export async function setVisibleAction(slug: string, visible: boolean): Promise<void> {
  await requireRole('admin');
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return;
  await setPartnerVisible(getDb(), slug, visible);
  revalidatePath('/admin/partnyori');
  revalidatePath('/partnyori');
  revalidatePartnerSurfaces();
}
