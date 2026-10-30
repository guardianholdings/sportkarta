import { getDb } from '@sportkarta/db';
import {
  addDaysIso,
  formatEuro,
  isIsoDate,
  serviceDurations,
  sofiaToday,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { isUuid, MAX_BOOKING_WINDOW_DAYS } from '@/lib/clubs/input';
import { memberChoices } from '@/lib/clubs/members';
import { availability, dayCalendar, type CalendarLane } from '@/lib/clubs/reservations';
import { clubServices } from '@/lib/clubs/services';
import { clubLocations } from '@/lib/clubs/settings';
import { formatDate, intlLocale } from '@/lib/format';
import { formErrorText, isOutcomeCode } from '@/lib/clubs/form-error';

import { deskBookAction, deskCancelAction } from './actions';

export const dynamic = 'force-dynamic';

/**
 * The day at one location (0048, wave C): a lane per court or room — its
 * classes, bookings and closures — and a lane per trainer with appointments;
 * and the desk's booking form, which offers only the slots the calendar can
 * still give. Stacked lists, so it reads the same on a phone.
 */
export default async function ClubCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{
    den?: string;
    mesto?: string;
    usluga?: string;
    prod?: string;
    rezultat?: string;
  }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor, club } = await requireClubStaff(slug, 'schedule.view');
  const query = await searchParams;
  const today = sofiaToday();
  const date =
    query.den && isIsoDate(query.den) && query.den <= addDaysIso(today, MAX_BOOKING_WINDOW_DAYS)
      ? query.den
      : today;
  const [t, messages, locations, services] = await Promise.all([
    getTranslations('ClubCalendar'),
    clubFormMessages(),
    clubLocations(actor),
    clubServices(actor),
  ]);
  const locationId =
    query.mesto && locations.some((l) => l.id === query.mesto) ? query.mesto : locations[0]?.id;
  const canBook = actorCan(actor, 'bookings.manage');
  const here = services.filter((s) => s.locationId === locationId);
  const service = here.find((s) => s.id === query.usluga) ?? null;
  const durations = service
    ? serviceDurations(service.durationMin, service.durationMax, service.stepMinutes)
    : [];
  const duration = service
    ? (durations.find((d) => String(d) === query.prod) ?? durations[0] ?? null)
    : null;
  const [calendar, slots, members] = await Promise.all([
    locationId ? dayCalendar(actor, locationId, date) : null,
    canBook && service && duration !== null && isUuid(service.id)
      ? availability(getDb(), club.id, service.id, date, duration, { member: false, office: true })
      : Promise.resolve([]),
    canBook && service ? memberChoices(actor) : Promise.resolve([]),
  ]);
  const time = new Intl.DateTimeFormat(intlLocale(locale), {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Europe/Sofia',
  });
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const small = 'text-caption text-ink-soft';
  const nav = (day: string) => ({
    pathname: `/klub/${slug}/kalendar`,
    query: { den: day, ...(locationId ? { mesto: locationId } : {}) },
  });

  const lane = (entry: CalendarLane) => (
    <li key={entry.id} className="space-y-1 py-2">
      <p className="text-body-sm font-bold text-ink">{entry.name}</p>
      {entry.items.length === 0 ? (
        <p className="text-caption text-text-muted">{t('free')}</p>
      ) : (
        <ul className="space-y-1">
          {entry.items.map((item) => (
            <li
              key={`${item.kind}-${item.id}`}
              className="flex flex-wrap items-center gap-2 text-body-sm"
            >
              <span className="font-mono tabular-nums text-ink">
                {time.format(new Date(item.startsAt))}–{time.format(new Date(item.endsAt))}
              </span>
              <span className="min-w-0 flex-1 text-ink">
                {item.kind === 'block' ? t(`blockReason.${item.title}`) : item.title}
                {item.memberName ? ` · ${item.memberName}` : ''}
                {item.state === 'held' ? ` · ${t('held')}` : ''}
              </span>
              <span className="text-caption text-text-muted">{t(`kind.${item.kind}`)}</span>
              {canBook && item.kind === 'reservation' && (
                <form action={deskCancelAction}>
                  <input type="hidden" name="slug" value={slug} />
                  <input type="hidden" name="reservationId" value={item.id} />
                  <input type="hidden" name="date" value={date} />
                  {locationId && <input type="hidden" name="locationId" value={locationId} />}
                  <ConfirmButton
                    message={t('cancelConfirm')}
                    className="min-h-9 rounded-pill border border-line-strong px-3 text-caption font-semibold text-ink hover:bg-surface-2"
                  >
                    {t('cancel')}
                  </ConfirmButton>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
    </li>
  );

  return (
    <main className="space-y-6">
      <div>
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
        <p className="mt-1.5 max-w-prose text-body-sm text-ink-soft">{t('intro')}</p>
      </div>

      <div role="status" aria-live="polite">
        {query.rezultat && (
          <p
            className={
              ['booked', 'cancelled', 'cancelled_refund'].includes(query.rezultat)
                ? 'rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
                : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
            }
          >
            {isOutcomeCode(query.rezultat) && t.has(`outcome.${query.rezultat}`)
              ? t(`outcome.${query.rezultat}`)
              : formErrorText(messages, query.rezultat)}
          </p>
        )}
      </div>

      {!locationId ? (
        <p className="text-body-sm text-text-muted">{t('needLocation')}</p>
      ) : (
        <>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <label className={small}>
              {t('date')}
              <Input name="den" type="date" size="sm" defaultValue={date} className="mt-1" />
            </label>
            {locations.length > 1 && (
              <label className={small}>
                {t('location')}
                <Select name="mesto" size="sm" defaultValue={locationId} className="mt-1">
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <Button type="submit" variant="secondary" size="sm">
              {t('show')}
            </Button>
            <Link href={nav(addDaysIso(date, -1))} className="text-body-sm font-semibold text-link">
              ← {t('prev')}
            </Link>
            <Link href={nav(addDaysIso(date, 1))} className="text-body-sm font-semibold text-link">
              {t('next')} →
            </Link>
          </form>

          <section className={section} aria-labelledby="day-h">
            <h2 id="day-h" className="text-h4 font-bold text-ink">
              {formatDate(date, locale)}
            </h2>
            {calendar && calendar.resources.length === 0 && calendar.trainers.length === 0 ? (
              <p className="text-body-sm text-text-muted">{t('noResources')}</p>
            ) : (
              <ul className="divide-y divide-line">
                {calendar?.resources.map(lane)}
                {calendar?.trainers.map(lane)}
              </ul>
            )}
          </section>

          {canBook && here.length > 0 && (
            <section className={section} aria-labelledby="book-h">
              <h2 id="book-h" className="text-h4 font-bold text-ink">
                {t('bookTitle')}
              </h2>
              <form method="get" className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="den" value={date} />
                <input type="hidden" name="mesto" value={locationId} />
                <label className={small}>
                  {t('service')}
                  <Select name="usluga" size="sm" defaultValue={service?.id ?? ''} className="mt-1">
                    <option value="">{t('pickService')}</option>
                    {here.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.nameBg}
                      </option>
                    ))}
                  </Select>
                </label>
                {service && durations.length > 1 && (
                  <label className={small}>
                    {t('duration')}
                    <Select name="prod" size="sm" defaultValue={String(duration)} className="mt-1">
                      {durations.map((d) => (
                        <option key={d} value={d}>
                          {t('minutes', { count: d })}
                        </option>
                      ))}
                    </Select>
                  </label>
                )}
                <Button type="submit" variant="secondary" size="sm">
                  {t('findSlots')}
                </Button>
              </form>
              {service &&
                duration !== null &&
                (slots.length === 0 ? (
                  <p className="text-body-sm text-text-muted">{t('noSlots')}</p>
                ) : (
                  <form action={deskBookAction} className="space-y-3">
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="serviceId" value={service.id} />
                    <input type="hidden" name="date" value={date} />
                    <input type="hidden" name="duration" value={duration} />
                    <input type="hidden" name="locationId" value={locationId} />
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
                    <label className="block text-body-sm font-semibold text-ink">
                      {t('member')}
                      <Select name="memberId" required className="mt-1">
                        <option value="">{t('pickMember')}</option>
                        {members.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.displayName}
                          </option>
                        ))}
                      </Select>
                    </label>
                    <p className="text-caption text-text-muted">{t('memberPriceHint')}</p>
                    <Button type="submit">{t('book')}</Button>
                  </form>
                ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}
