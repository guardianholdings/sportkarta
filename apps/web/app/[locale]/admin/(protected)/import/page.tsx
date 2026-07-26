import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { listImportJobs } from '@/lib/admin-data';
import { requireRole } from '@/lib/auth-session';

import { enqueueImport } from './actions';
import { ConfirmButton } from '@/components/ui/confirm-button';

const STATE_CLASSES: Record<string, string> = {
  completed: 'bg-success-bg text-success',
  failed: 'bg-danger-bg text-danger',
  active: 'bg-info-bg text-info',
  created: 'bg-warning-bg text-warning',
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
  // The layout only guarantees moderator; imports rewrite national data, so
  // this page — not just the action behind it — is admin-only.
  await requireRole('admin');
  const sp = await searchParams;
  const [t, jobs] = await Promise.all([getTranslations('AdminImport'), listImportJobs()]);

  return (
    <main className="space-y-6">
      <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
      <p className="max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>

      {sp.enqueued && (
        <p className="rounded-md border border-success-border bg-success-bg px-3 py-2 text-body-sm text-success">{t('enqueued')}</p>
      )}
      {sp.conflict && (
        <p className="rounded-md border border-warning-border bg-warning-bg px-3 py-2 text-body-sm text-warning">{t('alreadyQueued')}</p>
      )}

      <div className="flex flex-wrap gap-3">
        <form action={enqueueImport}>
          <input type="hidden" name="mode" value="dry-run" />
          <button type="submit" className="rounded border border-line-strong px-4 py-3 font-medium">
            {t('dryRun')}
          </button>
        </form>
        <form action={enqueueImport}>
          <input type="hidden" name="mode" value="live" />
          <ConfirmButton
            message={t('liveConfirm')}
            className="rounded-pill bg-brand px-5 py-3 text-body-sm font-semibold text-on-brand shadow-xs hover:bg-brand-hover"
          >
            {t('live')}
          </ConfirmButton>
        </form>
      </div>

      <section className="space-y-2">
        <h2 className="font-medium">{t('runsTitle')}</h2>
        {jobs.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('runsEmpty')}</p>
        ) : (
          <table className="w-full border-collapse text-body-sm">
            <thead>
              <tr className="border-b border-line-strong text-left text-caption text-text-muted">
                <th className="py-2 pr-3">{t('colState')}</th>
                <th className="py-2 pr-3">{t('colMode')}</th>
                <th className="py-2 pr-3">{t('colCreated')}</th>
                <th className="py-2 pr-3">{t('colCompleted')}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr key={job.id} className="border-b border-line">
                  <td className="py-2 pr-3">
                    <span
                      className={`inline-block rounded-pill px-2 py-0.5 text-caption font-medium ${STATE_CLASSES[job.state] ?? 'bg-paper-sunk text-ink-soft'}`}
                    >
                      {t.has(`state.${job.state}`) ? t(`state.${job.state}`) : job.state}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    {job.dryRun ? t('modeDry') : <strong>{t('modeLive')}</strong>}
                    {job.actor && <span className="text-caption text-text-muted"> · {job.actor}</span>}
                  </td>
                  <td className="py-2 pr-3 text-caption whitespace-nowrap">
                    {job.createdOn.slice(0, 16)}
                  </td>
                  <td className="py-2 pr-3 text-caption whitespace-nowrap">
                    {job.completedOn ? job.completedOn.slice(0, 16) : '—'}
                  </td>
                  <td className="py-2">
                    <Link href={`/admin/import/${job.id}`} className="text-caption font-medium text-link hover:text-link-hover">
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
