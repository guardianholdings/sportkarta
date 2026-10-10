import { getDb } from '@sportkarta/db';
import { getLocale, getTranslations, setRequestLocale } from 'next-intl/server';

import { ReasonSelect } from '@/components/admin/reason-select';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Link } from '@/i18n/navigation';
import { requireAdmin } from '@/lib/auth-session';
import {
  actorMunicipalities,
  moderationSla,
  publishedPhotos,
  queueFacilities,
  queuePhotos,
  queueReports,
  type ModerationPhoto,
  type QueueFlag,
} from '@/lib/moderation-data';
import { pendingNotices, type QueueNotice } from '@/lib/notices';
import { photoUrl } from '@/lib/photo-url';
import { parsePhotoLookup } from '@/lib/photos';

import {
  decideFacility,
  decideNotice,
  decidePhoto,
  resolveReport,
  unpublishPhoto,
} from './actions';

export const dynamic = 'force-dynamic';

/**
 * The image itself, from the row-decides route (lib/photos.ts): this screen is
 * signed in, so a pending photo in the moderator's scope is served to them and
 * to nobody else. A moderator deciding from a file name cannot enforce "no
 * identifiable people", which is the whole point of the photo queue. Opens full
 * size in a new tab — a thumbnail is too small to judge a face by.
 */
