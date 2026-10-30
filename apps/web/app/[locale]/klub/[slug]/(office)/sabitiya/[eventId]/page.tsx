import {
  CLUB_PLAN_AUDIENCES,
  EVENT_CAPACITY_MAX,
  EVENT_TEAM_NAME_MAX,
  EVENT_TICKET_NAME_MAX,
  euroInputValue,
  formatEuro,
} from '@sportkarta/lib/clubs';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { EventFields } from '@/components/clubs/event-fields';
import { TournamentPanel } from '@/components/clubs/tournament-panel';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmButton } from '@/components/ui/confirm-button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Link } from '@/i18n/navigation';
import { actorCan, requireClubStaff } from '@/lib/clubs/club-session';
import { eventForStaff, type EventPlace, type EventTicket } from '@/lib/clubs/events';
import { clubFormMessages } from '@/lib/clubs/form-labels';
import { isUuid } from '@/lib/clubs/input';
import { clubSportOptions } from '@/lib/clubs/labels';
import { memberChoices } from '@/lib/clubs/members';
import { clubResources } from '@/lib/clubs/resources';
import { clubLocations } from '@/lib/clubs/settings';
import { tournamentForStaff } from '@/lib/clubs/tournaments';
import { formatDateTime } from '@/lib/format';

import {
  archiveTicketAction,
  cancelEventAction,
  deskCancelPlaceAction,
  deskRegisterAction,
  drawTournamentAction,
  hideEntrantNameAction,
  publishEventAction,
  recordMatchAction,
  saveEventAction,
  saveTicketAction,
} from '../actions';

export const dynamic = 'force-dynamic';

const GOOD = new Set([
  'saved',
  'ticket_saved',
  'published',
  'event_cancelled',
  'event_cancelled_invoiced',
  'registered',
  'registered_waitlist',
  'place_cancelled',
  'place_cancelled_refund',
  'place_cancelled_invoice',
  'drawn',
  'result_saved',
  'name_hidden',
]);

const STATE_TONE: Record<string, BadgeTone> = {
  confirmed: 'success',
  held: 'warning',
  waitlisted: 'info',
};

/**
 * One event in the office (0053): what it is, its tickets, who has a seat and
 * who waits — and, for management, the settings, publication and
 * cancellation; for the front of house, registering a client at the desk and
 * giving a place up. The list of places is the front of house's (names are
 * members.view's): a trainer sees the counts only.
 */
