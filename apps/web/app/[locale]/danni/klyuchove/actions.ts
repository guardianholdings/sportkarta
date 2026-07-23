'use server';

import { revalidatePath } from 'next/cache';

import { requireUser } from '@/lib/auth-session';
import { EMPTY_KEY_STATE, type KeyFormState } from '@/lib/opendata/key-form-state';
import {
  issueApiKey,
  LabelLooksLikeKeyError,
  revokeApiKey,
  TooManyKeysError,
} from '@/lib/opendata/keys';

export async function createApiKeyAction(
  _prev: KeyFormState,
  formData: FormData,
): Promise<KeyFormState> {
  const user = await requireUser();
  const label = String(formData.get('label') ?? '').trim();
  if (!label) return { ...EMPTY_KEY_STATE, error: 'keysLabelRequired' };

  try {
    const issued = await issueApiKey(user.id, label);
    revalidatePath('/danni/klyuchove');
    return { error: null, issued: { key: issued.key, label: issued.label } };
  } catch (error) {
    if (error instanceof TooManyKeysError) {
      return { ...EMPTY_KEY_STATE, error: 'keysLimitReached' };
    }
    if (error instanceof LabelLooksLikeKeyError) {
      return { ...EMPTY_KEY_STATE, error: 'keysLabelLooksLikeKey' };
    }
    throw error;
  }
}

/**
 * Revocation is a PLAIN form action — one argument, no returned state — so the
 * button works before hydration. It is the action somebody takes in a hurry,
 * usually because a key has just been pasted somewhere it should not have been.
 */
export async function revokeApiKeyAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const keyId = String(formData.get('keyId') ?? '');
  // Scoped to the owner inside the UPDATE, so somebody else's key id revokes
  // nothing rather than revoking their key. The result is deliberately not
  // surfaced: "that key is not yours" and "that key is already revoked" both
  // mean "there is nothing here to revoke", and telling them apart would
  // confirm to a signed-in stranger whether an id exists.
  await revokeApiKey(user.id, keyId);
  revalidatePath('/danni/klyuchove');
}
