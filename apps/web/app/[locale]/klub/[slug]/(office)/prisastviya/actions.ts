'use server';

import { getDb } from '@sportkarta/db';
import { verifyClubToken } from '@sportkarta/lib/checkin-token';
import { isCardKeyShape } from '@sportkarta/lib/clubs/secrets';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { checkinSecret } from '@/lib/checkin-config';
import { clubCheckIn, type CheckinOutcome } from '@/lib/clubs/checkin';
import { requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid } from '@/lib/clubs/input';

/**
 * The desk's three ways to record an arrival: a tick by name, a printed card
 * (a USB barcode reader types the key into the focused field), and a member's
 * personal QR opened by the desk's camera (`skan/[token]`). None of them ever
 * refuses a person: an unpaid or expired client is recorded and the desk is
 * told so in words (checkin.ts).
 *
 * The result travels back as `?rezultat=` plus the member's record id — never
 * a name or a search term, which would land in access logs.
 */

function str(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
}

function slugOf(formData: FormData): string {
  const slug = str(formData, 'slug');
  return /^[a-z0-9-]{3,60}$/.test(slug) ? slug : '';
}

/** The `?rezultat=` code for a check-in outcome. */
function outcomeCode(result: CheckinOutcome): string {
  if (result.status === 'recorded') return result.covered ? 'recorded' : 'recorded_uncovered';
  return result.status;
}

async function back(slug: string, outcome: string, memberId?: string, locationId?: string) {
  revalidatePath(`/klub/${slug}/prisastviya`);
  revalidatePath(`/klub/${slug}/tablo`);
  const query: Record<string, string> = { rezultat: outcome };
  if (memberId) query.chlen = memberId;
  if (locationId) query.lokatsiya = locationId;
  return redirect({
    href: { pathname: `/klub/${slug}/prisastviya`, query },
    locale: await getLocale(),
  });
}

export async function deskCheckinAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'attendance.record');
  const locationRaw = str(formData, 'locationId');
  const locationId = isUuid(locationRaw) ? locationRaw : undefined;
  const db = getDb();
  if (str(formData, 'op') === 'card') {
    const cardKey = str(formData, 'cardKey').trim();
    if (!isCardKeyShape(cardKey)) return back(slug, 'card_invalid', undefined, locationId);
    const result = await clubCheckIn(db, { method: 'card', actor, cardKey, locationId });
    return back(slug, outcomeCode(result), result.memberId, locationId);
  }
  const memberId = str(formData, 'memberId');
  if (!isUuid(memberId)) return back(slug, 'not_found', undefined, locationId);
  const result = await clubCheckIn(db, { method: 'desk', actor, memberId, locationId });
  return back(slug, outcomeCode(result), memberId, locationId);
}

/**
 * Record a scanned personal QR. The token is verified AGAIN here, not trusted
 * from the page that showed it: `qr_member` is evidence (it may reach the
 * member's passport), so only a live signature may produce one. A token that
 * expired while the desk looked at the screen falls back to an ordinary tick.
 */
export async function scanCheckinAction(formData: FormData): Promise<void> {
  const slug = slugOf(formData);
  const { actor } = await requireClubStaff(slug, 'attendance.record');
  const secret = checkinSecret();
  if (!secret) return back(slug, 'qr_disabled');
  const verified = verifyClubToken(str(formData, 'token'), secret, 'mem');
  if (!verified.ok) return back(slug, verified.reason === 'expired' ? 'qr_expired' : 'qr_invalid');
  const result = await clubCheckIn(getDb(), {
    method: 'qr_member',
    actor,
    memberId: verified.id,
  });
  return back(slug, outcomeCode(result), verified.id);
}
