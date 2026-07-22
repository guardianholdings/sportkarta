import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/i18n/navigation';
import { pendingPhotos, pendingReports } from '@/lib/admin-data';

import { decidePhoto, resolveReport } from './actions';

export default async function AdminModerationPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, tFacilities, tIssue, photos, reports] = await Promise.all([
    getTranslations('AdminModeration'),
    getTranslations('AdminFacilities'),
    getTranslations('Report'),
    pendingPhotos(),
    pendingReports(),
  ]);

  return (
    <main className="space-y-6">
      <h1 className="text-xl font-semibold">{t('title')}</h1>

      <section className="space-y-3">
        <h2 className="font-medium">{t('photosTitle')}</h2>
        {photos.length === 0 ? (
          <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500">
            {t('photosEmpty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {photos.map((photo) => {
              const approve = decidePhoto.bind(null, photo.id, 'approved' as const);
              const reject = decidePhoto.bind(null, photo.id, 'rejected' as const);
              return (
                <li
                  key={photo.id}
                  className="flex flex-wrap items-center gap-3 rounded border border-neutral-200 p-3 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <Link href={`/admin/facilities/${photo.facilityId}`} className="underline">
                      {photo.facilityName ?? tFacilities('unnamed')}
                    </Link>
                    <div className="truncate text-xs text-neutral-500">
                      <code>{photo.storagePath}</code> ·{' '}
                      {t('uploadedBy', { who: photo.uploadedBy ?? t('unknownUploader') })} ·{' '}
                      {photo.createdAt.slice(0, 10)}
                    </div>
                  </div>
                  <form action={approve}>
                    <button
                      type="submit"
                      className="rounded bg-green-600 px-3 py-2 font-medium text-white"
                    >
                      {t('approve')}
                    </button>
                  </form>
                  <form action={reject}>
                    <button
                      type="submit"
                      className="rounded bg-red-600 px-3 py-2 font-medium text-white"
                    >
                      {t('reject')}
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">{t('reportsTitle')}</h2>
        {reports.length === 0 ? (
          <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500">
            {t('reportsEmpty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {reports.map((report) => {
              const markReviewed = resolveReport.bind(null, report.id, 'reviewed' as const);
              const dismiss = resolveReport.bind(null, report.id, 'dismissed' as const);
              return (
                <li
                  key={report.id}
                  className="flex flex-wrap items-start gap-3 rounded border border-neutral-200 p-3 text-sm"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/admin/facilities/${report.facilityId}`}
                        className="font-medium underline"
                      >
                        {report.facilityName ?? tFacilities('unnamed')}
                      </Link>
                      <span className="rounded bg-neutral-100 px-2 py-0.5 text-xs">
                        {tIssue(`issue.${report.issue}`)}
                      </span>
                      <span className="text-xs text-neutral-500">
                        {report.createdAt.slice(0, 10)}
                      </span>
                    </div>
                    {report.body && <p className="text-neutral-700">{report.body}</p>}
                    {report.photoPath && (
                      <p className="truncate text-xs text-neutral-500">
                        {t('reportPhoto')}: <code>{report.photoPath}</code>
                      </p>
                    )}
                  </div>
                  <form action={markReviewed}>
                    <button
                      type="submit"
                      className="rounded bg-green-600 px-3 py-2 font-medium text-white"
                    >
                      {t('markReviewed')}
                    </button>
                  </form>
                  <form action={dismiss}>
                    <button
                      type="submit"
                      className="rounded bg-neutral-500 px-3 py-2 font-medium text-white"
                    >
                      {t('dismiss')}
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
