'use server';

import { campaignById, closeCampaign, getDb } from '@sportkarta/db';
import { CampaignRuleError } from '@sportkarta/lib/campaigns';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireRole } from '@/lib/auth-session';
import {
  buildCampaignInput,
  cancelCampaign,
  createCampaign,
  publishCampaign,
  updateCampaign,
} from '@/lib/campaigns';

/**
 * Campaign admin actions (docs/ROADMAP.md §7, Stage 5.3).
 *
 * `requireRole('admin')` on EVERY action, not `requireAdmin()` — since Stage
 * 3.3 the latter also admits ambassadors, whose authority is municipality-scoped
 * moderation. A campaign is national in reach, decides a prize, and publishes
 * names; that is not a moderation power.
 */

export interface CampaignFormState {
  /** i18n key under AdminCampaigns.error.*, or null. */
  error: string | null;
  saved: boolean;
}

function errorState(error: unknown): CampaignFormState {
  if (error instanceof CampaignRuleError) return { error: error.code, saved: false };
  throw error;
}

export async function createCampaignAction(
  _prev: CampaignFormState,
  formData: FormData,
): Promise<CampaignFormState> {
  await requireRole('admin');

  let slug: string;
  try {
    const input = buildCampaignInput(formData);
    slug = input.slug;
    await createCampaign(getDb(), input);
  } catch (error) {
    // A duplicate slug is a unique-violation from the database rather than a
    // validation error, and it is the one collision an admin will actually hit.
    if (error instanceof Error && /campaigns_slug_unique/.test(error.message)) {
      return { error: 'slug_taken', saved: false };
    }
    return errorState(error);
  }

  revalidatePath('/admin/kampanii');
  redirect(`/admin/kampanii/${slug}`);
}

export async function updateCampaignAction(
  _prev: CampaignFormState,
  formData: FormData,
): Promise<CampaignFormState> {
  await requireRole('admin');
  const id = String(formData.get('id') ?? '');
  if (!id) return { error: 'not_found', saved: false };

  try {
    const updated = await updateCampaign(getDb(), id, buildCampaignInput(formData));
    // Zero rows means the campaign is closed: its frozen results were computed
    // under the old rules, so changing them now would leave a published page
    // whose numbers cannot be derived from the campaign it describes.
    if (!updated) return { error: 'closed_not_editable', saved: false };
  } catch (error) {
    if (error instanceof Error && /campaigns_slug_unique/.test(error.message)) {
      return { error: 'slug_taken', saved: false };
    }
    return errorState(error);
  }

  revalidatePath('/admin/kampanii');
  return { error: null, saved: true };
}

export async function publishCampaignAction(formData: FormData): Promise<void> {
  await requireRole('admin');
  const id = String(formData.get('id') ?? '');
  if (id) await publishCampaign(getDb(), id);
  revalidatePath('/admin/kampanii');
}

export async function cancelCampaignAction(formData: FormData): Promise<void> {
  await requireRole('admin');
  const id = String(formData.get('id') ?? '');
  if (id) await cancelCampaign(getDb(), id);
  revalidatePath('/admin/kampanii');
}

/**
 * Close a campaign and FREEZE its standings.
 *
 * This is the irreversible one. Everything else an admin can do here is
 * editable afterwards; closing writes the snapshot the public results page will
 * publish, and re-closing is refused rather than allowed to renumber winners
 * (db/src/campaigns.ts). The form behind it types a confirmation word for the
 * same reason account deletion does.
 */
export async function closeCampaignAction(formData: FormData): Promise<void> {
  await requireRole('admin');
  const id = String(formData.get('id') ?? '');
  if (!id) return;

  const campaign = await campaignById(getDb(), id);
  if (!campaign) return;

  await closeCampaign(getDb(), campaign);
  revalidatePath('/admin/kampanii');
  revalidatePath(`/kampanii/${campaign.slug}`);
}
