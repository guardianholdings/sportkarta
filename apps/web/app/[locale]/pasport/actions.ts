'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth-session';
import { acknowledgeBadges, setPassportVisibility } from '@/lib/passport';

/**
 * Passport visibility (Stage 5.1).
 *
 * The member is resolved with requireUser() and the update is keyed by THAT id.
 * Nothing about whose passport is being changed comes from the form — a hidden
 * user field would make this an open redirect for other people's privacy
 * settings.
 *
 * The form posts the target state ("make it public") rather than a toggle, so a
 * double submission converges instead of flapping.
 */
export async function setPassportVisibilityAction(formData: FormData): Promise<void> {
  const user = await requireUser();

  const isPublic = String(formData.get('isPublic') ?? '') === 'true';
  const showActivity = String(formData.get('showActivity') ?? '') === 'true';

  // No eligibility catch: setPassportVisibility has no refusal left to make
  // since migration 0020 removed the minor boundary (minors are treated as
  // adults). A failure here is a real fault and must surface as one.
  await setPassportVisibility(getDb(), user.id, { isPublic, showActivity });

  revalidatePath('/pasport');
}

/** Clears the "new badge" markers once the member has seen the grid. */
export async function acknowledgeBadgesAction(): Promise<void> {
  const user = await requireUser();
  await acknowledgeBadges(getDb(), user.id);
  revalidatePath('/pasport');
}
