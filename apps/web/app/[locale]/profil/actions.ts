'use server';

import { getDb } from '@sportkarta/db';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { routing } from '@/i18n/routing';
import { deleteAccount } from '@/lib/account-deletion';
import { getAuth } from '@/lib/auth';
import { requireUser } from '@/lib/auth-session';
import { buildProfileUpdate, ProfileValidationError, saveProfile } from '@/lib/profile';
import { headers } from 'next/headers';

export interface ProfileState {
  error: string | null;
  saved: boolean;
}

/**
 * Save the minimal profile. The date-of-birth field is read here, handed
 * straight to buildProfileUpdate, and never stored, echoed or logged — see
 * lib/profile.ts and the test that proves it.
 */
export async function updateProfileAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const user = await requireUser();

  try {
    const update = buildProfileUpdate({
      displayName: String(formData.get('displayName') ?? ''),
      homeCity: String(formData.get('homeCity') ?? ''),
      dateOfBirth: formData.get('dateOfBirth') ? String(formData.get('dateOfBirth')) : undefined,
    });
    await saveProfile(getDb(), user.id, update);
  } catch (error) {
    if (error instanceof ProfileValidationError) return { error: error.code, saved: false };
    throw error;
  }

  revalidatePath('/profil');
  return { error: null, saved: true };
}

/**
 * GDPR erasure. Requires typing the confirmation word shown in the UI, so a
 * stray click cannot destroy an account.
 */
export async function deleteAccountAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const user = await requireUser();

  // The expected word is resolved server-side, from the same message catalogue
  // the form renders. Trusting a hidden field would make this guard decorative:
  // a crafted request could simply send matching values.
  const locale = String(formData.get('locale') ?? '');
  const t = await getTranslations({
    locale: routing.locales.find((candidate) => candidate === locale) ?? routing.defaultLocale,
    namespace: 'Profile',
  });
  const expected = t('deleteConfirmWord');
  const typed = String(formData.get('confirmation') ?? '').trim();
  if (typed.toLocaleLowerCase() !== expected.toLocaleLowerCase()) {
    return { error: 'confirmation_mismatch', saved: false };
  }

  // Ends the current session first: after the user row is gone, sign-out has
  // nothing to write against.
  const auth = getAuth();
  if (auth) {
    await auth.api.signOut({ headers: await headers() });
  }

  const summary = await deleteAccount(getDb(), user.id);
  // No email, no name, no id of the person — only that an erasure completed.
  console.info(
    `[gdpr] account erased; audit rows preserved=${summary.auditRowsPreserved}, photos anonymised=${summary.photosAnonymized}`,
  );

  redirect('/');
}
