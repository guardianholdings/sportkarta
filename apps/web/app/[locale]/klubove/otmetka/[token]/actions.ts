'use server';

import { getDb } from '@sportkarta/db';
import { verifyClubToken } from '@sportkarta/lib/checkin-token';
import { getLocale } from 'next-intl/server';
import { revalidatePath } from 'next/cache';

import { redirect } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { checkinSecret } from '@/lib/checkin-config';
import { clubCheckIn } from '@/lib/clubs/checkin';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { kioskLocation } from '@/lib/clubs/kiosk';
import { clubMemberActionLimiter } from '@/lib/clubs/rate-limit';

/**
 * Redeem a kiosk QR. The token names a LOCATION; who is checking in is the
 * signed-in account, resolved to that club's record through an ACTIVE link
 * (club_member_links). The token is verified again here, never trusted from
 * the page. The outcome lands on the member's portal for that club, which is
 * where the next question ("how many visits do I have left?") is answered.
 */
export async function redeemKioskAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const user = await requireUser();
  const locale = await getLocale();
  const tokenRaw = formData.get('token');
  const token = typeof tokenRaw === 'string' ? tokenRaw : '';
  const again = (rezultat: string) =>
    redirect({ href: { pathname: `/klubove/otmetka/${token}`, query: { rezultat } }, locale });

  if (!clubMemberActionLimiter.check(`redeem:${user.id}`).allowed) return again('rate_limited');
  const secret = checkinSecret();
  const verified = secret ? verifyClubToken(token, secret, 'loc') : null;
  if (!verified?.ok) return again('invalid');
  const location = await kioskLocation(verified.id, locale);
  if (!location) return again('invalid');

  const result = await clubCheckIn(getDb(), {
    method: 'qr_kiosk',
    userId: user.id,
    clubId: location.clubId,
    locationId: location.locationId,
  });
  const outcome =
    result.status === 'recorded'
      ? result.covered
        ? 'recorded'
        : 'recorded_uncovered'
      : result.status;
  revalidatePath(`/klub/${location.clubSlug}/az`);
  return redirect({
    href: { pathname: `/klub/${location.clubSlug}/az`, query: { otmetka: outcome } },
    locale,
  });
}
