import { getTranslations } from 'next-intl/server';

import { routing } from '@/i18n/routing';
import { publicClubTracking } from '@/lib/clubs/tracking';

import { ClubTracking } from './club-tracking';

/** A club's pages in one locale: /klub/<slug>, prefixed outside the default. */
function clubPath(locale: string, slug: string): string {
  return `${locale === routing.defaultLocale ? '' : `/${locale}`}/klub/${slug}`;
}

/**
 * Where a club's PUBLIC page asks about the club's own pixels (wave H2):
 * nothing at all unless the club has set an id, its tier includes pixels and
 * the operator's switch is on. The question names the club, the tools and
 * what they are for, and links the club's own privacy notice.
 *
 * Rendered by the four public pages only (tests/club-page-csp.test.ts), and
 * by the class and event pages only for a visitor who is not signed in: for a
 * signed-in one they show names (theirs, their family's) — on the booking
 * buttons, too — and a pixel reads what the page shows.
 */
export async function ClubTrackingSlot({
  clubId,
  clubName,
  slug,
  locale,
  leadId = null,
  hideParams = [],
}: {
  clubId: string;
  clubName: string;
  slug: string;
  locale: string;
  /** The inquiry this page confirms (the inquiry form's result). */
  leadId?: string | null;
  /** Query parameters the vendors must not see. */
  hideParams?: readonly string[];
}) {
  const tracking = await publicClubTracking(clubId);
  if (!tracking) return null;
  const t = await getTranslations('ClubTracking');
  const purpose =
    tracking.gaId && tracking.metaId
      ? t('purpose.both')
      : tracking.gaId
        ? t('purpose.ga')
        : t('purpose.meta');
  return (
    <ClubTracking
      clubId={tracking.clubId}
      gaId={tracking.gaId}
      metaId={tracking.metaId}
      cookiePath={clubPath(locale, slug)}
      cookiePaths={routing.locales.map((each) => clubPath(each, slug))}
      policyUrl={tracking.policyUrl}
      leadId={leadId}
      hideParams={hideParams}
      strings={{
        title: t('title'),
        body: t('body', { club: clubName, purpose }),
        accept: t('accept'),
        decline: t('decline'),
        policy: t('policy'),
        granted: t('granted'),
        denied: t('denied'),
        change: t('change'),
      }}
    />
  );
}
