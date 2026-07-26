'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { requireRole } from '@/lib/auth-session';
import {
  buildAdPlacementInput,
  createPlacement,
  deletePlacement,
  setPlacementVisible,
  AdPlacementError,
} from '@/lib/ads';
import { ContributionError } from '@/lib/contributions/errors';
import {
  discardContributionPhoto,
  storeContributionPhoto,
} from '@/lib/contributions/photo-upload';

/**
 * Ad-placement actions (docs/MONETISATION.md M4). `requireRole('admin')` on
 * every one — selling a slot is not a moderation decision, so ambassadors
 * (whom `requireAdmin()` admits) have no business here.
 *
 * REVALIDATION IS THE HARD PART, and it is why these actions exist separately
 * from the partner ones. A placement changes what FOUR PUBLIC SURFACES render,
 * and three of them are cached: `/igrishta/[city]` is ISR, the facility pages
 * are ISR, `/sedmitsata/[city]` is ISR. Publishing an ad and having it appear
 * within the hour "when the cache happens to turn over" is not good enough when
 * a period the advertiser paid for has already started, so every mutation
 * revalidates the slot's layout path explicitly.
 *
 * The creative is uploaded BEFORE the row write and discarded when the write
 * fails (the dobavi rule: no dangling file); on delete the row goes first and
 * the file second, so a surviving row never points at a missing image.
 */

export interface PlacementState {
  /** i18n key suffix under AdminPartners.error_*. */
  error: string | null;
  saved?: boolean;
}

/**
 * Every surface an ad can appear on. Revalidating the layout of the dynamic
 * segments is the only way to reach "every city" without enumerating cities.
 */
const AD_SURFACES = ['/obekt/[slug]', '/igrishta/[city]', '/sedmitsata/[city]', '/'] as const;

function revalidateAdSurfaces(): void {
  for (const path of AD_SURFACES) revalidatePath(path, 'page');
}

function errorState(error: unknown): PlacementState {
  if (error instanceof AdPlacementError) return { error: error.code };
  if (error instanceof ContributionError) return { error: error.code };
  // The exclusion constraint refusing a second live placement is INFORMATION,
  // not a fault: the operator needs to be told the slot is already sold for
  // that period rather than shown a 500.
  if (error instanceof Error && /ad_placements_one_visible_per_slot/.test(error.message)) {
    return { error: 'slot_taken' };
  }
  throw error;
}

export async function createPlacementAction(
  partnerSlug: string,
  _prev: PlacementState,
  formData: FormData,
): Promise<PlacementState> {
  await requireRole('admin');

  let creativeKey: string | null = null;
  try {
    const input = buildAdPlacementInput(formData);
    const file = formData.get('creative');
    if (!(file instanceof File) || file.size === 0) return { error: 'creative_required' };
    // Same EXIF-stripping webp pipeline as facility photos and partner logos;
    // jpeg/png/webp only, so an SVG creative stays unaccepted (XSS vector).
    creativeKey = await storeContributionPhoto(file, 'ads');
    await createPlacement(getDb(), input, creativeKey);
  } catch (error: unknown) {
    await discardContributionPhoto(creativeKey);
    return errorState(error);
  }

  revalidatePath(`/admin/partnyori/${partnerSlug}`);
  revalidateAdSurfaces();
  return { error: null, saved: true };
}

/**
 * Posts the TARGET state (the 0018 rule) — a double submit settles.
 *
 * Returns nothing: it is a one-click op like every other admin toggle, and the
 * re-rendered page is the feedback. The one refusal worth surfacing — the slot
 * is taken — is surfaced by the page reading the placement's state back, since
 * the row simply stays invisible.
 */
export async function setPlacementVisibleAction(
  partnerSlug: string,
  id: number,
  visible: boolean,
): Promise<void> {
  await requireRole('admin');
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    await setPlacementVisible(getDb(), id, visible);
  } catch (error: unknown) {
    // Publishing into an occupied slot: leave the placement as a draft rather
    // than crash the screen. The list shows it is still not live.
    if (!(error instanceof Error && /ad_placements_one_visible_per_slot/.test(error.message))) {
      throw error;
    }
  }
  revalidatePath(`/admin/partnyori/${partnerSlug}`);
  revalidateAdSurfaces();
}

export async function deletePlacementAction(partnerSlug: string, id: number): Promise<void> {
  await requireRole('admin');
  if (!Number.isInteger(id) || id <= 0) return;
  // Row first, file second: the reverse order would leave a live row pointing
  // at a deleted image, i.e. a broken creative on a paid surface.
  const creativeKey = await deletePlacement(getDb(), id);
  await discardContributionPhoto(creativeKey);
  revalidatePath(`/admin/partnyori/${partnerSlug}`);
  revalidateAdSurfaces();
}
