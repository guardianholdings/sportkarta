'use server';

import { getDb } from '@sportkarta/db';
import { isIsoDate, sofiaToday } from '@sportkarta/lib/clubs';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { bookSelf, cancelBooking } from '@/lib/clubs/bookings';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { isUuid, parseContactPreferences } from '@/lib/clubs/input';
import { requestErasure, setLinkPreference, unlinkRecord } from '@/lib/clubs/links';
import { enqueueClubNotify } from '@/lib/clubs/notify';
import { clubIdForSlug } from '@/lib/clubs/portal';
import { clubMemberActionLimiter } from '@/lib/clubs/rate-limit';
import { memberPause, memberStopRenewal, setContactPreferences } from '@/lib/clubs/self-service';

/**
 * Everything a member does in their club portal, dispatched by `op`. Each
 * domain function re-checks, in SQL, that the record is this account's own or
 * a child under it (memberSelfScope) — a forged memberId changes nothing.
 * Results come back as `?rezultat=`; mail is queued with ids only.
 */

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

export async function portalOpAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const user = await requireUser();
  const locale = await getLocale();
  const slug = str(formData, 'slug');
  const clubId = await clubIdForSlug(slug);
  if (!clubId) return;
  const db = getDb();
  const op = str(formData, 'op');
  const memberId = str(formData, 'memberId');
  const back = (rezultat: string, href = `/klub/${slug}/az`) => {
    revalidatePath(`/klub/${slug}/az`);
    return redirect({ href: { pathname: href, query: { rezultat } }, locale });
  };
  if (!clubMemberActionLimiter.check(`portal:${user.id}`).allowed) return back('rate_limited');

  switch (op) {
    case 'book': {
      const occurrenceId = str(formData, 'occurrenceId');
      if (!isUuid(occurrenceId) || !isUuid(memberId)) return back('not_allowed');
      const result = await bookSelf(db, user.id, clubId, occurrenceId, memberId);
      if (!result.ok) return back(result.error);
      if (result.status === 'going') {
        await enqueueClubNotify({ kind: 'booking_confirmed', bookingId: result.bookingId });
      }
      return back(result.status === 'going' ? 'booked' : 'waitlisted');
    }
    case 'cancel': {
      const bookingId = str(formData, 'bookingId');
      if (!isUuid(bookingId)) return back('not_found');
      const result = await cancelBooking(
        db,
        { kind: 'member', userId: user.id, clubId },
        bookingId,
      );
      if (result.promoted.length > 0) {
        await enqueueClubNotify({ kind: 'booking_promoted', bookingIds: result.promoted });
      }
      return back(!result.cancelled ? 'not_found' : result.late ? 'cancelled_late' : 'cancelled');
    }
    case 'passport':
    case 'notify': {
      if (!isUuid(memberId)) return back('not_found');
      const on = str(formData, 'on') === '1';
      const ok = await setLinkPreference(user.id, memberId, op, on);
      return back(ok ? `${op}_${on ? 'on' : 'off'}` : 'not_found');
    }
    case 'unlink': {
      if (!isUuid(memberId)) return back('not_found');
      const ok = await unlinkRecord(db, { kind: 'member', userId: user.id }, memberId);
      return ok ? back('unlinked', '/klub') : back('not_found');
    }
    case 'erasure': {
      if (!isUuid(memberId)) return back('not_found');
      const result = await requestErasure(db, user.id, memberId);
      if (result.ok) await enqueueClubNotify({ kind: 'erasure_requested', memberId });
      return back(result.ok ? 'erasure_requested' : 'not_found');
    }
    case 'stop_renewal': {
      const membershipId = str(formData, 'membershipId');
      if (!isUuid(membershipId)) return back('not_found');
      const result = await memberStopRenewal(db, user.id, clubId, membershipId, sofiaToday());
      return back(result.ok ? 'renewal_stopped' : result.error);
    }
    case 'pause': {
      const membershipId = str(formData, 'membershipId');
      const startsOn = str(formData, 'startsOn');
      const days = Number(str(formData, 'days'));
      if (!isUuid(membershipId) || !isIsoDate(startsOn)) return back('pause_invalid');
      const result = await memberPause(
        db,
        user.id,
        clubId,
        membershipId,
        { startsOn, days },
        sofiaToday(),
      );
      return back(result.ok ? 'paused' : result.error);
    }
    case 'contact': {
      if (!isUuid(memberId)) return back('not_found');
      const parsed = parseContactPreferences(formData);
      if (!parsed.ok) return back(parsed.errors[0] ?? 'not_allowed');
      const ok = await setContactPreferences(db, user.id, clubId, memberId, parsed.value);
      return back(ok ? 'contact_saved' : 'not_found');
    }
    default:
      return;
  }
}
