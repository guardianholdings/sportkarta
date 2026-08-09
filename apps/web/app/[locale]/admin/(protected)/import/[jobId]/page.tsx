import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Link } from '@/i18n/navigation';
import { getImportJob } from '@/lib/admin-data';
import { requireRole } from '@/lib/auth-session';

export default async function AdminImportJobPage({
  params,
}: {
  params: Promise<{ locale: string; jobId: string }>;
}) {
  const { locale, jobId } = await params;
  setRequestLocale(locale);
  // Imports rewrite national data: admin-only, like the index page — the
  // (protected) layout alone admits ambassadors.
  await requireRole('admin');
  const [t, job] = await Promise.all([getTranslations('AdminImport'), getImportJob(jobId)]);
  if (!job) notFound();

  return (
    <main className="space-y-4">
      <Link
        href="/admin/import"
        className="text-body-sm font-medium text-link hover:text-link-hover"
      >
        {t('back')}
      </Link>
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">
        {t('reportTitle')} — {job.dryRun ? t('modeDry') : t('modeLive')} ·{' '}
        <span className="text-text-muted">
          {t.has(`state.${job.state}`) ? t(`state.${job.state}`) : job.state}
        </span>
      </h1>
      {job.report ? (
        <pre className="max-w-4xl overflow-x-auto rounded-md bg-paper-sunk p-4 text-caption whitespace-pre-wrap">
          {job.report}
        </pre>
      ) : (
        <p className="text-body-sm text-text-muted">{t('reportMissing')}</p>
      )}
    </main>
  );
}
