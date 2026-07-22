import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { Link } from '@/i18n/navigation';
import { getImportJob } from '@/lib/admin-data';

export default async function AdminImportJobPage({
  params,
}: {
  params: Promise<{ locale: string; jobId: string }>;
}) {
  const { locale, jobId } = await params;
  setRequestLocale(locale);
  const [t, job] = await Promise.all([getTranslations('AdminImport'), getImportJob(jobId)]);
  if (!job) notFound();

  return (
    <main className="space-y-4">
      <Link href="/admin/import" className="text-sm underline">
        {t('back')}
      </Link>
      <h1 className="text-xl font-semibold">
        {t('reportTitle')} — {job.dryRun ? t('modeDry') : t('modeLive')} ·{' '}
        <span className="text-neutral-500">{job.state}</span>
      </h1>
      {job.report ? (
        <pre className="max-w-4xl overflow-x-auto rounded bg-neutral-50 p-4 text-xs whitespace-pre-wrap">
          {job.report}
        </pre>
      ) : (
        <p className="text-sm text-neutral-500">{t('reportMissing')}</p>
      )}
    </main>
  );
}
