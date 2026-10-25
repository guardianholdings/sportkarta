'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid, parseReservationRequest } from '@/lib/clubs/input';
import { bookReservation, cancelReservation } from '@/lib/clubs/reservations';

/**
 * Desk bookings on the day calendar (0048). bookings.manage; the slot is
 * recomputed on the server and the calendar's constraints have the last word.
 */

function slugOf(formData: FormData): string {
  const slug = formData.get('slug');
  return typeof slug === 'string' && /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

async function back(slug: string, formData: FormData, rezultat: string): Promise<never> {
  revalidatePath(`/klub/${slug}/kalendar`);
  // Only validated values travel back: a date and a location uuid.
  const den = /^\d{4}-\d{2}-\d{2}$/.test(str(formData, 'date')) ? str(formData, 'date') : '';
  const mesto = isUuid(str(formData, 'locationId')) ? str(formData, 'locationId') : '';
  return redirect({
    href: {
      pathname: `/klub/${slug}/kalendar`,
      query: { rezultat, ...(den ? { den } : {}), ...(mesto ? { mesto } : {}) },
    },
    locale: await getLocale(),
  });
}

export async function deskBookAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'bookings.manage');
  const parsed = parseReservationRequest(formData);
  if (!parsed.ok || parsed.value.memberId === null) return back(slug, formData, 'slot_invalid');
  const result = await bookReservation(getDb(), { kind: 'staff', actor }, parsed.value);
  return back(slug, formData, result.ok ? 'booked' : result.error);
}

export async function deskCancelAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'bookings.manage');
  const reservationId = str(formData, 'reservationId');
  const result = isUuid(reservationId)
    ? await cancelReservation(getDb(), { kind: 'staff', actor }, reservationId)
    : { ok: false as const };
  return back(
    slug,
    formData,
    !result.ok ? 'not_found' : result.refundDue ? 'cancelled_refund' : 'cancelled',
  );
}
