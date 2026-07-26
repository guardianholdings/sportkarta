'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { requireRole } from '@/lib/auth-session';
import {
  buildFacilitySponsorshipInput,
  createFacilitySponsorship,
  deleteFacilitySponsorship,
  facilityIdBySlug,
  FacilitySponsorshipError,
} from '@/lib/facility-sponsors';

/**
 * Adopt-a-facility actions (docs/MONETISATION.md S3, M3a). `requireRole('admin')`
 * on every one: an adoption is a commercial arrangement over public
 * infrastructure, not a moderation decision, so ambassadors have no part in it.
 *
 * THE OPERATOR TYPES A FACILITY SLUG, not a uuid — the slug is what they have in
 * front of them (it is in the facility's URL). It is resolved to an id here, and
 * a slug that names nothing is a clean error rather than a foreign-key crash.
 *
 * `revalidatePath('/obekt/[slug]', 'page')` because the facility pages are ISR:
 * without it, "Поддържа се от" would appear whenever the cache next turned over,
 * which is the wrong answer when a sponsor is watching.
 */

export interface SponsorshipState {
  /** i18n key suffix under AdminPartners.error_*. */
  error: string | null;
  saved?: boolean;
}

function errorState(error: unknown): SponsorshipState {
  if (error instanceof FacilitySponsorshipError) return { error: error.code };
  // The exclusion constraint refusing an overlapping adoption is information the
  // operator needs — that facility is already adopted for those dates.
  if (error instanceof Error && /facility_sponsorships_one_per_facility/.test(error.message)) {
    return { error: 'facility_taken' };
  }
  throw error;
}

export async function createSponsorshipAction(
  partnerSlug: string,
  _prev: SponsorshipState,
  formData: FormData,
): Promise<SponsorshipState> {
  await requireRole('admin');

  try {
    const db = getDb();
    const slug = String(formData.get('facilitySlug') ?? '')
      .trim()
      .toLowerCase();
    const facilityId = await facilityIdBySlug(db, slug);
    if (!facilityId) return { error: 'facility_not_found' };

    // The pure builder does the rest of the validation; it is given the resolved
    // id rather than the slug so its only input shape is the persisted one.
    formData.set('facilityId', facilityId);
    await createFacilitySponsorship(db, buildFacilitySponsorshipInput(formData));
  } catch (error: unknown) {
    return errorState(error);
  }

  revalidatePath(`/admin/partnyori/${partnerSlug}`);
  revalidatePath('/obekt/[slug]', 'page');
  return { error: null, saved: true };
}

export async function deleteSponsorshipAction(partnerSlug: string, id: number): Promise<void> {
  await requireRole('admin');
  if (!Number.isInteger(id) || id <= 0) return;
  await deleteFacilitySponsorship(getDb(), id);
  revalidatePath(`/admin/partnyori/${partnerSlug}`);
  revalidatePath('/obekt/[slug]', 'page');
}
