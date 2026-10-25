import { addDaysIso, isoWeekKey, isoWeekMonday, sofiaToday } from '@sportkarta/lib/clubs';
import { WEEKDAY_CODES } from '@sportkarta/lib/recurrence';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid } from '@/lib/clubs/input';
import { clubSportLabeler } from '@/lib/clubs/labels';
import { listClasses, weekOccurrences } from '@/lib/clubs/schedule';
import { clubLocations } from '@/lib/clubs/settings';
import { formatDate, intlLocale } from '@/lib/format';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * The week grid (`?sedmitsa=YYYY-Www&lokatsiya=`): seven columns on a wide
 * screen, stacked by day on a phone. Every staff role sees the timetable; a
 * trainer's own classes are marked and open their roster.
 */
export default async function ClubTimetablePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string }>;
  searchParams: Promise<{ sedmitsa?: string; lokatsiya?: string }>;
}) {
  const { locale, slug } = await params;
  setRequestLocale(locale);
  const { actor } = await requireClubStaff(slug, 'schedule.view');
  const query = await searchParams;
  const today = sofiaToday();
  const thisMonday = isoWeekMonday(isoWeekKey(today)) ?? today;
  const monday = (query.sedmitsa ? isoWeekMonday(query.sedmitsa) : null) ?? thisMonday;
  const locationId = isUuid(query.lokatsiya) ? query.lokatsiya : null;
  const canManage = actorCan(actor, 'schedule.manage');
  const rosterAll = actorCan(actor, 'roster.view');
  const rosterOwn = actorCan(actor, 'roster.view_own');
  const [t, tClub, sportLabel, occurrences, locations, classes] = await Promise.all([
    getTranslations('ClubSchedule'),
    getTranslations('Club'),
    clubSportLabeler(),
    weekOccurrences(actor, monday, locationId),
    clubLocations(actor),
    listClasses(actor),
  ]);
  const base = `/klub/${slug}/grafik`;
  const days = WEEKDAY_CODES.map((code, index) => ({ code, date: addDaysIso(monday, index) }));
  const timeOf = new Intl.DateTimeFormat(intlLocale(locale), {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Sofia',
  });
  const weekHref = (mondayOf: string) => ({
    pathname: base,
    query: {
      sedmitsa: isoWeekKey(mondayOf),
      ...(locationId ? { lokatsiya: locationId } : {}),
    },
  });
  const showLocation = locationId === null && locations.length > 1;
  const series = classes.filter((cls) => cls.status === 'scheduled');

  return (
    <main className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-h2 font-extrabold tracking-tight text-ink">{t('title')}</h1>
          <p className="mt-1 text-body-sm text-ink-soft">
            {t('week', {
              from: formatDate(monday, locale),
              to: formatDate(addDaysIso(monday, 6), locale),
            })}
          </p>
        </div>
        {canManage && (
          <Link href={`${base}/nova`} className={buttonVariants({ variant: 'accent' })}>
            <Plus aria-hidden="true" />
            {t('newClass')}
          </Link>
        )}
      </div>

      <nav
        aria-label={t('weekNav')}
        className="flex flex-wrap items-end gap-2 rounded-card border border-line bg-surface p-3 shadow-sm"
      >
        <Link
          href={weekHref(addDaysIso(monday, -7))}
          className={buttonVariants({ variant: 'secondary', size: 'sm' })}
        >
          <ChevronLeft aria-hidden="true" />
          {t('prevWeek')}
        </Link>
        {monday !== thisMonday && (
          <Link
            href={weekHref(thisMonday)}
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            {t('thisWeek')}
          </Link>
        )}
        <Link
          href={weekHref(addDaysIso(monday, 7))}
          className={buttonVariants({ variant: 'secondary', size: 'sm' })}
        >
          {t('nextWeek')}
          <ChevronRight aria-hidden="true" />
        </Link>
        {locations.length > 1 && (
          <form method="get" className="ml-auto flex flex-wrap items-end gap-2">
            <input type="hidden" name="sedmitsa" value={isoWeekKey(monday)} />
            <label className="text-caption text-ink-soft">
              <span className="sr-only">{t('allLocations')}</span>
              <Select name="lokatsiya" defaultValue={locationId ?? ''} size="sm">
                <option value="">{t('allLocations')}</option>
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
              </Select>
            </label>
            <Button type="submit" variant="secondary" size="sm">
              {t('show')}
            </Button>
          </form>
        )}
      </nav>

      {occurrences.length === 0 && (
        <p className="rounded-card border border-dashed border-line-strong p-6 text-center text-body-sm text-text-muted">
          {t('empty')}
        </p>
      )}

      <ol className="grid gap-3 lg:grid-cols-7">
        {days.map((day) => {
          const items = occurrences.filter((o) => o.localStart.slice(0, 10) === day.date);
          const isToday = day.date === today;
          return (
            <li key={day.date} className={cn('space-y-2', items.length === 0 && 'hidden lg:block')}>
              <h2
                className={cn(
                  'border-b pb-1 text-body-sm font-bold',
                  isToday ? 'border-brand text-brand' : 'border-line text-ink',
                )}
              >
                <span aria-hidden="true" className="capitalize">
                  {tClub(`weekday.${day.code}`)}
                </span>
                <span className="sr-only">{tClub(`weekdayLong.${day.code}`)}</span>{' '}
                <span className="font-normal text-ink-soft">
                  {formatDate(day.date, locale, 'medium')}
                </span>
              </h2>
              <ul className="space-y-2">
                {items.map((o) => {
                  const cancelled = o.status === 'cancelled';
                  const canRoster = rosterAll || (rosterOwn && o.mine);
                  const body = (
                    <>
                      <p className="font-mono text-caption tabular-nums text-ink-soft">
                        {o.localStart.slice(11, 16)}–{timeOf.format(new Date(o.endsAt))}
                      </p>
                      <p
                        className={cn(
                          'text-body-sm font-semibold text-ink',
                          cancelled && 'line-through',
                        )}
                      >
                        {o.title}
                      </p>
                      <p className="text-caption text-text-muted">
                        {sportLabel(o.sport)}
                        {showLocation ? ` · ${o.locationName}` : ''}
                      </p>
                      {o.instructorName && (
                        <p className="text-caption text-text-muted">{o.instructorName}</p>
                      )}
                      {o.instructorAway && !cancelled && (
                        <Badge tone="warning">{t('instructorAway')}</Badge>
                      )}
                      <p className="mt-1 flex flex-wrap items-center gap-1 text-caption text-ink">
                        {cancelled ? (
                          <Badge tone="danger">{t('cancelled')}</Badge>
                        ) : (
                          <>
                            <span className="tabular-nums">
                              {t('booked', {
                                going: o.going,
                                capacity: o.capacity === null ? 'none' : String(o.capacity),
                              })}
                            </span>
                            {o.waitlisted > 0 && (
                              <Badge tone="warning">{t('waitlist', { count: o.waitlisted })}</Badge>
                            )}
                          </>
                        )}
                        {o.mine && <Badge tone="brand">{t('mine')}</Badge>}
                      </p>
                    </>
                  );
                  const card = cn(
                    'block rounded-card border p-2 shadow-sm',
                    cancelled
                      ? 'border-line bg-paper-sunk opacity-75'
                      : o.mine
                        ? 'border-brand-border bg-brand-subtle'
                        : 'border-line bg-surface',
                  );
                  return (
                    <li key={o.id}>
                      {canRoster ? (
                        <Link
                          href={`${base}/t/${o.id}`}
                          className={cn(
                            card,
                            'min-h-11 transition-colors hover:border-brand focus-visible:shadow-[var(--ring)] focus-visible:outline-none',
                          )}
                        >
                          {body}
                          <span className="sr-only"> — {t('roster')}</span>
                        </Link>
                      ) : (
                        <div className={card}>{body}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>

      <section className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm">
        <h2 className="text-h4 font-bold text-ink">{t('classesTitle')}</h2>
        {series.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('noClasses')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {series.map((cls) => (
              <li
                key={cls.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-body-sm"
              >
                <span>
                  <span className="font-medium text-ink">{cls.title}</span>
                  <span className="block text-caption text-text-muted">
                    {sportLabel(cls.sport)} · {cls.locationName} ·{' '}
                    {cls.rrule ? t('repeats') : t('oneOff')} · {cls.startsAtLocal.slice(11, 16)}
                    {cls.instructorName ? ` · ${cls.instructorName}` : ''}
                  </span>
                </span>
                {canManage && (
                  <Link
                    href={`${base}/${cls.id}`}
                    className="inline-flex min-h-11 items-center font-semibold text-link hover:text-link-hover"
                  >
                    {t('editSeries')}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
