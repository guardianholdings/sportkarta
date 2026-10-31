'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { redirect as redirectOut } from 'next/navigation';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { parseReservationRequest } from '@/lib/clubs/input';
import { checkoutReturn, startChargeCheckout } from '@/lib/clubs/payments';
import { clubIdForSlug } from '@/lib/clubs/portal';
import { clubMemberActionLimiter } from '@/lib/clubs/rate-limit';
import { bookReservation, cancelReservation } from '@/lib/clubs/reservations';

/**
 * A member books a court or a trainer (0048). bookReservation re-checks the
 * record (memberSelfScope), the service (public, audience) and the slot
 * itself on the server. A service that requires online payment holds the
 * slot and sends the member to pay; the session expires with the hold, and if
 * the payment page cannot be opened the hold is released at once (a held
 * booking is never a late cancellation, so its charge is voided).
 */

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function bookAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const user = await requireUser();
  const locale = await getLocale();
  const slug = str(formData, 'slug');
  const clubId = await clubIdForSlug(slug);
  if (!clubId) return;
  const back = (rezultat: string) =>
    redirect({ href: { pathname: `/klub/${slug}/rezervatsiya`, query: { rezultat } }, locale });
  if (!clubMemberActionLimiter.check(`reserve:${user.id}`).allowed) return back('rate_limited');
  const parsed = parseReservationRequest(formData);
  if (!parsed.ok) return back('slot_invalid');
  const db = getDb();
  const booked = await bookReservation(
    db,
    { kind: 'member', userId: user.id, clubId },
    parsed.value,
  );
  if (!booked.ok) return back(booked.error);
  if (booked.state === 'held' && booked.chargeId) {
    const started = await startChargeCheckout(
      db,
      user.id,
      { id: clubId, slug },
      booked.chargeId,
      checkoutReturn(locale),
    );
    if (!started.ok) {
      await cancelReservation(
        db,
        { kind: 'member', userId: user.id, clubId },
        booked.reservationId,
      );
      return back(`payment_${started.error}`);
    }
    return redirectOut(started.url);
  }
  return redirect({
    href: { pathname: `/klub/${slug}/az`, query: { rezultat: 'reservation_booked' } },
    locale,
  });
}