function PhotoThumb({
  photoId,
  alt,
  openLabel,
}: {
  photoId: string;
  alt: string;
  openLabel: string;
}) {
  return (
    <a
      href={photoUrl(photoId)}
      target="_blank"
      rel="noopener noreferrer"
      title={openLabel}
      className="shrink-0 overflow-hidden rounded-md border border-line bg-paper-sunk"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- served by our own
          row-decides route; next/image is off (next.config.ts) */}
      <img src={photoUrl(photoId)} alt={alt} className="size-24 object-cover" />
    </a>
  );
}

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
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const sp = await searchParams;
  const lookupRaw = typeof sp.published === 'string' ? sp.published : '';
  const lookup = parsePhotoLookup(lookupRaw);

  // Ambassadors and admins both land here; everything below is scoped to what
  // this account may actually decide (lib/moderation.ts).
  const user = await requireAdmin();
  const actor = { id: user.id, role: user.role };

  // Notices are the controller's to answer, not a municipality's: an
  // ambassador neither sees nor decides them (decideNotice re-checks the role
  // inside its UPDATE).
  const isAdmin = user.role === 'admin';
  const [
    t,
    tFacilities,
    tIssue,
    tReason,
    tNotice,
    photos,
    published,
    reports,
    facilities,
    notices,
    sla,
    scope,
    activeLocale,
  ] = await Promise.all([
    getTranslations('AdminModeration'),
    getTranslations('AdminFacilities'),
    getTranslations('Report'),
    getTranslations('ModerationReason'),
    getTranslations('Notice'),
    queuePhotos(actor),
    lookup === 'invalid' ? Promise.resolve([]) : publishedPhotos(actor, lookup),
    queueReports(actor),
    queueFacilities(actor),
    isAdmin ? pendingNotices(getDb()) : Promise.resolve([] as QueueNotice[]),
    moderationSla(actor),
    actorMunicipalities(actor),
    getLocale(),
  ]);
  const reasonLabel = (slug: string): string => (tReason.has(slug) ? tReason(slug) : slug);

  const formatDate = (value: string): string =>
    new Intl.DateTimeFormat(activeLocale, { dateStyle: 'medium' }).format(new Date(value));
  // Who uploaded it, by display name — a raw account id tells a moderator
  // nothing, and a repeat uploader is what they most need to recognise. The
  // account screen is admin-only (requireRole('admin')), so only an admin gets
  // the link; an ambassador sees the name.
  const uploader = (photo: ModerationPhoto) =>
    t.rich('uploadedBy', {
      name:
        photo.uploadedBy === null
          ? t('unknownUploader')
          : (photo.uploaderName ?? t('uploaderUnnamed')),
      who: (chunks) =>
        photo.uploadedBy !== null && user.role === 'admin' ? (
          <Link
            href={`/admin/akaunti/${photo.uploadedBy}`}
            className="font-medium text-link hover:text-link-hover"
          >
            {chunks}
          </Link>
        ) : (
          <span className="font-medium text-ink-soft">{chunks}</span>
        ),
    });
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

      <section
        aria-labelledby="sla-h"
        className="rounded-card border border-line bg-surface p-4 shadow-sm"
      >
        <h2 id="sla-h" className="t-overline mb-3">
          {t('slaTitle')}
        </h2>
        <dl className="grid grid-cols-2 gap-4 text-body-sm sm:grid-cols-4">
          <div>
            <dt className="text-caption text-text-muted">{t('slaMedian')}</dt>
            <dd className="font-mono text-h4 font-bold text-ink tabular-nums">
              {formatHours(sla.medianHours)}
            </dd>
            <dd className="text-caption text-text-muted">
              {t('slaWindow', { days: sla.windowDays, decisions: sla.decisionsInWindow })}
            </dd>
          </div>
          <div>
            <dt className="text-caption text-text-muted">{t('slaOldest')}</dt>
            <dd className="font-mono text-h4 font-bold text-ink tabular-nums">
              {formatHours(sla.oldestPendingHours)}
            </dd>
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

      {isAdmin && (
        <section aria-labelledby="notices-h" className="space-y-3">
          <div className="space-y-1">
            <h2 id="notices-h" className="text-h4 font-bold text-ink">
              {t('noticesTitle')}
            </h2>
            <p className="text-caption text-text-muted">{t('noticesIntro')}</p>
          </div>
          {notices.length === 0 ? (
            <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
              {t('noticesEmpty')}
            </p>
          ) : (
            <ul className="space-y-2">
              {notices.map((notice) => {
                const act = decideNotice.bind(null, notice.id, 'actioned' as const);
                const dismissNotice = decideNotice.bind(null, notice.id, 'dismissed' as const);
                return (
                  <li
                    key={notice.id}
                    className="space-y-3 rounded-card border border-line bg-surface p-3 text-body-sm shadow-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-pill bg-paper-sunk px-2 py-0.5 text-caption text-ink-soft">
                        {tNotice(`category.${notice.category}`)}
                      </span>
                      <span className="font-mono text-caption text-text-muted">
                        {formatDate(notice.createdAt)}
                      </span>
                    </div>
                    {/* Shown as text AND linked: the value is constrained to
                        http(s) or a site path by lib/notices.ts and a CHECK, and
                        it opens without a referrer or an opener either way. */}
                    <a
                      href={notice.targetUrl}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="block break-all font-mono text-caption text-link hover:text-link-hover"
                    >
                      {notice.targetUrl}
                    </a>
                    <p className="whitespace-pre-line text-ink-soft">{notice.explanation}</p>
                    <p className="text-caption text-text-muted">
                      {notice.notifierName || notice.notifierEmail
                        ? t('noticeFrom', {
                            who: [notice.notifierName, notice.notifierEmail]
                              .filter(Boolean)
                              .join(' · '),
                          })
                        : t('noticeAnonymous')}
                    </p>
                    <div className="flex flex-wrap gap-3">
                      <form action={act} className="flex flex-wrap items-center gap-2">
                        <ReasonSelect
                          context="notice_actioned"
                          label={t('reasonLabel')}
                          placeholder={t('reasonPlaceholder')}
                          labelFor={reasonLabel}
                        />
                        <Button type="submit" variant="danger" size="sm">
                          {t('noticeAction')}
                        </Button>
                      </form>
                      <form action={dismissNotice} className="flex flex-wrap items-center gap-2">
                        <ReasonSelect
                          context="notice_dismissed"
                          label={t('reasonLabel')}
                          placeholder={t('reasonPlaceholder')}
                          labelFor={reasonLabel}
                        />
                        <Button type="submit" variant="secondary" size="sm">
                          {t('noticeDismiss')}
                        </Button>
                      </form>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-h4 font-bold text-ink">{t('facilitiesTitle')}</h2>
        <p className="text-caption text-text-muted">{t('refusalNote')}</p>
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
                  <form action={gone} className="flex flex-wrap items-center gap-2">
                    <ReasonSelect
                      context="facility_gone"
                      label={t('reasonLabel')}
                      placeholder={t('reasonPlaceholder')}
                      labelFor={reasonLabel}
                    />
                    <ConfirmButton
                      className="inline-flex min-h-11 items-center rounded-pill bg-danger px-4 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-[color-mix(in_oklab,var(--danger),black_12%)]"
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
        <div>
          <h2 className="text-h4 font-bold text-ink">{t('photosTitle')}</h2>
          <p className="text-caption text-text-muted">{t('rejectDeletes')}</p>
          <p className="text-caption text-text-muted">{t('refusalNote')}</p>
        </div>
        {photos.length === 0 ? (
          <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
            {t('photosEmpty')}
          </p>
        ) : (
          <ul className="space-y-2">
            {photos.map((photo) => {
              const approve = decidePhoto.bind(null, photo.id, 'approved' as const);
              const reject = decidePhoto.bind(null, photo.id, 'rejected' as const);
              const facilityName = photo.facilityName ?? tFacilities('unnamed');
              return (
                <li
                  key={photo.id}
                  className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3 text-body-sm shadow-sm"
                >
                  <PhotoThumb
                    photoId={photo.id}
                    alt={t('photoAlt', { facility: facilityName })}
                    openLabel={t('openFullSize')}
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <Link
                      href={`/admin/facilities/${photo.facilityId}`}
                      className="font-medium text-link hover:text-link-hover"
                    >
                      {facilityName}
                    </Link>
                    <div className="text-caption text-text-muted">
                      {uploader(photo)} · {formatDate(photo.createdAt)}
                    </div>
                    <Flags flags={photo.flags} label={t('flagsLabel')} labelFor={flagLabel} />
                  </div>
                  <form action={approve}>
                    <Button type="submit" size="sm">
                      {t('approve')}
                    </Button>
                  </form>
                  <form action={reject} className="flex flex-wrap items-center gap-2">
                    <ReasonSelect
                      context="photo_rejected"
                      label={t('reasonLabel')}
                      placeholder={t('reasonPlaceholder')}
                      labelFor={reasonLabel}
                    />
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

      <section aria-labelledby="published-h" className="space-y-3">
        <div>
          <h2 id="published-h" className="text-h4 font-bold text-ink">
            {t('publishedTitle')}
          </h2>
          <p className="text-caption text-text-muted">{t('publishedNote')}</p>
          <p className="text-caption text-text-muted">{t('refusalNote')}</p>
        </div>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <label className="min-w-0 flex-1 space-y-1">
            <span className="text-caption font-medium text-ink-soft">
              {t('publishedLookupLabel')}
            </span>
            <Input
              name="published"
              size="sm"
              defaultValue={lookupRaw}
              placeholder={t('publishedLookupPlaceholder')}
              invalid={lookup === 'invalid'}
            />
          </label>
          <Button type="submit" size="sm">
            {t('publishedLookupSubmit')}
          </Button>
          {lookup !== null && (
            <Link
              href="/admin/moderation"
              className="inline-flex min-h-9 items-center text-body-sm font-medium text-link hover:text-link-hover"
            >
              {t('publishedLookupClear')}
            </Link>
          )}
        </form>
        {lookup === 'invalid' ? (
          <p role="alert" className="text-body-sm text-danger">
            {t('publishedLookupInvalid')}
          </p>
        ) : published.length === 0 ? (
          <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
            {lookup === null ? t('publishedEmpty') : t('publishedNoMatch')}
          </p>
        ) : (
          <ul className="space-y-2">
            {published.map((photo) => {
              const takeDown = unpublishPhoto.bind(null, photo.id);
              const facilityName = photo.facilityName ?? tFacilities('unnamed');
              return (
                <li
                  key={photo.id}
                  className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-3 text-body-sm shadow-sm"
                >
                  <PhotoThumb
                    photoId={photo.id}
                    alt={t('photoAlt', { facility: facilityName })}
                    openLabel={t('openFullSize')}
                  />
                  <div className="min-w-0 flex-1 space-y-1">
                    <Link
                      href={`/admin/facilities/${photo.facilityId}`}
                      className="font-medium text-link hover:text-link-hover"
                    >
                      {facilityName}
                    </Link>
                    <div className="text-caption text-text-muted">
                      {uploader(photo)} · {formatDate(photo.createdAt)}
                    </div>
                  </div>
                  <form action={takeDown} className="flex flex-wrap items-center gap-2">
                    <ReasonSelect
                      context="photo_rejected"
                      label={t('reasonLabel')}
                      placeholder={t('reasonPlaceholder')}
                      labelFor={reasonLabel}
                    />
                    <ConfirmButton
                      className="inline-flex min-h-11 items-center rounded-pill bg-danger px-4 text-body-sm font-semibold text-on-brand shadow-xs focus-visible:shadow-[var(--ring)] hover:bg-[color-mix(in_oklab,var(--danger),black_12%)]"
                      message={t('unpublishConfirm')}
                    >
                      {t('unpublish')}
                    </ConfirmButton>
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
                  {/* The report's own evidence. The same photo waits in the
                      photo queue above for its publish decision; here it is
                      what the visitor is pointing at. */}
                  {report.photoId && (
                    <PhotoThumb
                      photoId={report.photoId}
                      alt={t('reportPhotoAlt', {
                        facility: report.facilityName ?? tFacilities('unnamed'),
                      })}
                      openLabel={t('openFullSize')}
                    />
                  )}
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
