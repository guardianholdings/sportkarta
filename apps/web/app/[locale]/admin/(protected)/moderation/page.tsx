import { getLocale, getTranslations, setRequestLocale } from 'next-intl/server';

import { ConfirmButton } from '@/components/ui/confirm-button';
import { Link } from '@/i18n/navigation';
import { requireAdmin } from '@/lib/auth-session';
import {
  actorMunicipalities,
  moderationSla,
  queueFacilities,
  queuePhotos,
  queueReports,
  type QueueFlag,
} from '@/lib/moderation-data';

import { decideFacility, decidePhoto, resolveReport } from './actions';

export const dynamic = 'force-dynamic';

/** Pre-screen flags, shown next to the item they refer to — never a decision. */
function Flags({
  flags,
  label,
  labelFor,
}: {
  flags: QueueFlag[];
  label: string;
  /** Localised reason, falling back to the slug for an unknown vocabulary. */
  labelFor: (reason: string) => string;
}) {
  if (flags.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1" aria-label={label}>
      {flags.map((flag) => (
        <li
          key={flag.reason}
          title={flag.note ?? undefined}
          className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900"
        >
          {labelFor(flag.reason)}
        </li>
      ))}
    </ul>
  );
}

export default async function AdminModerationPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  // Ambassadors and admins both land here; everything below is scoped to what
  // this account may actually decide (lib/moderation.ts).
  const user = await requireAdmin();
  const actor = { id: user.id, role: user.role };

  const [t, tFacilities, tIssue, photos, reports, facilities, sla, scope, activeLocale] =
    await Promise.all([
      getTranslations('AdminModeration'),
      getTranslations('AdminFacilities'),
      getTranslations('Report'),
      queuePhotos(actor),
      queueReports(actor),
      queueFacilities(actor),
      moderationSla(actor),
      actorMunicipalities(actor),
      getLocale(),
    ]);

  const formatDate = (value: string): string =>
    new Intl.DateTimeFormat(activeLocale, { dateStyle: 'medium' }).format(new Date(value));
  const formatHours = (hours: number | null): string =>
    hours === null ? t('noData') : t('hours', { hours: hours.toFixed(1) });
  // The pre-screen vocabulary is closed, but a flag written before the UI knows
  // it should still show something readable rather than crash the page.
  const flagLabel = (reason: string): string =>
    t.has(`flag_${reason}`) ? t(`flag_${reason}`) : reason;

  return (
    <main className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold">{t('title')}</h1>
        {user.role === 'ambassador' && (
          <p className="text-sm text-neutral-600">
            {scope.length === 0
              ? t('noScope')
              : t('scopedTo', { municipalities: scope.map((m) => m.name).join(', ') })}
          </p>
        )}
      </div>

      <section aria-labelledby="sla-h" className="rounded border border-neutral-200 p-4">
        <h2 id="sla-h" className="mb-3 font-medium">
          {t('slaTitle')}
        </h2>
        <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-neutral-500">{t('slaMedian')}</dt>
            <dd className="text-lg font-semibold">{formatHours(sla.medianHours)}</dd>
            <dd className="text-xs text-neutral-500">
              {t('slaWindow', { days: sla.windowDays, decisions: sla.decisionsInWindow })}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-500">{t('slaOldest')}</dt>
            <dd className="text-lg font-semibold">{formatHours(sla.oldestPendingHours)}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">{t('slaQueue')}</dt>
            <dd className="text-lg font-semibold">
              {sla.pendingPhotos + sla.pendingReports + sla.pendingFacilities}
            </dd>
            <dd className="text-xs text-neutral-500">
              {t('slaBreakdown', {
                photos: sla.pendingPhotos,
                reports: sla.pendingReports,
                facilities: sla.pendingFacilities,
              })}
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">{t('facilitiesTitle')}</h2>
        {facilities.length === 0 ? (
          <p className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500">
            {t('facilitiesEmpty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {facilities.map((facility) => {
              const verify = decideFacility.bind(null, facility.id, 'verified' as const);
              const gone = decideFacility.bind(null, facility.id, 'gone' as const);
              return (
                <li
                  key={facility.id}
                  className="flex flex-wrap items-center gap-3 rounded border border-neutral-200 p-3 text-sm"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <Link
                      href={`/admin/facilities/${facility.id}`}
                      className="font-medium underline"
                    >
                      {facility.name ?? tFacilities('unnamed')}
                    </Link>
                    <div className="text-xs text-neutral-500">
                      {[facility.quarter, facility.municipalityName].filter(Boolean).join(', ')} ·{' '}
                      {formatDate(facility.createdAt)}
                    </div>
                    <Flags flags={facility.flags} label={t('flagsLabel')} labelFor={flagLabel} />
                  </div>
                  <form action={verify}>
                    <button
                      type="submit"
                      className="rounded bg-green-600 px-3 py-2 font-medium text-white"
                    >
                      {t('verifyFacility')}
                    </button>
                  </form>
                  <form action={gone}>
                    <ConfirmButton
                      className="rounded bg-red-600 px-3 py-2 font-medium text-white"
                      message={t('markGoneConfirm')}
                    >
                      {t('markGone')}
                    </ConfirmButton>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>

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
                  <div className="min-w-0 flex-1 space-y-1">
                    <Link href={`/admin/facilities/${photo.facilityId}`} className="underline">
                      {photo.facilityName ?? tFacilities('unnamed')}
                    </Link>
                    <div className="truncate text-xs text-neutral-500">
                      <code>{photo.storagePath}</code> ·{' '}
                      {t('uploadedBy', { who: photo.uploadedBy ?? t('unknownUploader') })} ·{' '}
                      {formatDate(photo.createdAt)}
                    </div>
                    <Flags flags={photo.flags} label={t('flagsLabel')} labelFor={flagLabel} />
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
                        {formatDate(report.createdAt)}
                      </span>
                    </div>
                    {report.body && <p className="text-neutral-700">{report.body}</p>}
                    <Flags flags={report.flags} label={t('flagsLabel')} labelFor={flagLabel} />
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
                    <button type="submit" className="rounded bg-neutral-200 px-3 py-2 font-medium">
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
