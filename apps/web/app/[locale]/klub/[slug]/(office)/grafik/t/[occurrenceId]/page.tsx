import { isoWeekKey } from '@sportkarta/lib/clubs';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { PrintButton } from '@/components/clubs/print-button';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { CHECKIN_EARLY_MINUTES } from '@/lib/clubs/checkin';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { isUuid } from '@/lib/clubs/input';
import { clubSportLabeler } from '@/lib/clubs/labels';
import { memberChoices } from '@/lib/clubs/members';
import { occurrenceRoster, type RosterPerson } from '@/lib/clubs/schedule';
import { formatDateTime, intlLocale } from '@/lib/format';
import { cn } from '@/lib/utils';

import { rosterOpAction } from '../../actions';

/**
 * One class on the trainer's phone and the desk's screen: who booked, who
 * waits, who walked in, and a «Присъства» per row. A meta refresh (no client
 * JavaScript) keeps kiosk check-ins appearing while the class runs — the
 * sessions roster envelope. A trainer sees the projection of
 * `rosterForTrainer` (a name and the minor flag); front of house also sees
 * whether a live abonnement covers each person.
 */
export const dynamic = 'force-dynamic';

const REFRESH_SECONDS = 60;
const HOUR_MS = 3_600_000;

/** Every `?rezultat=` the roster action can send back, with its tone. */
const OUTCOME_TONE: Readonly<Record<string, BadgeTone>> = {
  booked: 'success',
  waitlisted: 'warning',
  cancelled: 'success',
  cancelled_late: 'warning',
  checked_in: 'success',
  checked_in_uncovered: 'warning',
  already_checked_in: 'info',
  occurrence_cancelled: 'success',
  already: 'info',
  not_open_yet: 'danger',
  started: 'danger',
  closed: 'danger',
  not_found: 'danger',
  not_allowed: 'danger',
  not_linked: 'danger',
  club_closed: 'danger',
  too_early: 'danger',
  readOnly: 'danger',
};

const FLASH: Readonly<Record<BadgeTone, string>> = {
  success: 'border-success-border bg-success-bg',
  warning: 'border-warning-border bg-warning-bg',
  danger: 'border-danger-border bg-danger-bg',
  info: 'border-line bg-surface-2',
  neutral: 'border-line bg-surface-2',
  brand: 'border-brand-border bg-brand-subtle',
  accent: 'border-line bg-surface-2',
};

type PageParams = Promise<{ locale: string; slug: string; occurrenceId: string }>;

export async function generateMetadata({ params }: { params: PageParams }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'ClubSchedule' });
  return { title: t('roster'), robots: { index: false, follow: false } };
}

