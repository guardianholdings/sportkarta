'use server';

import { ensureCalendarToken, getDb, rotateCalendarToken } from '@sportkarta/db';
import { getTranslations } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { routing } from '@/i18n/routing';
import { deleteAccount } from '@/lib/account-deletion';
import { getAuth } from '@/lib/auth';
import { subscribe, unsubscribe } from '@/lib/digest';
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

/**
 * Weekly-digest opt-in (Stage 4.4). One toggle per city; the subscription
 * carries its own unsubscribe token so the emails can be stopped without
 * signing in. Both directions are idempotent, so a double-tapped toggle
 * settles rather than flapping.
 */
export async function setDigestSubscriptionAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const municipalityId = Number(formData.get('municipalityId'));
  // Number('') is 0, which is an integer and a foreign-key violation.
  if (!Number.isInteger(municipalityId) || municipalityId <= 0) return;

  if (String(formData.get('subscribed')) === 'true') {
    await subscribe(getDb(), user.id, municipalityId);
  } else {
    await unsubscribe(getDb(), user.id, municipalityId);
  }
  revalidatePath('/profil');
}

/**
 * Mint the member's calendar feed URL, or rotate it (Stage 4.2).
 *
 * Minting is explicit rather than automatic on sign-up: the token IS a
 * credential — anyone holding the URL can read where this person plays — so it
 * exists only once somebody has asked for it.
 *
 * Rotation is the ONLY recovery available once a feed URL has leaked into a
 * shared calendar or a browser history, so it is one button and it takes effect
 * immediately: the row is updated in place, and every copy of the old URL stops
 * resolving on the next poll.
 */
export async function calendarTokenAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const rotate = formData.get('rotate') === 'true';
  if (rotate) await rotateCalendarToken(getDb(), user.id);
  else await ensureCalendarToken(getDb(), user.id);
  revalidatePath('/profil');
}
