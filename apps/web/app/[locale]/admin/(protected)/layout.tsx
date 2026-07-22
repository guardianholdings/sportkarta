import { getTranslations, setRequestLocale } from 'next-intl/server';

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

  // Moderators get the review tools; imports rewrite national data and stay
  // admin-only, so the link is hidden rather than leading to a 404.
  const items = [
    { href: '/admin', label: t('dashboard'), minRole: 'moderator' },
    { href: '/admin/facilities', label: t('facilities'), minRole: 'moderator' },
    { href: '/admin/verify', label: t('verify'), minRole: 'moderator' },
    { href: '/admin/moderation', label: t('moderation'), minRole: 'moderator' },
    { href: '/admin/import', label: t('import'), minRole: 'admin' },
  ] as const satisfies readonly { href: string; label: string; minRole: Role }[];
  const visibleItems = items.filter((item) => hasAtLeast(user.role, item.minRole));

  return (
    <div className="mx-auto max-w-6xl p-4">
      <header className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-200 pb-3">
        <nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm font-medium">
          {visibleItems.map((item) => (
            <Link key={item.href} href={item.href} className="hover:underline">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs text-neutral-500">
          <span>{t('signedInAs', { actor })}</span>
          <form action={signOutAction}>
            <button type="submit" className="underline">
              {t('logout')}
            </button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
