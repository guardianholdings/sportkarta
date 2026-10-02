'use server';

import { campaignById, closeCampaign, getDb, quarterHasFacilities } from '@sportkarta/db';
import { campaignPhase, CampaignRuleError, isClosable } from '@sportkarta/lib/campaigns';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireRole } from '@/lib/auth-session';
import {
  buildCampaignInput,
  cancelCampaign,
  createCampaign,
  publishCampaign,
  updateCampaign,
  type CampaignInput,
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

/**
 * A quarter scope must name a quarter at least one facility actually carries.
 *
 * The scope is an exact match against `facilities.quarter`, so a quarter that
 * exists nowhere scores nothing — an empty board for the whole campaign with no
 * error anywhere. The form only offers existing quarters (campaignQuarters);
 * this is the server-side half, because a posted form is never an authorization.
 */
async function assertQuarterExists(input: CampaignInput): Promise<void> {
  if (input.scope.kind !== 'quarter') return;
  const found = await quarterHasFacilities(
    getDb(),
    input.scope.municipalityId,
    input.scope.quarter,
  );
  if (!found) throw new CampaignRuleError('scope_quarter_unknown');
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
    await assertQuarterExists(input);
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
    const input = buildCampaignInput(formData);
    await assertQuarterExists(input);
    const updated = await updateCampaign(getDb(), id, input);
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
 *
 * Only once the window has ended (`isClosable`). The page does not offer the
 * form before then, this refuses a post that arrives anyway, and closeCampaign's
 * own claim refuses it a third time — the last is the one that holds.
 */
export async function closeCampaignAction(formData: FormData): Promise<void> {
  await requireRole('admin');
  const id = String(formData.get('id') ?? '');
  if (!id) return;

  const campaign = await campaignById(getDb(), id);
  if (!campaign) return;
  if (!isClosable(campaignPhase(campaign.status, campaign.window, new Date()))) return;

  await closeCampaign(getDb(), campaign);
  revalidatePath('/admin/kampanii');
  revalidatePath(`/kampanii/${campaign.slug}`);
}