export default async function ClubEventPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string; slug: string; eventId: string }>;
  searchParams: Promise<{ rezultat?: string }>;
}) {
  const { locale, slug, eventId } = await params;
  setRequestLocale(locale);
  if (!isUuid(eventId)) notFound();
  const { actor } = await requireClubStaff(slug, 'schedule.view');
  const event = await eventForStaff(actor, eventId, locale);
  if (!event) notFound();
  const canManage = actorCan(actor, 'events.manage');
  const canDesk = actorCan(actor, 'bookings.manage');
  const [t, tClub, messages, sports, locations, resources, members] = await Promise.all([
    getTranslations('ClubEvents'),
    getTranslations('Club'),
    clubFormMessages(),
    canManage ? clubSportOptions(locale) : Promise.resolve([]),
    canManage ? clubLocations(actor) : Promise.resolve([]),
    canManage ? clubResources(actor) : Promise.resolve([]),
    canDesk ? memberChoices(actor) : Promise.resolve([]),
  ]);
  const tournament =
    // Who runs the matches sees who plays them (a display name, the roster's
    // projection); the front of house too.
    event.kind === 'tournament' &&
    (actorCan(actor, 'members.view') || actorCan(actor, 'events.results'))
      ? await tournamentForStaff(actor, event.id)
      : null;
  const { rezultat } = await searchParams;
  const good = rezultat !== undefined && GOOD.has(rezultat);
  const section = 'space-y-3 rounded-card border border-line bg-surface p-4 shadow-sm';
  const field = 'block text-body-sm font-semibold text-ink';
  const small = 'block text-caption text-ink-soft';
  const editable = event.status !== 'cancelled';
  const running = new Date(event.endsAt).getTime() > Date.now();
  const liveTickets = event.tickets.filter((ticket) => !ticket.archived);
  const seated = event.places.filter((p) => p.state === 'confirmed' || p.state === 'held');
  const line = event.places.filter((p) => p.state === 'waitlisted');
  const ended = event.places.filter(
    (p) => p.state !== 'confirmed' && p.state !== 'held' && p.state !== 'waitlisted',
  );

  const ticketFields = (ticket: EventTicket | null) => (
    <>
      <input type="hidden" name="slug" value={slug} />
      <input type="hidden" name="eventId" value={event.id} />
      {ticket && <input type="hidden" name="ticketId" value={ticket.id} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={small}>
          {t('tickets.nameBg')}
          <Input
            name="nameBg"
            required
            maxLength={EVENT_TICKET_NAME_MAX}
            defaultValue={ticket?.nameBg ?? ''}
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('tickets.nameEn')}
          <Input
            name="nameEn"
            maxLength={EVENT_TICKET_NAME_MAX}
            defaultValue={ticket?.nameEn ?? ''}
            className="mt-1"
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <label className={small}>
          {t('tickets.price')}
          <Input
            name="price"
            inputMode="decimal"
            defaultValue={ticket ? euroInputValue(ticket.priceCents, locale) : '0'}
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('tickets.memberPrice')}
          <Input
            name="memberPrice"
            inputMode="decimal"
            defaultValue={
              ticket?.memberPriceCents != null
                ? euroInputValue(ticket.memberPriceCents, locale)
                : ''
            }
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('tickets.capacity')}
          <Input
            name="capacity"
            type="number"
            min={1}
            max={EVENT_CAPACITY_MAX}
            defaultValue={ticket?.capacity ?? ''}
            className="mt-1"
          />
        </label>
        <label className={small}>
          {t('tickets.audience')}
          <Select name="audience" defaultValue={ticket?.audience ?? 'all'} className="mt-1">
            {CLUB_PLAN_AUDIENCES.map((a) => (
              <option key={a} value={a}>
                {tClub(`audience.${a}`)}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <input type="hidden" name="sortOrder" value={ticket?.sortOrder ?? event.tickets.length} />
    </>
  );

  const placeRow = (place: EventPlace) => (
    <li key={place.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-body-sm">
      <span className="min-w-0 flex-1">
        {place.memberId ? (
          <Link
            href={`/klub/${slug}/chlenove/${place.memberId}`}
            className="font-semibold text-link hover:text-link-hover"
          >
            {place.memberName}
          </Link>
        ) : (
          <span className="font-semibold text-ink-soft">{t('places.erased')}</span>
        )}
        <span className="block text-caption text-text-muted">
          {[
            place.ticketName,
            place.teamName ? t('places.team', { team: place.teamName }) : null,
            place.owedCents > 0
              ? t('places.owed', { amount: formatEuro(place.owedCents, locale) })
              : null,
            place.holdExpiresAt
              ? t('places.holdUntil', { when: formatDateTime(place.holdExpiresAt, locale) })
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <Badge tone={STATE_TONE[place.state] ?? 'neutral'}>
        {place.position !== null
          ? t('places.position', { position: place.position })
          : t(`places.state.${place.state}`)}
      </Badge>
      {canDesk &&
        running &&
        (place.state === 'confirmed' || place.state === 'held' || place.state === 'waitlisted') && (
          <form action={deskCancelPlaceAction}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="eventId" value={event.id} />
            <input type="hidden" name="registrationId" value={place.id} />
            <ConfirmButton
              message={t('places.cancelConfirm')}
              className="min-h-9 rounded-pill border border-line-strong px-3 text-caption font-semibold text-ink hover:bg-surface-2"
            >
              {t('places.cancel')}
            </ConfirmButton>
          </form>
        )}
      {canDesk && place.namePublic && (
        <form action={hideEntrantNameAction}>
          <input type="hidden" name="slug" value={slug} />
          <input type="hidden" name="eventId" value={event.id} />
          <input type="hidden" name="registrationId" value={place.id} />
          <button
            type="submit"
            className="min-h-9 rounded-pill border border-line-strong px-3 text-caption font-semibold text-ink hover:bg-surface-2"
          >
            {t('places.hideName')}
          </button>
        </form>
      )}
    </li>
  );

  return (
    <main className="space-y-5">
      <Link
        href={`/klub/${slug}/sabitiya`}
        className="text-body-sm font-semibold text-link hover:text-link-hover"
      >
        ← {t('title')}
      </Link>
      <div className="space-y-1.5">
        <h1 className="text-h2 font-extrabold tracking-tight text-ink">{event.title}</h1>
        <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink-soft">
          <Badge tone="neutral">{t(`kinds.${event.kind}`)}</Badge>
          {event.status === 'draft' && <Badge tone="warning">{t('draft')}</Badge>}
          {event.status === 'cancelled' && <Badge tone="danger">{t('cancelled')}</Badge>}
          {!event.public && <Badge tone="neutral">{t('private')}</Badge>}
          <span>
            {formatDateTime(event.startsAt, locale)} – {formatDateTime(event.endsAt, locale)}
          </span>
        </p>
        <p className="text-body-sm text-ink">
          {[
            event.locationName,
            event.resourceName,
            event.capacity === null
              ? t('seatsOpen', { taken: event.taken })
              : t('seats', { taken: event.taken, capacity: event.capacity }),
            event.waitlisted > 0 ? t('waitlisted', { count: event.waitlisted }) : null,
            t(`form.payments.${event.payment}`),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </div>

      {rezultat && (
        <p
          role="status"
          className={
            good
              ? 'rounded-card border border-success-border bg-success-bg p-3 text-body-sm text-ink'
              : 'rounded-card border border-danger-border bg-danger-bg p-3 text-body-sm text-ink'
          }
        >
          {good
            ? t(`outcome.${rezultat}`)
            : rezultat === 'readOnly'
              ? messages.readOnly
              : (messages.errors[rezultat] ?? messages.genericError)}
        </p>
      )}

      {canManage && editable && (
        <section className={section} aria-labelledby="manage-h">
          <h2 id="manage-h" className="text-h4 font-bold text-ink">
            {t('manage.title')}
          </h2>
          <div className="flex flex-wrap gap-2">
            {event.status === 'draft' && (
              <form action={publishEventAction}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="eventId" value={event.id} />
                <Button type="submit" disabled={liveTickets.length === 0}>
                  {t('manage.publish')}
                </Button>
              </form>
            )}
            {event.status === 'published' && event.public && (
              <Link
                href={`/klub/${slug}/sabitie/${event.id}`}
                className="inline-flex min-h-11 items-center text-body-sm font-semibold text-link hover:text-link-hover"
              >
                {t('manage.publicPage')}
              </Link>
            )}
            {running && (
              <form action={cancelEventAction}>
                <input type="hidden" name="slug" value={slug} />
                <input type="hidden" name="eventId" value={event.id} />
                <ConfirmButton
                  message={t('manage.cancelConfirm', { count: seated.length + line.length })}
                  className="min-h-11 rounded-pill border border-danger-border px-4 text-body-sm font-semibold text-ink hover:bg-danger-bg"
                >
                  {t('manage.cancel')}
                </ConfirmButton>
              </form>
            )}
          </div>
          {event.status === 'draft' && (
            <p className="text-caption text-text-muted">
              {liveTickets.length === 0 ? t('manage.needTicket') : t('manage.publishHint')}
            </p>
          )}
        </section>
      )}

      <section className={section} aria-labelledby="tickets-h">
        <h2 id="tickets-h" className="text-h4 font-bold text-ink">
          {t('tickets.title')}
        </h2>
        {event.tickets.length === 0 ? (
          <p className="text-body-sm text-text-muted">{t('tickets.none')}</p>
        ) : (
          <ul className="divide-y divide-line">
            {event.tickets.map((ticket) => (
              <li key={ticket.id} className="space-y-2 py-2.5">
                <p className="flex flex-wrap items-baseline justify-between gap-2 text-body-sm">
                  <span className="font-semibold text-ink">
                    {ticket.name}
                    {ticket.archived && (
                      <Badge tone="neutral" className="ml-2">
                        {t('tickets.archived')}
                      </Badge>
                    )}
                  </span>
                  <span className="text-ink-soft">
                    {[
                      formatEuro(ticket.priceCents, locale),
                      ticket.memberPriceCents !== null
                        ? t('tickets.memberPriceShort', {
                            amount: formatEuro(ticket.memberPriceCents, locale),
                          })
                        : null,
                      ticket.capacity === null
                        ? t('seatsOpen', { taken: ticket.taken })
                        : t('seats', { taken: ticket.taken, capacity: ticket.capacity }),
                      ticket.audience === 'all' ? null : tClub(`audience.${ticket.audience}`),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </p>
                {canManage && editable && !ticket.archived && (
                  <details className="rounded-md border border-line p-3">
                    <summary className="cursor-pointer text-body-sm font-semibold text-link">
                      {t('tickets.edit')}
                    </summary>
                    <form action={saveTicketAction} className="mt-3 space-y-3">
                      {ticketFields(ticket)}
                      <Button type="submit" size="sm">
                        {t('tickets.save')}
                      </Button>
                    </form>
                    <form action={archiveTicketAction} className="mt-2">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="eventId" value={event.id} />
                      <input type="hidden" name="ticketId" value={ticket.id} />
                      <ConfirmButton
                        message={t('tickets.archiveConfirm')}
                        className="min-h-9 rounded-pill border border-line-strong px-3 text-caption font-semibold text-ink hover:bg-surface-2"
                      >
                        {t('tickets.archive')}
                      </ConfirmButton>
                    </form>
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
        {canManage && editable && (
          <details className="rounded-md border border-line p-3" open={event.tickets.length === 0}>
            <summary className="cursor-pointer text-body-sm font-semibold text-link">
              {t('tickets.add')}
            </summary>
            <form action={saveTicketAction} className="mt-3 space-y-3">
              {ticketFields(null)}
              <p className="text-caption text-text-muted">{t('tickets.hint')}</p>
              <Button type="submit" size="sm">
                {t('tickets.create')}
              </Button>
            </form>
          </details>
        )}
      </section>

      {tournament && (
        <TournamentPanel
          slug={slug}
          eventId={event.id}
          tournament={tournament}
          office
          canDraw={canManage && editable}
          canRecord={actorCan(actor, 'events.results') && editable}
          drawAction={drawTournamentAction}
          recordAction={recordMatchAction}
        />
      )}

      {canDesk && (
        <section className={section} aria-labelledby="places-h">
          <h2 id="places-h" className="text-h4 font-bold text-ink">
            {t('places.title')}
          </h2>
          {seated.length === 0 && line.length === 0 ? (
            <p className="text-body-sm text-text-muted">{t('places.none')}</p>
          ) : (
            <>
              {seated.length > 0 && (
                <ul className="divide-y divide-line">{seated.map(placeRow)}</ul>
              )}
              {line.length > 0 && (
                <>
                  <h3 className="pt-2 text-body-sm font-bold text-ink">{t('places.line')}</h3>
                  <ul className="divide-y divide-line">{line.map(placeRow)}</ul>
                </>
              )}
            </>
          )}
          {ended.length > 0 && (
            <details className="rounded-md border border-line p-3">
              <summary className="cursor-pointer text-body-sm font-semibold text-link">
                {t('places.ended', { count: ended.length })}
              </summary>
              <ul className="divide-y divide-line">{ended.map(placeRow)}</ul>
            </details>
          )}

          {event.status === 'published' && running && liveTickets.length > 0 && (
            <form action={deskRegisterAction} className="space-y-3 border-t border-line pt-3">
              <h3 className="text-body-sm font-bold text-ink">{t('desk.title')}</h3>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="eventId" value={event.id} />
              <input type="hidden" name="teamEvent" value={event.teamEvent ? '1' : '0'} />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={field}>
                  {t('desk.member')}
                  <Select name="memberId" required defaultValue="" className="mt-1">
                    <option value="">{t('desk.memberPick')}</option>
                    {members.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.displayName}
                        {m.isMinor ? ` · ${t('desk.minor')}` : ''}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className={field}>
                  {t('desk.ticket')}
                  <Select
                    name="ticketId"
                    required
                    defaultValue={liveTickets[0]?.id}
                    className="mt-1"
                  >
                    {liveTickets.map((ticket) => (
                      <option key={ticket.id} value={ticket.id}>
                        {ticket.name} · {formatEuro(ticket.priceCents, locale)}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              {event.teamEvent && (
                <label className={field}>
                  {t('desk.team')}
                  <Input
                    name="teamName"
                    required
                    maxLength={EVENT_TEAM_NAME_MAX}
                    className="mt-1"
                  />
                </label>
              )}
              <p className="text-caption text-text-muted">{t('desk.hint')}</p>
              <Button type="submit">{t('desk.submit')}</Button>
            </form>
          )}
        </section>
      )}

      {canManage && editable && (
        <details className={section}>
          <summary className="cursor-pointer text-h4 font-bold text-ink">
            {t('form.titleEdit')}
          </summary>
          <form action={saveEventAction} className="mt-3 space-y-3">
            <EventFields
              slug={slug}
              event={event}
              drawn={tournament !== null && tournament.format !== null}
              locations={locations.filter((l) => l.active || l.id === event.locationId)}
              resources={resources.filter((r) => !r.archived || r.id === event.resourceId)}
              sports={sports}
            />
            <Button type="submit">{t('form.save')}</Button>
          </form>
        </details>
      )}
    </main>
  );
}
