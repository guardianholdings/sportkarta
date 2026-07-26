import { getLocale, getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
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
          className="rounded-pill border border-warning-border bg-warning-bg px-2 py-0.5 text-caption text-warning"
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
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        {user.role === 'ambassador' && (
          <p className="text-body-sm text-ink-soft">
            {scope.length === 0
              ? t('noScope')
              : t('scopedTo', { municipalities: scope.map((m) => m.name).join(', ') })}
          </p>
        )}
      </div>

      <section aria-labelledby="sla-h" className="rounded-card border border-line bg-surface p-4 shadow-sm">
        <h2 id="sla-h" className="t-overline mb-3">
          {t('slaTitle')}
        </h2>
        <dl className="grid grid-cols-2 gap-4 text-body-sm sm:grid-cols-4">
          <div>
            <dt className="text-caption text-text-muted">{t('slaMedian')}</dt>
            <dd className="font-mono text-h4 font-bold text-ink tabular-nums">{formatHours(sla.medianHours)}</dd>
            <dd className="text-caption text-text-muted">
              {t('slaWindow', { days: sla.windowDays, decisions: sla.decisionsInWindow })}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">{t('slaOldest')}</dt>
            <dd className="font-mono text-h4 font-bold text-ink tabular-nums">{formatHours(sla.oldestPendingHours)}</dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">{t('slaQueue')}</dt>
            <dd className="font-mono text-h4 font-bold text-ink tabular-nums">
              {sla.pendingPhotos + sla.pendingReports + sla.pendingFacilities}
            </dd>
            <dd className="text-caption text-text-muted">
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
        <h2 className="text-h4 font-bold text-ink">{t('facilitiesTitle')}</h2>
        {facilities.length === 0 ? (
          <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
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
                  className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3 text-body-sm shadow-sm"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <Link
                      href={`/admin/facilities/${facility.id}`}
                      className="font-medium text-link hover:text-link-hover"
                    >
                      {facility.name ?? tFacilities('unnamed')}
                    </Link>
                    <div className="text-caption text-text-muted">
                      {[facility.quarter, facility.municipalityName].filter(Boolean).join(', ')} ·{' '}
                      {formatDate(facility.createdAt)}
                    </div>
                    <Flags flags={facility.flags} label={t('flagsLabel')} labelFor={flagLabel} />
                  </div>
                  <form action={verify}>
                    <Button type="submit" size="sm">
                      {t('verifyFacility')}
                    </Button>
                  </form>
                  <form action={gone}>
                    <ConfirmButton
                      className="inline-flex h-9 items-center rounded-pill bg-danger px-4 text-body-sm font-semibold text-on-brand shadow-xs hover:opacity-90"
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
        <h2 className="text-h4 font-bold text-ink">{t('photosTitle')}</h2>
        {photos.length === 0 ? (
          <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
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
                  className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3 text-body-sm shadow-sm"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <Link href={`/admin/facilities/${photo.facilityId}`} className="font-medium text-link hover:text-link-hover">
                      {photo.facilityName ?? tFacilities('unnamed')}
                    </Link>
                    <div className="truncate text-caption text-text-muted">
                      <code>{photo.storagePath}</code> ·{' '}
                      {t('uploadedBy', { who: photo.uploadedBy ?? t('unknownUploader') })} ·{' '}
                      {formatDate(photo.createdAt)}
                    </div>
                    <Flags flags={photo.flags} label={t('flagsLabel')} labelFor={flagLabel} />
                  </div>
                  <form action={approve}>
                    <Button type="submit" size="sm">
                      {t('approve')}
                    </Button>
                  </form>
                  <form action={reject}>
                    <Button type="submit" variant="danger" size="sm">
                      {t('reject')}
                    </Button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-h4 font-bold text-ink">{t('reportsTitle')}</h2>
        {reports.length === 0 ? (
          <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
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
                  className="flex flex-wrap items-start gap-3 rounded-card border border-line bg-surface p-3 text-body-sm shadow-sm"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/admin/facilities/${report.facilityId}`}
                        className="font-medium text-link hover:text-link-hover"
                      >
                        {report.facilityName ?? tFacilities('unnamed')}
                      </Link>
                      <span className="rounded-pill bg-paper-sunk px-2 py-0.5 text-caption text-ink-soft">
                        {tIssue(`issue.${report.issue}`)}
                      </span>
                      <span className="font-mono text-caption text-text-muted">
                        {formatDate(report.createdAt)}
                      </span>
                    </div>
                    {report.body && <p className="text-ink-soft">{report.body}</p>}
                    <Flags flags={report.flags} label={t('flagsLabel')} labelFor={flagLabel} />
                  </div>
                  <form action={markReviewed}>
                    <Button type="submit" size="sm">
                      {t('markReviewed')}
                    </Button>
                  </form>
                  <form action={dismiss}>
                    <Button type="submit" variant="secondary" size="sm">
                      {t('dismiss')}
                    </Button>
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
