import { getDb } from '@sportkarta/db';
import { SELF_PAUSE_MAX_DAYS, formatEuro, sofiaToday } from '@sportkarta/lib/clubs';
import { QrCode } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { StatusBadge } from '@/components/clubs/club-state-badge';
import { PushToggle } from '@/components/pwa/push-toggle';
import { AppShell } from '@/components/shell/app-shell';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Link } from '@/i18n/navigation';
import { requireUser } from '@/lib/auth-session';
import { requireClubsEnabled } from '@/lib/clubs/club-session';
import { clubSportLabeler } from '@/lib/clubs/labels';
import { clubTakesPayments } from '@/lib/clubs/payments';
import { memberReservations, publicServices } from '@/lib/clubs/reservations';
import { clubTakesWallet, portalWalletBalances } from '@/lib/clubs/wallet';
import { portalView, type PortalMembership, type PortalRecord } from '@/lib/clubs/portal';
import { ownContact } from '@/lib/clubs/self-service';
import { formatDate, formatDateTime } from '@/lib/format';
import { pushPublicKey, pushToggleLabels } from '@/lib/push';
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
  'renewal_stopped',
  'paused',
  'contact_saved',
  'reservation_booked',
  'reservation_cancelled',
  'reservation_cancelled_refund',
]);
const GOOD_CHECKIN = new Set(['recorded', 'already']);

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale, slug } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubPortal' });
  return {
    title: t('overline'),
    robots: { index: false, follow: false },
    // Installing from the portal installs the club's own app (0051).
    manifest: `/klub/${slug}/manifest.webmanifest`,
  };
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
 * and mail switches, and the GDPR facts — the club is the controller. When
 * the club has connected its Stripe account (0046), an open charge is payable
 * here and a plan can be bought; the card is entered on Stripe's page, never
 * on pops.bg.
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
  const [t, tClub, tPush, sportLabel, pushLabels] = await Promise.all([
    getTranslations('ClubPortal'),
    getTranslations('Club'),
    getTranslations('PushDevice'),
    clubSportLabeler(),
    pushToggleLabels(),
  ]);
  // Push on this device (0051): offered only while POPS runs push.
  const pushKey = pushPublicKey();
  const { club, link, records, classes } = view;
  const [contact, takesPayments, reservations, services, walletOn, credit] = await Promise.all([
    link?.status === 'active' ? ownContact(getDb(), user.id, club.id) : Promise.resolve(null),
    club.live ? clubTakesPayments(club.id) : Promise.resolve(false),
    link?.status === 'active' ? memberReservations(user.id, club.id, locale) : Promise.resolve([]),
    publicServices(club.id, locale),
    clubTakesWallet(club.id),
    link?.status === 'active'
      ? portalWalletBalances(user.id, club.id)
      : Promise.resolve<Record<string, number>>({}),
  ]);
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
          good:
            GOOD.has(query.rezultat) ||
            query.rezultat.startsWith('notify_') ||
            query.rezultat.startsWith('push_'),
          warn:
            query.rezultat === 'cancelled_late' || query.rezultat === 'reservation_cancelled_late',
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
              {(walletOn || credit[record.memberId] !== undefined) && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <p className="min-w-0 flex-1 text-body-sm text-ink">
                    {t('wallet', { amount: formatEuro(credit[record.memberId] ?? 0, locale) })}
                  </p>
                  {walletOn && takesPayments && (
                    <form action={portalOpAction} className="flex items-center gap-2">
                      {hidden(record.memberId)}
                      <input type="hidden" name="op" value="top_up" />
                      <label className="sr-only" htmlFor={`top-${record.memberId}`}>
                        {t('walletAmount')}
                      </label>
                      <input
                        id={`top-${record.memberId}`}
                        name="amount"
                        inputMode="decimal"
                        required
                        placeholder={t('walletAmountPlaceholder')}
                        className="min-h-11 w-24 rounded-input border border-line-strong bg-surface px-3 text-body-sm text-ink"
                      />
                      <button type="submit" className={pill}>
                        {t('walletTopUp')}
                      </button>
                    </form>
                  )}
                </div>
              )}
              {takesPayments && record.openCharges.length > 0 && (
                <ul className="space-y-2 pt-1">
                  {record.openCharges.map((charge) => (
                    <li key={charge.chargeId} className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 text-body-sm text-ink">
                        {charge.label} · {formatEuro(charge.dueCents, locale)}
                        <span className="block text-caption text-text-muted">
                          {t('dueOn', { date: formatDate(charge.dueOn, locale) })}
                        </span>
                      </span>
                      <form action={portalOpAction}>
                        {hidden(record.memberId)}
                        <input type="hidden" name="op" value="pay" />
                        <input type="hidden" name="chargeId" value={charge.chargeId} />
                        <button type="submit" className={pill}>
                          {t('payOnline')}
                        </button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
              {(() => {
                // The chain's TAIL carries the renewal controls: once the next
                // period is in place, the one still running is not where a
                // notice or a pause belongs.
                const running = current(record.memberships);
                const live = running?.hasSuccessor
                  ? (record.memberships.find(
                      (m) => !m.hasSuccessor && (m.state === 'upcoming' || m.state === 'active'),
                    ) ?? running)
                  : running;
                if (!live)
                  return <p className="text-caption text-text-muted">{t('renewAtDesk')}</p>;
                return (
                  <div className="space-y-2 pt-1">
                    {!live.renews && (
                      <p className="text-caption text-text-muted">{t('renewAtDesk')}</p>
                    )}
                    {live.renews && (
                      <p className="text-body-sm text-ink-soft">
                        {live.renewalEndsOn
                          ? t('renewalEnds', { date: formatDate(live.renewalEndsOn, locale) })
                          : t('renewsAuto')}
                      </p>
                    )}
                    {club.live && live.renews && !live.renewalEndsOn && live.selfCancelAllowed && (
                      <form action={portalOpAction}>
                        {hidden(record.memberId)}
                        <input type="hidden" name="op" value="stop_renewal" />
                        <input type="hidden" name="membershipId" value={live.id} />
                        <ConfirmButton
                          message={t('stopRenewalConfirm', { days: live.noticeDays })}
                          className={pill}
                        >
                          {t('stopRenewal')}
                        </ConfirmButton>
                      </form>
                    )}
                    {club.live && live.selfPauseAllowed && !live.selfPaused && !live.online && (
                      <details className="rounded-card border border-line p-3">
                        <summary className="cursor-pointer text-body-sm font-semibold text-ink">
                          {t('pauseTitle')}
                        </summary>
                        <form
                          action={portalOpAction}
                          className="mt-2 flex flex-wrap items-end gap-2"
                        >
                          {hidden(record.memberId)}
                          <input type="hidden" name="op" value="pause" />
                          <input type="hidden" name="membershipId" value={live.id} />
                          <label className="text-caption text-ink-soft">
                            {t('pauseFrom')}
                            <input
                              type="date"
                              name="startsOn"
                              required
                              min={sofiaToday()}
                              defaultValue={sofiaToday()}
                              className="mt-1 block min-h-11 rounded-input border border-line-strong bg-surface px-3 text-body-sm focus-visible:border-brand text-ink"
                            />
                          </label>
                          <label className="text-caption text-ink-soft">
                            {t('pauseDays', { max: SELF_PAUSE_MAX_DAYS })}
                            <input
                              type="number"
                              name="days"
                              required
                              min={1}
                              max={SELF_PAUSE_MAX_DAYS}
                              defaultValue={7}
                              className="mt-1 block min-h-11 w-24 rounded-input border border-line-strong bg-surface px-3 text-body-sm focus-visible:border-brand text-ink"
                            />
                          </label>
                          <button type="submit" className={pill}>
                            {t('pauseSubmit')}
                          </button>
                        </form>
                        <p className="mt-2 text-caption text-text-muted">{t('pauseHint')}</p>
                      </details>
                    )}
                  </div>
                );
              })()}
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
                            ) : booking.attended ? (
                              <Badge tone="success">{t('attended')}</Badge>
                            ) : booking.status === 'going' ? (
                              <Badge tone="success">{t('going')}</Badge>
                            ) : (
                              <Badge tone="warning">
                                {t('waitlisted', { position: booking.position })}
                              </Badge>
                            )}
                            {!booking.cancelled && !booking.attended && (
                              <span className="text-caption text-text-muted">
                                {late
                                  ? booking.lateCancelFeeCents !== null
                                    ? t('lateCancelFee', {
                                        amount: formatEuro(booking.lateCancelFeeCents, locale),
                                      })
                                    : t('lateCancel')
                                  : booking.lateCancelFeeCents !== null
                                    ? t('freeCancelUntilFee', {
                                        time: formatDateTime(booking.freeCancelUntil, locale),
                                        amount: formatEuro(booking.lateCancelFeeCents, locale),
                                      })
                                    : t('freeCancelUntil', {
                                        time: formatDateTime(booking.freeCancelUntil, locale),
                                      })}
                                {booking.noShowFeeCents !== null &&
                                  ` · ${t('rules.noShowFee', { amount: formatEuro(booking.noShowFeeCents, locale) })}`}
                              </span>
                            )}
                          </span>
                        </span>
                        {!booking.cancelled &&
                          !booking.attended &&
                          Date.parse(booking.startsAt) > now && (
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

        {(reservations.length > 0 || services.length > 0) && (
          <section className={section} aria-labelledby="res-h">
            <h2 id="res-h" className="text-h4 font-bold text-ink">
              {t('reservationsTitle')}
            </h2>
            {reservations.length === 0 ? (
              <p className="text-body-sm text-text-muted">{t('noReservations')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {reservations.map((r) => {
                  // A held booking is never late: it is released, its charge voided.
                  const late = r.state === 'confirmed' && Date.parse(r.freeCancelUntil) < now;
                  const started = Date.parse(r.startsAt) <= now;
                  return (
                    <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
                      <span className="min-w-0 flex-1 text-body-sm">
                        <span className="font-medium text-ink">{r.serviceName}</span>
                        {records.length > 1 && (
                          <span className="text-text-muted"> · {r.memberName}</span>
                        )}
                        <span className="block text-caption text-text-muted">
                          {formatDateTime(r.startsAt, locale)}
                          {r.resourceName ? ` · ${r.resourceName}` : ''}
                          {r.trainerName ? ` · ${r.trainerName}` : ''}
                          {r.priceCents > 0 ? ` · ${formatEuro(r.priceCents, locale)}` : ''}
                        </span>
                        <span className="block text-caption text-text-muted">
                          {r.state === 'held'
                            ? t('reservationHeld')
                            : late
                              ? t('lateCancel')
                              : t('freeCancelUntil', {
                                  time: formatDateTime(r.freeCancelUntil, locale),
                                })}
                        </span>
                      </span>
                      {club.live && !started && (
                        <form action={portalOpAction}>
                          {hidden(r.memberId)}
                          <input type="hidden" name="op" value="cancel_reservation" />
                          <input type="hidden" name="reservationId" value={r.id} />
                          <ConfirmButton
                            message={
                              late ? t('cancelReservationLate') : t('cancelReservationConfirm')
                            }
                            className={pill}
                          >
                            {t('cancelReservation')}
                          </ConfirmButton>
                        </form>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {services.length > 0 && club.live && (
              <Link href={`/klub/${slug}/rezervatsiya`} className={pill}>
                {t('reserveCta')}
              </Link>
            )}
          </section>
        )}

        {takesPayments && (
          <section className={section} aria-labelledby="buy-h">
            <h2 id="buy-h" className="text-h4 font-bold text-ink">
              {t('buyTitle')}
            </h2>
            <p className="text-body-sm text-ink-soft">{t('buyHint')}</p>
            <Link href={`/klub/${slug}#ceni`} className={pill}>
              {t('buyCta')}
            </Link>
            {club.termsUrl && (
              <p className="text-caption text-text-muted">
                <a
                  href={club.termsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-link hover:text-link-hover"
                >
                  {t('termsLink')}
                </a>
              </p>
            )}
          </section>
        )}

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
                        <span className="block text-caption text-text-muted">
                          {[
                            t('rules.cancelHours', { hours: cls.cancelDeadlineHours }),
                            cls.lateCancelFeeCents !== null &&
                              t('rules.lateFee', {
                                amount: formatEuro(cls.lateCancelFeeCents, locale),
                              }),
                            cls.noShowFeeCents !== null &&
                              t('rules.noShowFee', {
                                amount: formatEuro(cls.noShowFeeCents, locale),
                              }),
                            cls.strikeLimit !== null &&
                              t('rules.strikes', {
                                limit: cls.strikeLimit,
                                days: cls.strikeDays ?? 30,
                              }),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
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
                ...(pushKey ? ([['push', link.notifyPush]] as const) : []),
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
            {pushKey && (
              <div className="space-y-1 border-t border-line pt-3">
                <p className="text-body-sm font-semibold text-ink">{tPush('title')}</p>
                <PushToggle publicKey={pushKey} labels={pushLabels} />
              </div>
            )}
          </section>
        )}

        {contact &&
          (() => {
            const self = contact;
            return (
              <section className={section} aria-labelledby="contact-h">
                <h2 id="contact-h" className="text-h4 font-bold text-ink">
                  {t('contactTitle')}
                </h2>
                <p className="text-caption text-ink-soft">{t('contactIntro')}</p>
                <form action={portalOpAction} className="space-y-3">
                  {hidden(self.memberId)}
                  <input type="hidden" name="op" value="contact" />
                  <label className="block text-body-sm font-semibold text-ink">
                    {t('contactPhone')}
                    <input
                      type="tel"
                      name="phone"
                      autoComplete="tel"
                      maxLength={32}
                      defaultValue={self.phone ?? ''}
                      className="mt-1 block min-h-11 w-full max-w-xs rounded-input border border-line-strong bg-surface px-3 text-body-sm focus-visible:border-brand font-normal text-ink"
                    />
                  </label>
                  <label className="flex min-h-11 items-start gap-3 text-body-sm text-ink">
                    <input
                      type="checkbox"
                      name="marketingEmail"
                      defaultChecked={self.marketingEmail}
                      className="mt-1 size-4 accent-[var(--brand)]"
                    />
                    {t('contactMarketingEmail', { club: club.name })}
                  </label>
                  <label className="flex min-h-11 items-start gap-3 text-body-sm text-ink">
                    <input
                      type="checkbox"
                      name="marketingSms"
                      defaultChecked={self.marketingSms}
                      className="mt-1 size-4 accent-[var(--brand)]"
                    />
                    {t('contactMarketingSms', { club: club.name })}
                  </label>
                  <p className="text-caption text-text-muted">{t('contactHint')}</p>
                  <button type="submit" className={pill}>
                    {t('contactSave')}
                  </button>
                </form>
              </section>
            );
          })()}

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
