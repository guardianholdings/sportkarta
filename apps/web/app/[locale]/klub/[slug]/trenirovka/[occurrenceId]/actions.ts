'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { bookTrial } from '@/lib/clubs/bookings';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { isUuid } from '@/lib/clubs/input';
import { enqueueClubNotify } from '@/lib/clubs/notify';
import { clubIdForSlug } from '@/lib/clubs/portal';
import { clubMemberActionLimiter } from '@/lib/clubs/rate-limit';

/**
 * Book a trial class from the public class page. bookTrial decides everything
 * in SQL: the class must be public and open for trials, the club operating,
 * the person may book only for themselves, once per club, and never into a
 * duplicate of a record the club already keeps under their address.
 */
export async function trialAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const user = await requireUser();
  const locale = await getLocale();
  const slugRaw = formData.get('slug');
  const occurrenceRaw = formData.get('occurrenceId');
  const slug = typeof slugRaw === 'string' ? slugRaw : '';
  const occurrenceId = typeof occurrenceRaw === 'string' ? occurrenceRaw : '';
  const back = (rezultat: string) =>
    redirect({
      href: { pathname: `/klub/${slug}/trenirovka/${occurrenceId}`, query: { rezultat } },
      locale,
    });
  if (!isUuid(occurrenceId)) return;
  const clubId = await clubIdForSlug(slug);
  if (!clubId) return;
  if (!clubMemberActionLimiter.check(`trial:${user.id}`).allowed) return back('rate_limited');
  const result = await bookTrial(getDb(), user.id, clubId, occurrenceId);
  if (!result.ok) return back(result.error);
  if (result.status === 'going') {
    await enqueueClubNotify({ kind: 'booking_confirmed', bookingId: result.bookingId });
  }
  revalidatePath(`/klub/${slug}/trenirovka/${occurrenceId}`);
  return back(result.status === 'going' ? 'booked' : 'waitlisted');
}
