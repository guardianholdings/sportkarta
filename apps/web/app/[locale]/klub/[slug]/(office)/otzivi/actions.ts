'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { saveGoogleReviewUrl } from '@/lib/clubs/feedback';
import { parseGoogleReviewUrl } from '@/lib/clubs/input';

/**
 * The club's Google review link (0052): settings.manage on a tier with
 * ratings. The statement carries its own scope and the feature check.
 */
export async function saveGoogleReviewAction(formData: FormData): Promise<void> {
  const slugRaw = formData.get('slug');
  const slug = typeof slugRaw === 'string' && /^[a-z0-9-]{3,60}$/.test(slugRaw) ? slugRaw : '';
  const { actor } = await requireClubStaff(slug, 'settings.manage');
  const parsed = parseGoogleReviewUrl(formData);
  const rezultat = parsed.ok
    ? (await saveGoogleReviewUrl(getDb(), actor, parsed.value))
      ? 'google_saved'
      : 'readOnly'
    : (parsed.errors[0] ?? 'invalid');
  revalidatePath(`/klub/${slug}/otzivi`);
  return redirect({
    href: `/klub/${slug}/otzivi?rezultat=${rezultat}`,
    locale: await getLocale(),
  });
}
