'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth-session';
import {
  acknowledgeBadges,
  PassportNameRequiredError,
  setPassportVisibility,
} from '@/lib/passport';

export interface VisibilityFormState {
  /** Why the change was refused; null when it went through (or nothing was sent). */
  error: 'name_required' | null;
}

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
export async function setPassportVisibilityAction(
  _previous: VisibilityFormState,
  formData: FormData,
): Promise<VisibilityFormState> {
  const user = await requireUser();

  const isPublic = String(formData.get('isPublic') ?? '') === 'true';
  const showActivity = String(formData.get('showActivity') ?? '') === 'true';

  // The one refusal left since migration 0020 removed the minor boundary: a
  // passport is not published without a name to publish it under (S-1). The
  // panel already explains this instead of offering the button, so this answers
  // a stale page or a crafted post — with words, not a 500. Anything else is a
  // real fault and must surface as one.
  try {
    await setPassportVisibility(getDb(), user.id, { isPublic, showActivity });
  } catch (error: unknown) {
    if (error instanceof PassportNameRequiredError) {
      revalidatePath('/pasport');
      return { error: 'name_required' };
    }
    throw error;
  }

  revalidatePath('/pasport');
  return { error: null };
}

/** Clears the "new badge" markers once the member has seen the grid. */
export async function acknowledgeBadgesAction(): Promise<void> {
  const user = await requireUser();
  await acknowledgeBadges(getDb(), user.id);
  revalidatePath('/pasport');
}
