import { formatEuro } from '@sportkarta/lib/clubs';
import { QrCode } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { StatusBadge } from '@/components/clubs/club-state-badge';
import { AppShell } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { clubSportLabeler } from '@/lib/clubs/labels';
import { portalView, type PortalMembership, type PortalRecord } from '@/lib/clubs/portal';
import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

import { portalOpAction } from './actions';

export const dynamic = 'force-dynamic';

const GOOD = new Set([
  'booked',
  'waitlisted',
  'cancelled',
  'passport_on',
  'passport_off',
  'linked',
]);
const GOOD_CHECKIN = new Set(['recorded', 'already']);

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubPortal' });
  return { title: t('overline'), robots: { index: false, follow: false } };
}

/** The membership a member should read first: live, then paused, then upcoming. */
function current(memberships: PortalMembership[]): PortalMembership | null {
  for (const state of ['active', 'paused', 'upcoming'] as const) {
    const found = memberships.find((m) => m.state === state);
    if (found) return found;
  }
  return null;
}

/**
 * A member's own club page: their abonnement in words, their bookings, this
 * week's classes to book (for themselves or a child), their QR, the passport
 * and mail switches, and the GDPR facts — the club is the controller. No money
 * moves here in v1: renewals happen at the desk.
 */
export default async function ClubPortalPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ rezultat?: string; otmetka?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  requireClubsEnabled();
  const user = await requireUser();
  const view = await portalView(user.id, slug, locale);
  if (!view) notFound();
  const query = await searchParams;
  const [t, tClub, sportLabel] = await Promise.all([
    getTranslations('ClubPortal'),
    getTranslations('Club'),
    clubSportLabeler(),
  ]);
  const { club, link, records, classes } = view;
  const now = Date.now();
  const booked = new Map<string, Set<string>>();
  for (const record of records) {
    for (const booking of record.bookings) {
      const set = booked.get(booking.occurrenceId) ?? new Set<string>();
      set.add(record.memberId);
      booked.set(booking.occurrenceId, set);
    }
  }
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const hidden = (memberId?: string) => (
    <>
      <input type="hidden" name="slug" value={slug} />
      {memberId && <input type="hidden" name="memberId" value={memberId} />}
    </>
  );
  const pill =
    'inline-flex min-h-11 items-center rounded-pill border border-line-strong bg-surface px-4 text-body-sm font-semibold text-ink hover:bg-surface-2 focus-visible:shadow-[var(--ring)] focus-visible:outline-none';

  const flash = query.otmetka
    ? {
        text: t.has(`checkin.${query.otmetka}`) ? t(`checkin.${query.otmetka}`) : null,
        good: GOOD_CHECKIN.has(query.otmetka),
        warn: query.otmetka === 'recorded_uncovered',
      }
    : query.rezultat
      ? {
          text: t.has(`outcome.${query.rezultat}`) ? t(`outcome.${query.rezultat}`) : null,
          good: GOOD.has(query.rezultat) || query.rezultat.startsWith('notify_'),
          warn: query.rezultat === 'cancelled_late',
        }
      : null;

  const membershipLine = (record: PortalRecord) => {
    const live = current(record.memberships);
    if (!live) return <StatusBadge kind="warning" label={t('noMembership')} />;
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <span className="font-semibold text-ink">{live.planName}</span>
        {live.state === 'paused' && <Badge tone="warning">{t('paused')}</Badge>}
        {live.state === 'upcoming' ? (
          <span className="text-body-sm text-ink-soft">
            {t('upcoming', { date: formatDate(live.startsOn, locale) })}
          </span>
        ) : (
          <StatusBadge
            kind="good"
            label={tClub('validUntil', { date: formatDate(live.effectiveEndsOn, locale) })}
          />
        )}
        {live.visitsRemaining !== null && (
          <span className="text-body-sm text-ink-soft">
            {tClub('visitsLeft', { count: live.visitsRemaining })}
          </span>
        )}
      </span>
    );
  };

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-2xl space-y-6 p-4">
        <header className="space-y-1 border-b border-line pb-3">
          <p className="text-caption font-semibold uppercase tracking-wide text-text-muted">
            {t('overline')}
          </p>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{club.name}</h1>
          <Link href="/klub" className="text-body-sm font-semibold text-link hover:text-link-hover">
            {t('toHub')}
          </Link>
        </header>

        <div role="status" aria-live="polite">
          {flash?.text && (
            <p
              className={cn(
                'rounded-card border p-3 text-body-sm text-ink',
                flash.warn
                  ? 'border-warning-border bg-warning-bg'
                  : flash.good
                    ? 'border-success-border bg-success-bg'
                    : 'border-danger-border bg-danger-bg',
              )}
            >
              {flash.text}
            </p>
          )}
        </div>

        {!link && (
          <section className={section}>
            <p className="text-body text-ink">{t('noRecord')}</p>
            <p className="text-body-sm text-ink-soft">{t('noRecordHint')}</p>
          </section>
        )}
        {link?.status === 'pending' && (
          <section className={section}>
            <p className="text-body text-ink">{t('pending')}</p>
          </section>
        )}
        {link?.status === 'active' && !club.live && (
          <p className="rounded-card border border-warning-border bg-warning-bg p-3 text-body-sm text-ink">
            {t('closed')}
          </p>
        )}

        {records.map((record) => (
          <section
            key={record.memberId}
            className={section}
            aria-labelledby={`r-${record.memberId}`}
          >
            <h2 id={`r-${record.memberId}`} className="text-h4 font-bold text-ink">
              {record.displayName} {record.isMinor && <Badge tone="neutral">{t('child')}</Badge>}
            </h2>
            <div className="space-y-1">
              <p className="text-caption text-text-muted">{t('membershipTitle')}</p>
              {membershipLine(record)}
              {record.owedCents > 0 && (
                <p>
                  <StatusBadge
                    kind="warning"
                    label={t('owes', { amount: formatEuro(record.owedCents, locale) })}
                  />
                </p>
              )}
              <p className="text-caption text-text-muted">{t('renewAtDesk')}</p>
            </div>
            <div className="space-y-2">
              <p className="text-caption text-text-muted">{t('bookingsTitle')}</p>
              {record.bookings.length === 0 ? (
                <p className="text-body-sm text-text-muted">{t('noBookings')}</p>
              ) : (
                <ul className="divide-y divide-line">
                  {record.bookings.map((booking) => {
                    const late = Date.parse(booking.freeCancelUntil) < now;
                    return (
                      <li
                        key={booking.bookingId}
                        className="flex flex-wrap items-center gap-3 py-2"
                      >
                        <span className="min-w-0 flex-1 text-body-sm">
                          <span className="font-medium text-ink">{booking.title}</span>
                          <span className="block text-caption text-text-muted">
                            {formatDateTime(booking.startsAt, locale)} · {booking.locationName}
                          </span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                            {booking.cancelled ? (
                              <Badge tone="danger">{t('occurrenceCancelled')}</Badge>
                            ) : booking.status === 'going' ? (
                              <Badge tone="success">{t('going')}</Badge>
                            ) : (
                              <Badge tone="warning">
                                {t('waitlisted', { position: booking.position })}
                              </Badge>
                            )}
                            {!booking.cancelled && (
                              <span className="text-caption text-text-muted">
                                {late
                                  ? t('lateCancel')
                                  : t('freeCancelUntil', {
                                      time: formatDateTime(booking.freeCancelUntil, locale),
                                    })}
                              </span>
                            )}
                          </span>
                        </span>
                        {!booking.cancelled && Date.parse(booking.startsAt) > now && (
                          <form action={portalOpAction}>
                            {hidden()}
                            <input type="hidden" name="op" value="cancel" />
                            <input type="hidden" name="bookingId" value={booking.bookingId} />
                            <button type="submit" className={pill}>
                              {t('cancel')}
                            </button>
                          </form>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        ))}

        {link?.status === 'active' && records.length > 0 && (
          <section className={section} aria-labelledby="week-h">
            <h2 id="week-h" className="text-h4 font-bold text-ink">
              {t('weekTitle')}
            </h2>
            {classes.length === 0 ? (
              <p className="text-body-sm text-text-muted">{t('noClasses')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {classes.map((cls) => {
                  const full = cls.capacity !== null && cls.going >= cls.capacity;
                  const open = Date.parse(cls.bookingOpensAt) <= now;
                  const already = booked.get(cls.occurrenceId) ?? new Set<string>();
                  const bookable = records.filter((record) => !already.has(record.memberId));
                  return (
                    <li key={cls.occurrenceId} className="space-y-2 py-3">
                      <p className="text-body-sm">
                        <span className="font-medium text-ink">{cls.title}</span>
                        <span className="block text-caption text-text-muted">
                          {formatDateTime(cls.startsAt, locale)} · {sportLabel(cls.sport)} ·{' '}
                          {cls.locationName}
                          {cls.instructorName ? ` · ${cls.instructorName}` : ''}
                        </span>
                        <span className="block text-caption text-ink-soft">
                          {full
                            ? t('full', { count: cls.waitlisted })
                            : cls.capacity === null
                              ? t('spotsOpen', { going: cls.going })
                              : t('spots', { going: cls.going, capacity: cls.capacity })}
                        </span>
                      </p>
                      {!club.live ? null : !open ? (
                        <p className="text-caption text-text-muted">
                          {t('opensAt', { time: formatDateTime(cls.bookingOpensAt, locale) })}
                        </p>
                      ) : (
                        <div className="flex flex-wrap gap-2">
                          {bookable.map((record) => (
                            <form key={record.memberId} action={portalOpAction}>
                              {hidden(record.memberId)}
                              <input type="hidden" name="op" value="book" />
                              <input type="hidden" name="occurrenceId" value={cls.occurrenceId} />
                              <button type="submit" className={pill}>
                                {full
                                  ? t('joinWaitlist')
                                  : record.self
                                    ? t('book')
                                    : t('bookFor', { name: record.displayName })}
                              </button>
                            </form>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        )}

        {link?.status === 'active' && records.length > 0 && (
          <section className={section} aria-labelledby="qr-h">
            <h2 id="qr-h" className="flex items-center gap-2 text-h4 font-bold text-ink">
              <QrCode aria-hidden="true" className="size-5" />
              {t('qrTitle')}
            </h2>
            <p className="text-body-sm text-ink-soft">{t('qrIntro')}</p>
            <div className="flex flex-wrap gap-2">
              {records.map((record) => (
                <Link
                  key={record.memberId}
                  href={{ pathname: `/klub/${slug}/az/qr`, query: { za: record.memberId } }}
                  className={buttonVariants({ variant: record.self ? 'primary' : 'secondary' })}
                >
                  {record.self ? t('qrOpen') : t('qrFor', { name: record.displayName })}
                </Link>
              ))}
            </div>
          </section>
        )}

        {link?.status === 'active' && (
          <section className={section} aria-labelledby="settings-h">
            <h2 id="settings-h" className="text-h4 font-bold text-ink">
              {t('settingsTitle')}
            </h2>
            {(
              [
                ['passport', link.passportConsent],
                ['notify', link.notifyEmail],
              ] as const
            ).map(([kind, on]) => (
              <div key={kind} className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-body-sm font-semibold text-ink">{t(`${kind}Title`)}</p>
                  <p className="text-caption text-ink-soft">{t(on ? `${kind}On` : `${kind}Off`)}</p>
                </div>
                <form action={portalOpAction}>
                  {hidden(link.memberId)}
                  <input type="hidden" name="op" value={kind} />
                  <input type="hidden" name="on" value={on ? '0' : '1'} />
                  <button type="submit" className={pill} aria-pressed={on}>
                    {t(on ? `${kind}Disable` : `${kind}Enable`)}
                  </button>
                </form>
              </div>
            ))}
          </section>
        )}

        {link?.status === 'active' && (
          <section className={section} aria-labelledby="data-h">
            <h2 id="data-h" className="text-h4 font-bold text-ink">
              {t('dataTitle')}
            </h2>
            <p className="text-body-sm text-ink-soft">{t('dataBody', { club: club.name })}</p>
            {(club.publicEmail || club.publicPhone) && (
              <p className="text-body-sm text-ink-soft">
                {t('contact')}:{' '}
                {club.publicEmail && (
                  <a href={`mailto:${club.publicEmail}`} className="font-semibold text-link">
                    {club.publicEmail}
                  </a>
                )}
                {club.publicEmail && club.publicPhone ? ' · ' : ''}
                {club.publicPhone && (
                  <a href={`tel:${club.publicPhone}`} className="font-semibold text-link">
                    {club.publicPhone}
                  </a>
                )}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {link.erasureRequested ? (
                <Badge tone="info">{t('erasureRequested')}</Badge>
              ) : (
                <form action={portalOpAction}>
                  {hidden(link.memberId)}
                  <input type="hidden" name="op" value="erasure" />
                  <ConfirmButton message={t('erasureConfirm')} className={pill}>
                    {t('erasure')}
                  </ConfirmButton>
                </form>
              )}
              <form action={portalOpAction}>
                {hidden(link.memberId)}
                <input type="hidden" name="op" value="unlink" />
                <ConfirmButton message={t('unlinkConfirm')} className={pill}>
                  {t('unlink')}
                </ConfirmButton>
              </form>
            </div>
          </section>
        )}
      </main>
    </AppShell>
  );
}
