import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';
import { clubsDemoEnabled } from '@/lib/clubs/access';
import { DEMO_CLUB_SLUG, requireClubsEnabled } from '@/lib/clubs/club-session';

// Both flags are deploy-time variables read per request, so this route is
// dynamic: with either one off it answers 404, as if it didn't exist.
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;

/**
 * /klubove/demo, the address the club campaign links to. It only forwards to
 * the demo club's dashboard, which carries the banner, the noindex and the
 * view-only page gate (`requireClubPage`).
 */
export default async function DemoClubEntryPage({ params }: { params: PageParams }) {
  const { locale } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  if (!clubsDemoEnabled()) notFound();
  return redirect({ href: `/klub/${DEMO_CLUB_SLUG}/tablo`, locale });
}
