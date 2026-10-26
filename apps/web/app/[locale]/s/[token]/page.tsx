import { redirect } from '@/i18n/navigation';
import { requireClubsEnabled } from '@/lib/clubs/club-session';

/**
 * The way out of a club's SMS (0051), as short as a link in an SMS can be —
 * every character of a Bulgarian SMS costs, and a marketing SMS must carry
 * one. It only forwards to the opt-out page; nothing changes until the person
 * presses the button there (link previews and scanners open links too).
 */
export const dynamic = 'force-dynamic';

export default async function SmsOptOutShortLink({
  params,
}: {
  params: Promise<{ locale: string; token: string }>;
}) {
  const { locale, token } = await params;
  requireClubsEnabled();
  const safe = /^[0-9a-f]{32}$/.test(token) ? token : 'x';
  return redirect({
    href: { pathname: `/klubove/otpisvane/${safe}`, query: { vid: 'sms' } },
    locale,
  });
}
