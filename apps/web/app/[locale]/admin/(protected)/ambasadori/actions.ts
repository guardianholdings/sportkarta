'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import {
  addMunicipality,
  grantAmbassador,
  removeMunicipality,
  revokeAmbassador,
} from '@/lib/ambassadors';
import { requireRole } from '@/lib/auth-session';
import { findUserByEmail } from '@/lib/moderation-data';

/**
 * Granting and revoking ambassadors — admin only, and `requireRole('admin')`
 * rather than `requireAdmin()`, which since Stage 3.3 also admits ambassadors.
 * An ambassador being able to widen their own scope would make the whole
 * municipality boundary decorative.
 *
 * The acting admin is passed down as the actor of the `admin_actions` row each
 * change writes (lib/ambassadors.ts) — always the verified session's account,
 * never a form field.
 */

export interface AmbassadorState {
  /** i18n key suffix under AdminAmbassadors.error.* */
  error: string | null;
  granted?: string;
}

export async function grantAmbassadorAction(
  _prev: AmbassadorState,
  formData: FormData,
): Promise<AmbassadorState> {
  const admin = await requireRole('admin');

  const email = String(formData.get('email') ?? '');
  const user = await findUserByEmail(email);
  if (!user) return { error: 'user_not_found' };

  const result = await grantAmbassador(getDb(), user.id, admin.id);
  if (!result.ok) return { error: result.reason };

  revalidatePath('/admin/ambasadori');
  return { error: null, granted: user.email };
}

export async function revokeAmbassadorAction(userId: string): Promise<void> {
  const admin = await requireRole('admin');
  await revokeAmbassador(getDb(), userId, admin.id);
  revalidatePath('/admin/ambasadori');
}

export async function addMunicipalityAction(formData: FormData): Promise<void> {
  const admin = await requireRole('admin');

  const userId = String(formData.get('userId') ?? '');
  const municipalityId = Number(formData.get('municipalityId'));
  if (!userId || !Number.isInteger(municipalityId)) return;

  await addMunicipality(getDb(), userId, municipalityId, admin.id);
  revalidatePath('/admin/ambasadori');
}

export async function removeMunicipalityAction(
  userId: string,
  municipalityId: number,
): Promise<void> {
  const admin = await requireRole('admin');
  await removeMunicipality(getDb(), userId, municipalityId, admin.id);
  revalidatePath('/admin/ambasadori');
}
