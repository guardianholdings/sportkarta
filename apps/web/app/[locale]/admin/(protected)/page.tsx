import { ArrowRight } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { dashboardCounts } from '@/lib/admin-data';
import { requireAdmin } from '@/lib/auth-session';

export default async function AdminDashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('AdminDashboard');
  // The layout already gated this page; the call is repeated for the ACTOR, so
  // an ambassador's tiles count only their own municipalities.
  const user = await requireAdmin();
  const counts = await dashboardCounts({ id: user.id, role: user.role });
  const isAdmin = user.role === 'admin';

  const stats = [
    { label: t('statActive'), value: counts.active },
    { label: t('statNeedsVerification'), value: counts.needsVerification },
    { label: t('statGone'), value: counts.gone },
    { label: t('statPendingPhotos'), value: counts.pendingPhotos },
    // An ambassador's own municipalities, not the country's (A-16).
    {
      label: isAdmin ? t('statMunicipalities') : t('statMyMunicipalities'),
      value: counts.municipalities,
    },
  ];

  return (
    <main className="space-y-6">
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
      {!isAdmin && counts.municipalities === 0 && (
        <p className="rounded-card border border-warning-border bg-warning-bg p-4 text-body-sm text-warning">
          {t('noScope')}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-card border border-line bg-surface p-4 shadow-sm"
          >
            <div className="font-mono text-h2 font-bold text-ink tabular-nums">{stat.value}</div>
            <div className="mt-1 text-caption text-text-muted">{stat.label}</div>
          </div>
        ))}
      </div>
      <Link
        href="/admin/verify"
        className="inline-flex h-11 items-center gap-2 rounded-pill bg-brand px-5 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-brand-hover"
      >
        {t('verifyCta')}
        <ArrowRight size={18} />
      </Link>
    </main>
  );
}
