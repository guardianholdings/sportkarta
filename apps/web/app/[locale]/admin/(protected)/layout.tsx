import { Map as MapIcon } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { AdminNav } from '@/components/shell/admin-nav';
import { BrandMark } from '@/components/shell/app-nav';
import { Link } from '@/i18n/navigation';
import { requireAdmin } from '@/lib/auth-session';
import { hasAtLeast, type Role } from '@/lib/roles';

import { signOutAction } from '../../vhod/actions';

export const metadata = { robots: { index: false, follow: false } };

// Admin is always per-request: cookie auth + live DB reads. Never prerender
// (a build-time render would bake a redirect shell and need a database).
export const dynamic = 'force-dynamic';

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  // Second gate (after middleware); every server action verifies again.
  const user = await requireAdmin();
  // Show the person, not the opaque id that audit rows carry.
  const actor = user.displayName || user.email;
  const t = await getTranslations('AdminNav');
  const tNav = await getTranslations('Nav');

  // Ambassadors get the review tools (scoped to their municipalities); imports
  // rewrite national data and stay admin-only, so that link is hidden instead.
  const items = [
    { href: '/admin', label: t('dashboard'), minRole: 'ambassador' },
    { href: '/admin/facilities', label: t('facilities'), minRole: 'ambassador' },
    { href: '/admin/verify', label: t('verify'), minRole: 'ambassador' },
    { href: '/admin/moderation', label: t('moderation'), minRole: 'ambassador' },
    // Admin-only: reading one member's whole record is not an ambassador's job,
    // and both screens enforce that with requireRole('admin') themselves.
    { href: '/admin/akaunti', label: t('accounts'), minRole: 'admin' },
    { href: '/admin/sesii', label: t('bulkSessions'), minRole: 'admin' },
    { href: '/admin/rezultati', label: t('results'), minRole: 'admin' },
    { href: '/admin/kampanii', label: t('campaigns'), minRole: 'admin' },
    { href: '/admin/partnyori', label: t('partners'), minRole: 'admin' },
    { href: '/admin/ambasadori', label: t('ambassadors'), minRole: 'admin' },
    { href: '/admin/chastni', label: t('private'), minRole: 'admin' },
    { href: '/admin/otcheti', label: t('reports'), minRole: 'admin' },
    { href: '/admin/obshtini', label: t('municipalImport'), minRole: 'admin' },
    { href: '/admin/import', label: t('import'), minRole: 'admin' },
  ] as const satisfies readonly { href: string; label: string; minRole: Role }[];
  const visibleItems = items.filter((item) => hasAtLeast(user.role, item.minRole));

  return (
    <div className="mx-auto max-w-6xl px-4 py-4">
      <header className="mb-6 border-b border-line pb-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-2.5">
            <BrandMark label={tNav('navBrand')} />
            <span className="t-overline">{t('title')}</span>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-caption text-text-muted">{t('signedInAs', { actor })}</span>
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 rounded-pill border border-line-strong bg-surface px-3 py-1.5 text-caption font-semibold text-ink-soft hover:bg-surface-2"
            >
              <MapIcon size={15} />
              {t('map')}
            </Link>
            <form action={signOutAction}>
              <button
                type="submit"
                className="rounded-pill px-3 py-1.5 text-caption font-semibold text-ink-soft hover:bg-surface-2"
              >
                {t('logout')}
              </button>
            </form>
          </div>
        </div>
        <AdminNav items={visibleItems.map(({ href, label }) => ({ href, label }))} />
      </header>
      {children}
    </div>
  );
}
