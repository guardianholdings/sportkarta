'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';
import { redirect as redirectOut } from 'next/navigation';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { cancelEventPlace, registerForEvent } from '@/lib/clubs/events';
import { isUuid, parseEventRegistration } from '@/lib/clubs/input';
import { enqueueClubNotify } from '@/lib/clubs/notify';
import { checkoutReturn, startChargeCheckout } from '@/lib/clubs/payments';
import { clubIdForSlug } from '@/lib/clubs/portal';
import { clubMemberActionLimiter } from '@/lib/clubs/rate-limit';

/**
 * A member registers for an event from its public page (0053) — for
 * themselves or a child, signed in. registerForEvent re-checks the record,
 * the window, the ticket and the seat on the server. A seat at an event that
 * takes payment online only is HELD and the member is sent to pay at once;
 * if the payment page cannot be opened the place is given up again (a held
 * place is never a late cancellation, so its charge is voided).
 */

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

async function target(formData: FormData) {
  requireClubsEnabled();
  const user = await requireUser();
  const locale = await getLocale();
  const slug = str(formData, 'slug');
  const eventId = str(formData, 'eventId');
  const clubId =
    /^[a-z0-9-]{3,60}$/.test(slug) && isUuid(eventId) ? await clubIdForSlug(slug) : null;
  const back = (rezultat: string): never => {
    revalidatePath(`/klub/${slug}/sabitie/${eventId}`);
    // `eventId` is a checked uuid; `rezultat` one of this file's codes or a result's.
    return redirect({
      href: { pathname: `/klub/${slug}/sabitie/${eventId}`, query: { rezultat } },
      locale,
    });
  };
  return { user, locale, slug, eventId, clubId, back };
}

export async function registerAction(formData: FormData): Promise<void> {
  const { user, locale, slug, eventId, clubId, back } = await target(formData);
  if (!clubId) return;
  if (!clubMemberActionLimiter.check(`event:${user.id}`).allowed) return back('rate_limited');
  const parsed = parseEventRegistration(formData, str(formData, 'teamEvent') === '1');
  if (!parsed.ok) return back(parsed.errors[0] ?? 'invalid');
  const db = getDb();
  const result = await registerForEvent(
    db,
    { kind: 'member', userId: user.id, clubId },
    eventId,
    parsed.value,
  );
  if (!result.ok) return back(result.error);
  if (result.promotions.length > 0) {
    await enqueueClubNotify({
      kind: 'event_promoted',
      registrationIds: result.promotions.map((p) => p.registrationId),
    });
  }
  if (result.state === 'held' && result.chargeId) {
    const started = await startChargeCheckout(
      db,
      user.id,
      { id: clubId, slug },
      result.chargeId,
      checkoutReturn(locale),
    );
    if (!started.ok) {
      // The seat is given back — and whoever it frees for is told.
      const given = await cancelEventPlace(
        db,
        { kind: 'member', userId: user.id, clubId },
        result.registrationId,
      );
      if (given.ok && given.promotions.length > 0) {
        await enqueueClubNotify({
          kind: 'event_promoted',
          registrationIds: given.promotions.map((p) => p.registrationId),
        });
      }
      return back(`payment_${started.error}`);
    }
    return redirectOut(started.url);
  }
  await enqueueClubNotify({ kind: 'event_registered', registrationId: result.registrationId });
  return back(result.state === 'waitlisted' ? 'registered_waitlist' : 'registered');
}

/** Pay a held place — the seat registered for, or one offered from the line. */
export async function payPlaceAction(formData: FormData): Promise<void> {
  const { user, locale, slug, clubId, back } = await target(formData);
  if (!clubId) return;
  const chargeId = str(formData, 'chargeId');
  if (!isUuid(chargeId)) return back('not_found');
  const started = await startChargeCheckout(
    getDb(),
    user.id,
    { id: clubId, slug },
    chargeId,
    checkoutReturn(locale),
  );
  if (!started.ok) return back(`payment_${started.error}`);
  return redirectOut(started.url);
}

/** Give a place up — free until the deadline the member registered under. */
export async function cancelPlaceAction(formData: FormData): Promise<void> {
  const { user, clubId, back } = await target(formData);
  if (!clubId) return;
  const registrationId = str(formData, 'registrationId');
  if (!isUuid(registrationId)) return back('not_found');
  const result = await cancelEventPlace(
    getDb(),
    { kind: 'member', userId: user.id, clubId },
    registrationId,
  );
  if (!result.ok) return back('not_allowed');
  if (result.promotions.length > 0) {
    await enqueueClubNotify({
      kind: 'event_promoted',
      registrationIds: result.promotions.map((p) => p.registrationId),
    });
  }
  return back(
    result.invoiceLive
      ? 'place_cancelled_invoice'
      : result.late
        ? 'place_cancelled_late'
        : 'place_cancelled',
  );
}