export default async function ClubRosterPage({
  params,
  searchParams,
}: {
  params: PageParams;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug, occurrenceId } = await params;
  setRequestLocale(locale);
  if (!isUuid(occurrenceId)) notFound();
  const { actor } = await requireClubStaff(slug, 'schedule.view');
  const full = actorCan(actor, 'roster.view');
  const roster = await occurrenceRoster(actor, occurrenceId, full);
  // A trainer who does not teach this class learns nothing, not even that it exists.
  if (!roster) notFound();
  const { rezultat } = await searchParams;
  const canBook = actorCan(actor, 'bookings.manage');
  const canAttend =
    actorCan(actor, 'attendance.record') || actorCan(actor, 'attendance.record_own');
  const canCancel = actorCan(actor, 'schedule.manage');
  const canOpenCard = actorCan(actor, 'members.view');

  const now = Date.now();
  const startsMs = Date.parse(roster.startsAt);
  const endsMs = Date.parse(roster.endsAt);
  const scheduled = roster.status === 'scheduled';
  const future = startsMs > now;
  const attendanceOpen = scheduled && now >= startsMs - CHECKIN_EARLY_MINUTES * 60_000;
  const live = scheduled && now >= startsMs - HOUR_MS && now <= endsMs + HOUR_MS;

  const [t, tClub, sportLabel, members] = await Promise.all([
    getTranslations('ClubSchedule'),
    getTranslations('Club'),
    clubSportLabeler(),
    canBook && scheduled && future ? memberChoices(actor) : Promise.resolve([]),
  ]);
  const going = roster.people.filter((p) => p.kind === 'going');
  const waitlisted = roster.people.filter((p) => p.kind === 'waitlisted');
  const walkIns = roster.people.filter((p) => p.kind === 'walk_in');
  const present = roster.people.filter((p) => p.checkedIn).length;
  const onRoster = new Set(roster.people.map((p) => p.memberId));
  const bookable = members.filter((m) => !onRoster.has(m.id));
  const endTime = new Intl.DateTimeFormat(intlLocale(locale), {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Sofia',
  }).format(new Date(roster.endsAt));
  const tone = rezultat ? OUTCOME_TONE[rezultat] : undefined;
  const hidden = (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="occurrenceId" value={roster.occurrenceId} />
    </>
  );
  const smallButton =
    'inline-flex min-h-11 items-center rounded-pill border border-line-strong bg-surface px-4 text-caption font-semibold text-ink-soft hover:bg-surface-2 focus-visible:shadow-[var(--ring)] focus-visible:outline-none';

  const row = (person: RosterPerson) => (
    <li key={`${person.kind}-${person.memberId}`} className="flex flex-wrap items-center gap-3 p-3">
      <span className="w-6 shrink-0 text-right font-mono text-body-sm tabular-nums text-text-muted">
        {person.position ?? ''}
      </span>
      <span className="min-w-0 flex-1">
        {full && canOpenCard ? (
          <Link
            href={`/klub/${slug}/chlenove/${person.memberId}`}
            className="font-medium text-link hover:text-link-hover"
          >
            {person.displayName}
          </Link>
        ) : (
          <span className="font-medium text-ink">{person.displayName}</span>
        )}
        <span className="mt-0.5 flex flex-wrap gap-1">
          {person.isMinor && <Badge tone="neutral">{tClub('minor')}</Badge>}
          {person.isTrial && <Badge tone="info">{t('rosterPage.trial')}</Badge>}
          {person.covered === true && <Badge tone="success">{t('rosterPage.covered')}</Badge>}
          {person.covered === false && <Badge tone="warning">{t('rosterPage.notCovered')}</Badge>}
        </span>
      </span>
      {person.checkedIn ? (
        <Badge tone="success">
          {t('rosterPage.checkedIn', {
            method: person.checkinMethod
              ? tClub(`checkinMethod.${person.checkinMethod}`)
              : tClub('unknown'),
          })}
        </Badge>
      ) : (
        attendanceOpen &&
        canAttend && (
          <form action={rosterOpAction} className="print:hidden">
            {hidden}
            <input type="hidden" name="op" value="present" />
            <input type="hidden" name="memberId" value={person.memberId} />
            <button type="submit" className={smallButton}>
              {t('rosterPage.markPresent')}
            </button>
          </form>
        )
      )}
      {canBook && person.bookingId && !person.checkedIn && scheduled && future && (
        <form action={rosterOpAction} className="print:hidden">
          {hidden}
          <input type="hidden" name="op" value="cancelBooking" />
          <input type="hidden" name="bookingId" value={person.bookingId} />
          <button type="submit" className={smallButton}>
            {t('rosterPage.cancelBooking')}
          </button>
        </form>
      )}
    </li>
  );

  return (
    <main className="club-roster mx-auto max-w-2xl space-y-4">
      {live && <meta httpEquiv="refresh" content={String(REFRESH_SECONDS)} />}

      <Link
        href={{
          pathname: `/klub/${slug}/grafik`,
          query: { sedmitsa: isoWeekKey(roster.localStart.slice(0, 10)) },
        }}
        className="text-body-sm font-semibold text-link hover:text-link-hover print:hidden"
      >
        ← {t('rosterPage.back')}
      </Link>

      <header className="space-y-1">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{roster.title}</h1>
        <p className="text-body-sm text-ink-soft">
          {formatDateTime(roster.startsAt, locale)}–{endTime} · {sportLabel(roster.sport)} ·{' '}
          {roster.locationName}
          {roster.instructorName ? ` · ${roster.instructorName}` : ''}
        </p>
        <p className="text-body-sm text-ink">
          {roster.capacity === null
            ? t('rosterPage.capacityOpen', { going: going.length })
            : t('rosterPage.capacity', { going: going.length, capacity: roster.capacity })}
          {' · '}
          {t('rosterPage.presentCount', { count: present })}
        </p>
        {!scheduled && (
          <p className="rounded-card border border-danger-border bg-danger-bg p-2 text-body-sm text-danger">
            {t('rosterPage.cancelledNotice')}
          </p>
        )}
        {scheduled && !attendanceOpen && canAttend && (
          <p className="text-caption text-text-muted print:hidden">
            {t('rosterPage.tooEarlyHint', { minutes: CHECKIN_EARLY_MINUTES })}
          </p>
        )}
      </header>

      <div role="status" aria-live="polite">
        {rezultat && tone && (
          <p className={cn('rounded-card border p-3 text-body-sm text-ink', FLASH[tone])}>
            {t(`rosterPage.outcome.${rezultat}`)}
          </p>
        )}
      </div>

      <section aria-labelledby="going-h" className="space-y-2">
        <h2 id="going-h" className="text-h4 font-bold text-ink">
          {t('rosterPage.going')}
        </h2>
        {going.length === 0 ? (
          <p className="rounded-card border border-line bg-surface px-4 py-6 text-center text-body-sm text-text-muted">
            {t('rosterPage.none')}
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {going.map(row)}
          </ul>
        )}
      </section>

      {waitlisted.length > 0 && (
        <section aria-labelledby="waiting-h" className="space-y-2">
          <h2 id="waiting-h" className="text-h4 font-bold text-ink">
            {t('rosterPage.waitlisted')}
          </h2>
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {waitlisted.map(row)}
          </ul>
        </section>
      )}

      {walkIns.length > 0 && (
        <section aria-labelledby="walkins-h" className="space-y-2">
          <h2 id="walkins-h" className="text-h4 font-bold text-ink">
            {t('rosterPage.walkIns')}
          </h2>
          <ul className="divide-y divide-line rounded-card border border-line bg-surface">
            {walkIns.map(row)}
          </ul>
        </section>
      )}

      {canBook && scheduled && future && (
        <section className="space-y-2 rounded-card border border-line bg-surface p-4 shadow-sm print:hidden">
          <h2 className="text-body font-bold text-ink">{t('rosterPage.book')}</h2>
          {bookable.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('rosterPage.noneToBook')}</p>
          ) : (
            <form action={rosterOpAction} className="flex flex-wrap items-end gap-2">
              {hidden}
              <input type="hidden" name="op" value="book" />
              <label className="min-w-0 flex-1 text-caption text-ink-soft">
                <span className="sr-only">{t('rosterPage.book')}</span>
                <Select name="memberId" required defaultValue="">
                  <option value="" disabled>
                    {t('rosterPage.memberPick')}
                  </option>
                  {bookable.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName}
                      {member.isMinor ? ` (${tClub('minor')})` : ''}
                    </option>
                  ))}
                </Select>
              </label>
              <Button type="submit" variant="secondary">
                {t('rosterPage.bookSubmit')}
              </Button>
            </form>
          )}
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <PrintButton
          label={t('rosterPage.print')}
          className={buttonVariants({ variant: 'secondary', size: 'sm' })}
        />
        {canCancel && scheduled && future && (
          <form action={rosterOpAction}>
            {hidden}
            <input type="hidden" name="op" value="cancelOccurrence" />
            <ConfirmButton
              message={t('rosterPage.cancelOccurrenceConfirm')}
              className={buttonVariants({ variant: 'danger', size: 'sm' })}
            >
              {t('rosterPage.cancelOccurrence')}
            </ConfirmButton>
          </form>
        )}
        {canCancel && (
          <Link
            href={`/klub/${slug}/grafik/${roster.classId}`}
            className="ml-auto inline-flex min-h-11 items-center text-body-sm font-semibold text-link hover:text-link-hover"
          >
            {t('editSeries')}
          </Link>
        )}
      </div>
    </main>
  );
}
