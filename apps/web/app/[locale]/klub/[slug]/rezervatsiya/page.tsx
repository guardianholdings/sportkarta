import { getDb } from '@sportkarta/db';
import { addDaysIso, formatEuro, isIsoDate, sofiaToday } from '@sportkarta/lib/clubs';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { AppShell } from '@/components/shell/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link, redirect } from '@/i18n/navigation';
import { getCurrentUser } from '@/lib/auth-session';
import { clubsEnabled } from '@/lib/clubs/access';
import { isOutcomeCode } from '@/lib/clubs/form-error';
import { clubTakesPayments } from '@/lib/clubs/payments';
import { portalView } from '@/lib/clubs/portal';
import { availability, publicServices } from '@/lib/clubs/reservations';
import { signInHref } from '@/lib/sign-in-destination';

import { bookAction } from './actions';

export const dynamic = 'force-dynamic';

type PageParams = Promise<{ locale: string; slug: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubBooking' });
  return { title: t('title'), robots: { index: false, follow: false } };
}

/**
 * Book a court or a trainer (0048, wave C): pick a service, a day and a
 * length, and the page lists only the slots the club's calendar can still
 * give — priced, with the member price where the club sets one. The booking
 * itself is re-checked on the server.
 */
export default async function ClubBookingPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ usluga?: string; den?: string; prod?: string; rezultat?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  if (!clubsEnabled()) notFound();
  const user = await getCurrentUser();
  if (!user) return redirect({ href: signInHref(`/klub/${slug}/rezervatsiya`), locale });
  const view = await portalView(user.id, slug, locale);
  if (!view) notFound();
  const [t, services] = await Promise.all([
    getTranslations('ClubBooking'),
    publicServices(view.club.id, locale),
  ]);
  const query = await searchParams;
  const today = sofiaToday();
  const service = services.find((s) => s.id === query.usluga) ?? services[0] ?? null;
  const date =
    query.den &&
    isIsoDate(query.den) &&
    query.den >= today &&
    service &&
    query.den <= addDaysIso(today, service.bookingWindowDays)
      ? query.den
      : today;
  const duration = service
    ? (service.durations.find((d) => String(d) === query.prod) ?? service.durations[0] ?? null)
    : null;
  const records = view.link?.status === 'active' ? view.records : [];
  const selfMissing = !records.some((r) => r.self);
  // The slots show the member price only when EVERY record that can be
  // chosen holds a real abonnement ON THE DAY SHOWN — the rule the server
  // prices the booked record by.
  const isMember =
    !selfMissing &&
    records.length > 0 &&
    records.every((r) =>
      r.memberships.some(
        (m) =>
          m.kind !== 'trial' &&
          (m.state === 'active' || m.state === 'paused' || m.state === 'upcoming') &&
          m.startsOn <= date &&
          date <= m.effectiveEndsOn,
      ),
    );
  const online =
    service?.payment === 'online_required' ? await clubTakesPayments(view.club.id) : true;
  const slots =
    service && duration !== null && view.club.live
      ? await availability(getDb(), view.club.id, service.id, date, duration, {
          member: isMember,
          office: false,
        })
      : [];
  const small = 'text-caption text-ink-soft';
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';

  return (
    <AppShell active={null}>
      <main className="mx-auto max-w-2xl space-y-4 p-4">
        <Link
          href={`/klub/${slug}/az`}
          className="text-body-sm font-semibold text-link hover:text-link-hover"
        >
          ← {view.club.name}
        </Link>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>

        <div role="status" aria-live="polite">
          {query.rezultat && (
            <p className="rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink">
              {isOutcomeCode(query.rezultat) && t.has(`error.${query.rezultat}`)
                ? t(`error.${query.rezultat}`)
                : t('error.generic')}
            </p>
          )}
        </div>

        {services.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('none')}</p>
        ) : (
          <>
            <form method="get" className={`${section} flex flex-wrap items-end gap-2`}>
              <label className={small}>
                {t('service')}
                <Select name="usluga" defaultValue={service?.id} className="mt-1">
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className={small}>
                {t('date')}
                <Input
                  name="den"
                  type="date"
                  min={today}
                  max={service ? addDaysIso(today, service.bookingWindowDays) : today}
                  defaultValue={date}
                  className="mt-1"
                />
              </label>
              {service && service.durations.length > 1 && (
                <label className={small}>
                  {t('duration')}
                  <Select name="prod" defaultValue={String(duration)} className="mt-1">
                    {service.durations.map((d) => (
                      <option key={d} value={d}>
                        {t('minutes', { count: d })}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              <Button type="submit" variant="secondary">
                {t('show')}
              </Button>
            </form>

            {service && (
              <section className={section} aria-labelledby="slots-h">
                <h2 id="slots-h" className="text-h4 font-bold text-ink">
                  {service.name}
                </h2>
                {service.description && (
                  <p className="whitespace-pre-line text-body-sm text-ink-soft">
                    {service.description}
                  </p>
                )}
                <p className="text-caption text-text-muted">
                  {t(service.priceUnit === 'hour' ? 'pricePerHour' : 'pricePerBooking', {
                    amount: formatEuro(service.priceCents, locale),
                  })}
                  {service.memberPriceCents !== null
                    ? ` · ${t('memberPrice', { amount: formatEuro(service.memberPriceCents, locale) })}`
                    : ''}
                  {' · '}
                  {t('cancelUntil', { hours: service.cancelDeadlineHours })}
                </p>
                {!view.club.live ? (
                  <p className="text-body-sm text-text-muted">{t('closed')}</p>
                ) : !online ? (
                  <p className="text-body-sm text-text-muted">{t('onlineUnavailable')}</p>
                ) : slots.length === 0 ? (
                  <p className="text-body-sm text-text-muted">{t('noSlots')}</p>
                ) : (
                  <form action={bookAction} className="space-y-3">
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="serviceId" value={service.id} />
                    <input type="hidden" name="date" value={date} />
                    <input type="hidden" name="duration" value={duration ?? ''} />
                    <fieldset className="flex flex-wrap gap-2">
                      <legend className="mb-1 text-body-sm font-semibold text-ink">
                        {t('slot')}
                      </legend>
                      {slots.map((slot, i) => (
                        <label
                          key={slot.local}
                          className="flex min-h-11 items-center gap-2 rounded-pill border border-line-strong px-3 text-body-sm text-ink has-[:checked]:border-brand"
                        >
                          <input
                            type="radio"
                            name="local"
                            value={slot.local}
                            defaultChecked={i === 0}
                            className="size-4 accent-[var(--brand)]"
                          />
                          {slot.local}
                          <span className="text-caption text-text-muted">
                            {formatEuro(slot.priceCents, locale)}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                    {(records.length > 1 || (records.length > 0 && selfMissing)) && (
                      <label className="block text-body-sm font-semibold text-ink">
                        {t('forWhom')}
                        <Select name="memberId" className="mt-1">
                          {selfMissing && <option value="">{t('forMe')}</option>}
                          {records.map((r) => (
                            <option key={r.memberId} value={r.memberId}>
                              {r.self ? t('forMe') : r.displayName}
                            </option>
                          ))}
                        </Select>
                      </label>
                    )}
                    {records.length === 1 && !selfMissing && (
                      <input type="hidden" name="memberId" value={records[0]?.memberId} />
                    )}
                    <p className="text-caption text-text-muted">
                      {service.payment === 'online_required'
                        ? t('payOnlineNow')
                        : service.payment === 'online_optional'
                          ? t('payOnlineLater')
                          : t('payAtDesk')}
                    </p>
                    <Button type="submit">{t('book')}</Button>
                  </form>
                )}
              </section>
            )}
          </>
        )}
      </main>
    </AppShell>
  );
}
