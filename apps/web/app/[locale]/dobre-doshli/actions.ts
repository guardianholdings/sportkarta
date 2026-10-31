'use server';

import { getDb } from '@sportkarta/db';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { routing } from '@/i18n/routing';
import { requireUser } from '@/lib/auth-session';
import { buildProfileUpdate, ProfileValidationError, saveProfile } from '@/lib/profile';
import { signInDestination, WELCOME_PATH } from '@/lib/sign-in-destination';

/**
 * The welcome step's one form: a name, optionally a city, then on to `next`.
 * The same validation and the same write as the profile form
 * (lib/profile.ts) — no date of birth here, so `is_minor` is left alone.
 * Works without JavaScript: a refused name comes back as `?greshka=`.
 */
export async function welcomeAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const locale = routing.locales.find((l) => l === formData.get('locale')) ?? routing.defaultLocale;
  const next = signInDestination(formData.get('next'));

  try {
    const update = buildProfileUpdate({
      displayName: String(formData.get('displayName') ?? ''),
      homeCity: String(formData.get('homeCity') ?? ''),
    });
    await saveProfile(getDb(), user.id, update);
  } catch (error) {
    if (!(error instanceof ProfileValidationError)) throw error;
    return redirect({
      href: { pathname: WELCOME_PATH, query: { next, greshka: error.code } },
      locale,
    });
  }

  revalidatePath('/', 'layout');
  return redirect({ href: next, locale });
}
