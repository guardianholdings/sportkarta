'use server';

import { getDb, sql } from '@sportkarta/db';
import { POINTS_BY_EVENT } from '@sportkarta/lib/points';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth-session';
import { contributionRateLimiter } from '@/lib/contribution-rate-limit';
import { reportCondition } from '@/lib/contributions/condition-report';
import { ContributionError } from '@/lib/contributions/errors';
import { discardContributionPhoto, storeContributionPhoto } from '@/lib/contributions/photo-upload';
import { verifyFacility } from '@/lib/contributions/verify-facility';

/**
 * Verification and condition reporting from the public facility page.
 * Authenticated only; the anonymous "report a problem" flow is untouched and
 * stays available to everyone.
 */

export interface ContributionState {
  status: 'idle' | 'ok' | 'error';
  /** i18n key suffix under Contribute.error.* */
  error?: string;
  /** Points earned by this submission — 0 when it was already awarded. */
  awarded?: number;
}

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Facilities are addressed by slug in public URLs; never trust a client id. */
async function facilityIdFromSlug(slug: string): Promise<string | null> {
  if (!SLUG_RE.test(slug)) return null;
  const result = await getDb().execute(
    sql`SELECT id FROM facilities WHERE slug = ${slug} AND status <> 'gone'`,
  );
  return (result.rows[0]?.id as string | undefined) ?? null;
}

function checkbox(formData: FormData, name: string): boolean {
  return formData.get(name) === 'on' || formData.get(name) === 'true';
}

/** Tri-state: "yes" | "no" | anything else = unknown. */
function triState(value: FormDataEntryValue | null): boolean | null {
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return null;
}

export async function verifyFacilityAction(
  _prev: ContributionState,
  formData: FormData,
): Promise<ContributionState> {
  const user = await requireUser();
  if (!contributionRateLimiter.check(user.id).allowed) {
    return { status: 'error', error: 'rate_limited' };
  }

  const slug = String(formData.get('slug') ?? '');
  const facilityId = await facilityIdFromSlug(slug);
  if (!facilityId) return { status: 'error', error: 'facility_not_found' };

  const exists = formData.get('exists') !== 'no';

  // Only fields the form actually presented are considered. Without this, a
  // crafted request carrying just `slug` would assert "no surface, unknown
  // lighting, not covered" on any facility — and because those land as crowd
  // edits, the merge policy would then freeze the wiped values against every
  // future import. `fields` is a hidden input listing what was rendered.
  const presented = new Set(
    String(formData.get('fields') ?? '')
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean),
  );
  const surfaceRaw = String(formData.get('surface') ?? '');
  const sportTypes = formData.getAll('sportTypes').map(String);

  try {
    const result = await verifyFacility(getDb(), {
      userId: user.id,
      facilityId,
      checklist: {
        exists,
        ...(exists
          ? {
              ...(presented.has('access') && formData.has('access')
                ? { access: String(formData.get('access') ?? '') }
                : {}),
              ...(presented.has('surface') && formData.has('surface')
                ? { surface: surfaceRaw === '' ? null : surfaceRaw }
                : {}),
              ...(presented.has('lighting') && formData.has('lighting')
                ? { lighting: triState(formData.get('lighting')) }
                : {}),
              // A checkbox is absent when unchecked, so this one relies on the
              // form having declared it rather than on the value being present.
              ...(presented.has('covered') ? { covered: checkbox(formData, 'covered') } : {}),
              ...(presented.has('sportTypes') && sportTypes.length > 0 ? { sportTypes } : {}),
            }
          : {}),
      },
    });
    revalidatePath(`/obekt/${slug}`);
    return { status: 'ok', awarded: result.awarded ? POINTS_BY_EVENT.facility_verified : 0 };
  } catch (error) {
    if (error instanceof ContributionError) return { status: 'error', error: error.code };
    throw error;
  }
}

export async function reportConditionAction(
  _prev: ContributionState,
  formData: FormData,
): Promise<ContributionState> {
  const user = await requireUser();
  if (!contributionRateLimiter.check(user.id).allowed) {
    return { status: 'error', error: 'rate_limited' };
  }

  const slug = String(formData.get('slug') ?? '');
  const facilityId = await facilityIdFromSlug(slug);
  if (!facilityId) return { status: 'error', error: 'facility_not_found' };

  // The photo is optional here, so an absent file is not an error.
  const photo = formData.get('photo');
  let storagePath: string | null = null;
  try {
    if (photo instanceof File && photo.size > 0) {
      storagePath = await storeContributionPhoto(photo, 'conditions');
    }

    const result = await reportCondition(getDb(), {
      userId: user.id,
      facilityId,
      input: {
        state: String(formData.get('state') ?? ''),
        tags: formData.getAll('tags').map(String),
        photoStoragePath: storagePath,
      },
    });
    revalidatePath(`/obekt/${slug}`);
    return { status: 'ok', awarded: result.awarded ? POINTS_BY_EVENT.condition_reported : 0 };
  } catch (error) {
    await discardContributionPhoto(storagePath);
    if (error instanceof ContributionError) return { status: 'error', error: error.code };
    throw error;
  }
}
