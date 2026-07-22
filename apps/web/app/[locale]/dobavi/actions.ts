'use server';

import { getDb } from '@sportkarta/db';
import { redirect } from 'next/navigation';

import { requireUser } from '@/lib/auth-session';
import { addFacilityRateLimiter } from '@/lib/contribution-rate-limit';
import { addFacility } from '@/lib/contributions/add-facility';
import { ContributionError } from '@/lib/contributions/errors';
import { discardContributionPhoto, storeContributionPhoto } from '@/lib/contributions/photo-upload';

/**
 * Add a facility (Stage 3.2). Authenticated only — `requireUser` redirects an
 * anonymous caller, so the server action cannot be driven without an account
 * even though the page is also gated by middleware and the layout.
 */

export interface AddFacilityState {
  /** i18n key suffix under AddFacility.error.*; null when nothing failed yet. */
  error: string | null;
  /** Slug of the facility a rejected duplicate collided with. */
  conflictSlug?: string;
}

export async function addFacilityAction(
  _prev: AddFacilityState,
  formData: FormData,
): Promise<AddFacilityState> {
  const user = await requireUser();

  if (!addFacilityRateLimiter.check(user.id).allowed) {
    return { error: 'rate_limited' };
  }

  let storagePath: string | null = null;
  let slug: string;
  try {
    // Photo first: a facility without evidence is not accepted, so there is no
    // point touching the database before the upload has been validated.
    storagePath = await storeContributionPhoto(formData.get('photo'), 'facilities');

    const result = await addFacility(getDb(), {
      userId: user.id,
      photoStoragePath: storagePath,
      input: {
        name: String(formData.get('name') ?? ''),
        quarter: String(formData.get('quarter') ?? ''),
        sportTypes: formData.getAll('sportTypes').map(String),
        access: String(formData.get('access') ?? ''),
        lon: Number(formData.get('lon')),
        lat: Number(formData.get('lat')),
      },
    });
    slug = result.slug;
  } catch (error) {
    // Nothing was committed, so the uploaded file must not dangle.
    await discardContributionPhoto(storagePath);
    if (error instanceof ContributionError) {
      return error.conflictSlug
        ? { error: error.code, conflictSlug: error.conflictSlug }
        : { error: error.code };
    }
    throw error;
  }

  // Outside the try: redirect() signals by throwing, and catching it here would
  // both swallow the navigation and delete a photo that now has a facility.
  redirect(`/obekt/${slug}?added=1`);
}
