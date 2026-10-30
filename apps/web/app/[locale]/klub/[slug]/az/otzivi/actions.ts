'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { giveFeedback } from '@/lib/clubs/feedback';
import { parseFeedback } from '@/lib/clubs/input';
import { clubIdForSlug } from '@/lib/clubs/portal';

/**
 * A member rates a class they came to, or a booking of theirs that is over
 * (0052). The statement admits only the account's own record, the window and
 * the club's tier; the attended trigger admits only somebody who came. A
 * good rating lands on the page that offers the club's Google link.
 */
export async function rateAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const user = await requireUser();
  const slugRaw = formData.get('slug');
  const slug = typeof slugRaw === 'string' && /^[a-z0-9-]{3,60}$/.test(slugRaw) ? slugRaw : '';
  const locale = await getLocale();
  const back = (rezultat: string): never =>
    redirect({ href: `/klub/${slug}/az/otzivi?rezultat=${rezultat}`, locale });
  const clubId = await clubIdForSlug(slug);
  if (!clubId) return back('not_found');
  const parsed = parseFeedback(formData);
  if (!parsed.ok) return back(parsed.errors[0] ?? 'invalid');
  const result = await giveFeedback(getDb(), user.id, clubId, parsed.value);
  revalidatePath(`/klub/${slug}/az/otzivi`);
  if (!result.ok) return back(result.error);
  return back(result.googleReviewUrl ? 'rated_google' : 'rated');
}
