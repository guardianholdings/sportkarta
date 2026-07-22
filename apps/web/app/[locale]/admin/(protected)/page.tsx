import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { dashboardCounts } from '@/lib/admin-data';

export default async function AdminDashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('AdminDashboard');
  const counts = await dashboardCounts();

  const stats = [
    { label: t('statActive'), value: counts.active },
    { label: t('statNeedsVerification'), value: counts.needsVerification },
    { label: t('statGone'), value: counts.gone },
    { label: t('statPendingPhotos'), value: counts.pendingPhotos },
    { label: t('statMunicipalities'), value: counts.municipalities },
  ];

  return (
    <main className="space-y-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded border border-neutral-200 p-4">
            <div className="text-2xl font-semibold tabular-nums">{stat.value}</div>
            <div className="text-xs text-neutral-500">{stat.label}</div>
          </div>
        ))}
      </div>
      <Link
        href="/admin/verify"
        className="inline-block rounded bg-neutral-900 px-4 py-3 font-medium text-white"
      >
        {t('verifyCta')} →
      </Link>
    </main>
  );
}
