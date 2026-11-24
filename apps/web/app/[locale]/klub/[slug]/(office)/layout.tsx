import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { ClubShell } from '@/components/clubs/club-shell';
import { clubName, requireClubPage } from '@/lib/clubs/club-session';
import { clubsForStaff } from '@/lib/clubs/staff';

/** «<club> — управление» in the tab; never indexed. The context lookup is cached per request. */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; slug: string }>;
}): Promise<Metadata> {
  const { locale, slug } = await params;
  const [{ club }, t] = await Promise.all([
    requireClubPage(slug, 'office.view'),
    getTranslations({ locale, namespace: 'ClubOffice' }),
  ]);
  // The demo club's tab and link previews: its own title, used whole since it
  // names the product already (no brand suffix), and a description.
  const demo = club.status === 'demo';
  return {
    title: demo
      ? { absolute: t('demoMetaTitle') }
      : t('metaTitle', { club: clubName(club, locale) }),
    ...(demo ? { description: t('demoMetaDescription') } : {}),
    robots: { index: false, follow: false },
    // Member and token paths stay out of the next page's referrer.
    referrer: 'no-referrer',
  };
}

// Per request, always: cookie auth and live data, like /admin.
export const dynamic = 'force-dynamic';

/**
 * The club office route group (docs/ROADMAP.md Stage 9). A route group so its
 * layout wraps only the office pages, never the public club page beside it
 * (/klub/[slug]). The gate here decides whether to render; each page gates
 * itself again with the permission it shows, and every action re-checks.
 */
export default async function ClubOfficeLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string; slug: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const context = await requireClubPage(slug, 'office.view');
  const mine = await clubsForStaff(context.user.id);
  const otherClubs = mine
    .filter((club) => club.slug !== slug)
    .map((club) => ({ slug: club.slug, name: clubName(club, locale) }));
  return (
    <ClubShell context={context} otherClubs={otherClubs}>
      {children}
    </ClubShell>
  );
}
