import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';

import { redirect } from '@/i18n/navigation';
import { clubsDemoEnabled } from '@/lib/clubs/access';
import { DEMO_CLUB_SLUG, requireClubsEnabled } from '@/lib/clubs/club-session';
import { demoEntryQuery } from '@/lib/clubs/demo-entry';

// Both flags are deploy-time variables read per request, so this route is
// dynamic: with either one off it answers 404, as if it didn't exist.
export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string }>;
type PageSearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * /klubove/demo, the address the club campaign links to. It only forwards to
 * the demo club's dashboard, which carries the banner, the noindex and the
 * view-only page gate (`requireClubPage`). The link's campaign tags (utm_*)
 * go along, so the dashboard's landing pageview still names the campaign.
 */
export default async function DemoClubEntryPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: PageSearchParams;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  if (!clubsDemoEnabled()) notFound();
  const pathname = `/klub/${DEMO_CLUB_SLUG}/tablo`;
  const query = demoEntryQuery(await searchParams);
  const href = Object.keys(query).length > 0 ? { pathname, query } : pathname;
  return redirect({ href, locale });
}
