import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { listImportJobs } from '@/lib/admin-data';

import { enqueueImport } from './actions';
import { ConfirmButton } from './confirm-button';

const STATE_CLASSES: Record<string, string> = {
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  active: 'bg-blue-100 text-blue-800',
  created: 'bg-amber-100 text-amber-800',
};

export default async function AdminImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const [t, jobs] = await Promise.all([getTranslations('AdminImport'), listImportJobs()]);

  return (
    <main className="space-y-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>
      <p className="max-w-prose text-sm text-neutral-600">{t('intro')}</p>

      {sp.enqueued && (
        <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">{t('enqueued')}</p>
      )}
      {sp.conflict && (
        <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">{t('alreadyQueued')}</p>
      )}

      <div className="flex flex-wrap gap-3">
        <form action={enqueueImport}>
          <input type="hidden" name="mode" value="dry-run" />
          <button type="submit" className="rounded border border-neutral-300 px-4 py-3 font-medium">
            {t('dryRun')}
          </button>
        </form>
        <form action={enqueueImport}>
          <input type="hidden" name="mode" value="live" />
          <ConfirmButton
            message={t('liveConfirm')}
            className="rounded bg-neutral-900 px-4 py-3 font-medium text-white"
          >
            {t('live')}
          </ConfirmButton>
        </form>
      </div>

      <section className="space-y-2">
        <h2 className="font-medium">{t('runsTitle')}</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-neutral-500">{t('runsEmpty')}</p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-300 text-left text-xs text-neutral-500">
                <th className="py-2 pr-3">{t('colState')}</th>
                <th className="py-2 pr-3">{t('colMode')}</th>
                <th className="py-2 pr-3">{t('colCreated')}</th>
                <th className="py-2 pr-3">{t('colCompleted')}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-b border-neutral-100">
                  <td className="py-2 pr-3">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATE_CLASSES[job.state] ?? 'bg-neutral-100 text-neutral-600'}`}
                    >
                      {job.state}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    {job.dryRun ? t('modeDry') : <strong>{t('modeLive')}</strong>}
                    {job.actor && <span className="text-xs text-neutral-500"> · {job.actor}</span>}
                  </td>
                  <td className="py-2 pr-3 text-xs whitespace-nowrap">
                    {job.createdOn.slice(0, 16)}
                  </td>
                  <td className="py-2 pr-3 text-xs whitespace-nowrap">
                    {job.completedOn ? job.completedOn.slice(0, 16) : '—'}
                  </td>
                  <td className="py-2">
                    <Link href={`/admin/import/${job.id}`} className="text-xs underline">
                      {t('report')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
