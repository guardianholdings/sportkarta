'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth-session';
import { acknowledgeBadges, setPassportVisibility, PassportVisibilityError } from '@/lib/passport';

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

  try {
    await setPassportVisibility(getDb(), user.id, { isPublic, showActivity });
  } catch (error) {
    // A minor cannot publish. The UI does not offer the control at all, so
    // reaching here means a hand-crafted post — swallowing it silently would be
    // wrong, but so would a 500: the request is refused and the page re-renders
    // showing the unchanged (private) state.
    if (!(error instanceof PassportVisibilityError)) throw error;
  }

  revalidatePath('/pasport');
}

/** Clears the "new badge" markers once the member has seen the grid. */
export async function acknowledgeBadgesAction(): Promise<void> {
  const user = await requireUser();
  await acknowledgeBadges(getDb(), user.id);
  revalidatePath('/pasport');
}
