'use server';

import { getDb } from '@sportkarta/db';
import { getLocale } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

import { redirect } from '@/i18n/navigation';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { KIOSK_COOKIE, kioskCookiePath, pairKiosk } from '@/lib/clubs/kiosk';
import { kioskPairClubLimiter, kioskPairIpLimiter } from '@/lib/clubs/rate-limit';
import { clientIpFromForwardedFor } from '@/lib/rate-limit';

/** A paired tablet stays paired for a year, or until a manager revokes it. */
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

/**
 * Pair the tablet this form was typed on. No staff session is involved — the
 * pairing code is the authority, and it is only ever minted by a manager in
 * Settings. Failed attempts are rate-limited per club and per IP; a success
 * gives its slots back.
 */
export async function pairKioskAction(formData: FormData): Promise<void> {
  requireClubsEnabled();
  const slugRaw = formData.get('slug');
  const slug = typeof slugRaw === 'string' && /^[a-z0-9-]{3,60}$/.test(slugRaw) ? slugRaw : '';
  const codeRaw = formData.get('code');
  const code = typeof codeRaw === 'string' ? codeRaw.replace(/\s+/g, '') : '';
  const locale = await getLocale();
  const back = (rezultat: string) =>
    redirect({ href: { pathname: `/klub/${slug}/kiosk`, query: { rezultat } }, locale });
  if (!slug) return back('bad_code');

  const ip = clientIpFromForwardedFor((await headers()).get('x-forwarded-for')) ?? 'unknown';
  // Per club AND address: a stranger's bad codes must not lock the club's
  // own manager out of pairing a tablet.
  const clubKey = `club:${slug}:${ip}`;
  if (!kioskPairClubLimiter.check(clubKey).allowed) return back('rate_limited');
  if (!kioskPairIpLimiter.check(ip).allowed) {
    kioskPairClubLimiter.release(clubKey);
    return back('rate_limited');
  }

  const paired = await pairKiosk(getDb(), slug, code);
  if (!paired) return back('bad_code');
  kioskPairClubLimiter.release(clubKey);
  kioskPairIpLimiter.release(ip);

  (await cookies()).set(KIOSK_COOKIE, paired.cookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: kioskCookiePath(slug, locale),
    maxAge: COOKIE_MAX_AGE_S,
  });
  return redirect({ href: `/klub/${slug}/kiosk`, locale });
}
