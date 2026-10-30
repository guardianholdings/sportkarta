import {
  getDb,
  lockEvent,
  promoteEventWaitlist,
  releaseLapsedEventHolds,
  sql,
  type EventPromotion,
  type SQL,
} from '@sportkarta/db';
import {
  EVENT_HOLD_MINUTES,
  EVENT_TICKETS_MAX,
  audienceFits,
  registrationOpen,
  ticketPrice,
  type ClubPlanAudience,
  type EventKind,
  type EventPayment,
  type EventStatus,
  type RegistrationState,
} from '@sportkarta/lib/clubs';

import { clubRenderableSql, clubWritableGuard } from './access';
import { recordClubAudit } from './audit';
import { ensureSelfRecord } from './bookings';
import { pgError, violatedConstraint } from './errors';
import { liveInvoiceFor } from './invoices';
import type { EventInput, EventRegistrationInput, EventTicketInput } from './input';
import {
  MIN_ONLINE_CENTS,
  closeChargeCheckout,
  clubTakesPayments,
  onlineProvider,
} from './payments';
import { clubActorMay, clubScope, clubWriteScope, memberSelfScope, type ClubActor } from './scope';

/**
 * Events, camps, workshops and tournaments (0053, wave D1 — 1club's events,
 * anolla's camps and tournaments).
 *
 * The office (events.manage, management) puts an event on: a draft first,
 * its ticket types, then «Публикувай». A person registers for a ticket — the
 * member themselves or for a child from the event's page, the desk for anybody
 * (bookings.manage). The DATABASE decides who gets a seat: the seat trigger
 * counts under the event row lock, and refuses a newcomer a seat while
 * somebody waits in line for that ticket. A person who finds no seat joins the
 * line in arrival order; a freed seat goes to the first in line in the same
 * transaction that freed it (promoteEventWaitlist).
 *
 * Money follows the court bookings (0048): a priced seat raises a charge
 * (kind `event`, due on the event's day, one charge per place); a seat at an
 * event that takes payment online only is HELD while the person pays
 * (EVENT_HOLD_MINUTES, or EVENT_OFFER_HOURS for a seat offered from the line),
 * and the payment confirms it wherever it is taken (0053's trigger). Giving a
 * place up in time voids the charge — money already paid is a refund the
 * office owes (refundsDue); late keeps the charge.
 *
 * LOCK ORDER: users (ensureSelfRecord) → the event → checkouts → charges →
 * registrations — db/src/clubs/events.ts's order, which a payment never
 * crosses.
 *
 * Notices go after the commit, by the caller (enqueueClubNotify): ids only.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function intOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export interface ClubEvent {
  id: string;
  kind: EventKind;
  titleBg: string;
  titleEn: string | null;
  /** In the page's language: the English title where there is one. */
  title: string;
  descriptionBg: string | null;
  descriptionEn: string | null;
  description: string | null;
  sport: string | null;
  locationId: string;
  locationName: string;
  resourceId: string | null;
  resourceName: string | null;
  startsAt: string;
  endsAt: string;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  capacity: number | null;
  teamEvent: boolean;
  payment: EventPayment;
  cancelDeadlineHours: number;
  public: boolean;
  status: EventStatus;
  /** Seats held or confirmed. */
  taken: number;
  waitlisted: number;
}

const EVENT_COLUMNS = (locale: string) => sql`
  ev.id, ev.kind, ev.title_bg, ev.title_en, ev.description_bg, ev.description_en, ev.sport,
  ev.location_id, l.name AS location_name, ev.resource_id, rs.name AS resource_name,
  ev.starts_at, ev.ends_at, ev.registration_opens_at, ev.registration_closes_at, ev.capacity,
  ev.team_event, ev.payment, ev.cancel_deadline_hours, ev.public, ev.status,
  CASE WHEN ${locale} = 'en' THEN coalesce(ev.title_en, ev.title_bg) ELSE ev.title_bg END AS title,
  CASE WHEN ${locale} = 'en' THEN coalesce(ev.description_en, ev.description_bg)
       ELSE ev.description_bg END AS description,
  (SELECT count(*)::int FROM club_event_registrations er
    WHERE er.club_id = ev.club_id AND er.event_id = ev.id AND er.state IN ('held', 'confirmed')) AS taken,
  (SELECT count(*)::int FROM club_event_registrations er
    WHERE er.club_id = ev.club_id AND er.event_id = ev.id AND er.state = 'waitlisted') AS waitlisted`;

const EVENT_JOINS = sql`
  JOIN club_locations l ON l.club_id = ev.club_id AND l.id = ev.location_id
  LEFT JOIN club_resources rs ON rs.club_id = ev.club_id AND rs.id = ev.resource_id`;

function toEvent(row: Record<string, unknown>): ClubEvent {
  return {
    id: String(row.id),
    kind: String(row.kind) as EventKind,
    titleBg: String(row.title_bg),
    titleEn: text(row.title_en),
    title: String(row.title),
    descriptionBg: text(row.description_bg),
    descriptionEn: text(row.description_en),
    description: text(row.description),
    sport: text(row.sport),
    locationId: String(row.location_id),
    locationName: String(row.location_name),
    resourceId: text(row.resource_id),
    resourceName: text(row.resource_name),
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    registrationOpensAt: isoOrNull(row.registration_opens_at),
    registrationClosesAt: isoOrNull(row.registration_closes_at),
    capacity: intOrNull(row.capacity),
    teamEvent: row.team_event === true,
    payment: String(row.payment) as EventPayment,
    cancelDeadlineHours: Number(row.cancel_deadline_hours),
    public: row.public === true,
    status: String(row.status) as EventStatus,
    taken: Number(row.taken ?? 0),
    waitlisted: Number(row.waitlisted ?? 0),
  };
}

export interface EventTicket {
  id: string;
  nameBg: string;
  nameEn: string | null;
  name: string;
  priceCents: number;
  memberPriceCents: number | null;
  capacity: number | null;
  audience: ClubPlanAudience;
  sortOrder: number;
  archived: boolean;
  /** Seats held or confirmed on this ticket. */
  taken: number;
}

const TICKET_COLUMNS = (locale: string) => sql`
  et.id, et.name_bg, et.name_en, et.price_cents, et.member_price_cents, et.capacity, et.audience,
  et.sort_order, et.archived_at IS NOT NULL AS archived,
  CASE WHEN ${locale} = 'en' THEN coalesce(et.name_en, et.name_bg) ELSE et.name_bg END AS name,
  (SELECT count(*)::int FROM club_event_registrations er
    WHERE er.club_id = et.club_id AND er.ticket_id = et.id AND er.state IN ('held', 'confirmed')) AS taken`;

function toTicket(row: Record<string, unknown>): EventTicket {
  return {
    id: String(row.id),
    nameBg: String(row.name_bg),
    nameEn: text(row.name_en),
    name: String(row.name),
    priceCents: Number(row.price_cents),
    memberPriceCents: intOrNull(row.member_price_cents),
    capacity: intOrNull(row.capacity),
    audience: String(row.audience) as ClubPlanAudience,
    sortOrder: Number(row.sort_order),
    archived: row.archived === true,
    taken: Number(row.taken ?? 0),
  };
}

// ─── The office ─────────────────────────────────────────────────────────────

export const EVENT_FILTERS = ['upcoming', 'drafts', 'past', 'cancelled'] as const;
export type EventFilter = (typeof EVENT_FILTERS)[number];

/** The office's list. Everybody on the staff sees the club's events (schedule.view). */
export async function listEvents(
  actor: ClubActor,
  filter: EventFilter,
  locale: string,
): Promise<ClubEvent[]> {
  const where: Record<EventFilter, SQL> = {
    upcoming: sql`ev.status = 'published' AND ev.ends_at > now()`,
    drafts: sql`ev.status = 'draft'`,
    past: sql`ev.status = 'published' AND ev.ends_at <= now()`,
    cancelled: sql`ev.status = 'cancelled'`,
  };
  const result = await getDb().execute(sql`
    SELECT ${EVENT_COLUMNS(locale)}
      FROM club_events ev ${EVENT_JOINS}
     WHERE ${clubScope(actor, 'schedule.view', 'ev')} AND ${where[filter]}
     ORDER BY ${filter === 'past' || filter === 'cancelled' ? sql`ev.starts_at DESC` : sql`ev.starts_at`}
     LIMIT 200
  `);
  return result.rows.map(toEvent);
}

export interface EventPlace {
  id: string;
  memberId: string | null;
  memberName: string | null;
  ticketId: string;
  ticketName: string;
  state: RegistrationState;
  /** Place in line, 1-based — waitlisted places only. */
  position: number | null;
  teamName: string | null;
  priceCents: number;
  chargeId: string | null;
  owedCents: number;
  holdExpiresAt: string | null;
  createdAt: string;
}

/**
 * SQL (er = the place, ev = its event): a place SEATED FROM THE LINE after
 * its free-cancel deadline — never accepted late, so it may be given up free
 * until the start. (A seat taken at registration has seated_at = created_at,
 * one transaction; a promotion seats it later.)
 */
const SEATED_LATE_FROM_LINE = sql`(er.seated_at > er.created_at
  AND er.seated_at > er.free_cancel_until)`;

/**
 * SQL: the free-cancel instant in force — the one promised at registration,
 * or a later one when the event was postponed (a person who cannot make the
 * new date may leave on the new terms). Moving it earlier never shortens it.
 */
const DEADLINE = sql`greatest(er.free_cancel_until,
  ev.starts_at - make_interval(hours => er.cancel_deadline_hours))`;

/**
 * SQL: giving the place up now is LATE — past the deadline in force, unless
 * the line seated it after the deadline it was registered under.
 */
const LATE_NOW = sql`(now() > ${DEADLINE} AND NOT ${SEATED_LATE_FROM_LINE})`;

/** SQL: until when giving the place up costs nothing (see LATE_NOW). */
const FREE_UNTIL = sql`CASE WHEN ${SEATED_LATE_FROM_LINE} THEN ev.starts_at ELSE ${DEADLINE} END`;

const PLACE_COLUMNS = sql`
  er.id, er.member_id, er.ticket_id, er.state, er.team_name, er.price_cents, er.charge_id,
  er.hold_expires_at, er.created_at,
  CASE WHEN er.state = 'waitlisted' THEN
    (SELECT count(*)::int FROM club_event_registrations w
      WHERE w.club_id = er.club_id AND w.event_id = er.event_id AND w.state = 'waitlisted'
        AND w.seq <= er.seq) END AS position,
  coalesce((SELECT cb.due_cents FROM club_charge_balances cb
             WHERE cb.charge_id = er.charge_id), 0) AS owed`;

function toPlace(row: Record<string, unknown>): EventPlace {
  return {
    id: String(row.id),
    memberId: text(row.member_id),
    memberName: text(row.member_name),
    ticketId: String(row.ticket_id),
    ticketName: String(row.ticket_name ?? ''),
    state: String(row.state) as RegistrationState,
    position: intOrNull(row.position),
    teamName: text(row.team_name),
    priceCents: Number(row.price_cents),
    chargeId: text(row.charge_id),
    owedCents: Number(row.owed ?? 0),
    holdExpiresAt: isoOrNull(row.hold_expires_at),
    createdAt: iso(row.created_at),
  };
}

export interface EventDetail extends ClubEvent {
  tickets: EventTicket[];
  /**
   * Every place and the line, for the front of house only — names are
   * members.view's, so a trainer's list is empty: decided in the statement.
   */
  places: EventPlace[];
}

export async function eventForStaff(
  actor: ClubActor,
  eventId: string,
  locale: string,
): Promise<EventDetail | null> {
  const db = getDb();
  const event = (
    await db.execute(sql`
      SELECT ${EVENT_COLUMNS(locale)}
        FROM club_events ev ${EVENT_JOINS}
       WHERE ev.id = ${eventId}::uuid AND ${clubScope(actor, 'schedule.view', 'ev')}
    `)
  ).rows[0];
  if (!event) return null;
  const [tickets, places] = await Promise.all([
    db.execute(sql`
      SELECT ${TICKET_COLUMNS(locale)}
        FROM club_event_tickets et
       WHERE et.event_id = ${eventId}::uuid AND ${clubScope(actor, 'schedule.view', 'et')}
       ORDER BY et.archived_at NULLS FIRST, et.sort_order, et.created_at
    `),
    db.execute(sql`
      SELECT ${PLACE_COLUMNS}, m.display_name AS member_name, et.name_bg AS ticket_name
        FROM club_event_registrations er
        JOIN club_event_tickets et ON et.club_id = er.club_id AND et.id = er.ticket_id
        LEFT JOIN club_members m ON m.club_id = er.club_id AND m.id = er.member_id
       WHERE er.event_id = ${eventId}::uuid AND ${clubScope(actor, 'members.view', 'er')}
       ORDER BY CASE er.state WHEN 'confirmed' THEN 0 WHEN 'held' THEN 1 WHEN 'waitlisted' THEN 2
                ELSE 3 END, er.seq
       LIMIT 2000
    `),
  ]);
  return {
    ...toEvent(event),
    tickets: tickets.rows.map(toTicket),
    places: places.rows.map(toPlace),
  };
}

export type SaveEventResult =
  | { ok: true; eventId: string; promotions: EventPromotion[] }
  | {
      ok: false;
      error:
        | 'not_allowed'
        | 'location_invalid'
        | 'resource_invalid'
        | 'resource_taken'
        | 'capacity_below_taken';
    };

/** The calendar's constraints refusing an event's court (0048 via 0053's block). */
function resourceTaken(error: unknown): boolean {
  const constraint = violatedConstraint(error);
  return (
    constraint === 'club_calendar_claims_resource_free' ||
    constraint === 'club_calendar_claims_pool_full' ||
    pgError(error)?.code === '23P01'
  );
}

/** A key naming a location or resource the club does not have (or not at that location). */
function keyRefused(error: unknown): 'location_invalid' | 'resource_invalid' | null {
  const constraint = violatedConstraint(error);
  if (constraint === 'club_events_location_fk') return 'location_invalid';
  if (constraint === 'club_events_resource_fk') return 'resource_invalid';
  return null;
}

/**
 * Create (a draft) or edit an event (events.manage). A cancelled event is not
 * edited. Lowering the capacity below the seats already taken is refused (the
 * database's rule too) — nobody is put back in line by an edit; raising it
 * moves the line at once. Moving a published event that closes a court
 * re-checks the court (0048's EXCLUDE): `resource_taken` names the clash.
 */
export async function saveEvent(
  db: TransactionalDb,
  actor: ClubActor,
  input: EventInput,
  eventId: string | null,
): Promise<SaveEventResult> {
  const provider = onlineProvider();
  try {
    return await db.transaction(async (tx) => {
      if (eventId === null) {
        const created = await tx.execute(sql`
          INSERT INTO club_events (club_id, kind, title_bg, title_en, description_bg, description_en,
                                   sport, location_id, resource_id, starts_at, ends_at,
                                   registration_opens_at, registration_closes_at, capacity,
                                   team_event, payment, cancel_deadline_hours, public, created_by)
          SELECT ${actor.clubId}::uuid, ${input.kind}, ${input.titleBg}, ${input.titleEn},
                 ${input.descriptionBg}, ${input.descriptionEn}, ${input.sport},
                 ${input.locationId}::uuid, ${input.resourceId}::uuid,
                 ${input.startsAt.toISOString()}::timestamptz, ${input.endsAt.toISOString()}::timestamptz,
                 ${input.registrationOpensAt?.toISOString() ?? null}::timestamptz,
                 ${input.registrationClosesAt?.toISOString() ?? null}::timestamptz,
                 ${input.capacity}, ${input.teamEvent}, ${input.payment},
                 ${input.cancelDeadlineHours}, ${input.public}, ${actor.userId}
           WHERE ${clubActorMay(actor, 'events.manage', { write: true })}
          RETURNING id
        `);
        const id = text(created.rows[0]?.id);
        if (!id) return { ok: false, error: 'not_allowed' } as const;
        await recordClubAudit(tx, {
          clubId: actor.clubId,
          by: { kind: 'staff', actor },
          action: 'event_saved',
          detail: { eventId: id, created: true },
        });
        return { ok: true, eventId: id, promotions: [] } as const;
      }
      if (!(await lockEvent(tx, actor.clubId, eventId))) {
        return { ok: false, error: 'not_allowed' } as const;
      }
      const updated = await tx.execute(sql`
        UPDATE club_events ev
           SET kind = ${input.kind}, title_bg = ${input.titleBg}, title_en = ${input.titleEn},
               description_bg = ${input.descriptionBg}, description_en = ${input.descriptionEn},
               sport = ${input.sport}, location_id = ${input.locationId}::uuid,
               resource_id = ${input.resourceId}::uuid,
               starts_at = ${input.startsAt.toISOString()}::timestamptz,
               ends_at = ${input.endsAt.toISOString()}::timestamptz,
               registration_opens_at = ${input.registrationOpensAt?.toISOString() ?? null}::timestamptz,
               registration_closes_at = ${input.registrationClosesAt?.toISOString() ?? null}::timestamptz,
               capacity = ${input.capacity}, team_event = ${input.teamEvent},
               payment = ${input.payment}, cancel_deadline_hours = ${input.cancelDeadlineHours},
               public = ${input.public}
         WHERE ev.id = ${eventId}::uuid AND ev.status <> 'cancelled'
           AND ${clubWriteScope(actor, 'events.manage', 'ev')}
        RETURNING ev.id
      `);
      if (updated.rows.length === 0) return { ok: false, error: 'not_allowed' } as const;
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'event_saved',
        detail: { eventId },
      });
      await releaseLapsedEventHolds(tx, actor.clubId, eventId);
      const promotions = await promoteEventWaitlist(tx, actor.clubId, eventId, provider);
      return { ok: true, eventId, promotions } as const;
    });
  } catch (error: unknown) {
    if (resourceTaken(error)) return { ok: false, error: 'resource_taken' };
    if (violatedConstraint(error) === 'club_events_capacity_taken') {
      return { ok: false, error: 'capacity_below_taken' };
    }
    const key = keyRefused(error);
    if (key) return { ok: false, error: key };
    throw error;
  }
}

export type SaveTicketResult =
  | { ok: true; promotions: EventPromotion[] }
  | { ok: false; error: 'not_allowed' | 'capacity_below_taken' | 'too_many' };

/**
 * A ticket type, new or edited (events.manage). Its price and member price
 * bind only new places — every place snapshotted its own. A capacity below
 * the seats already taken on it is refused (the database's rule); a raised
 * one moves the line.
 */
export async function saveEventTicket(
  db: TransactionalDb,
  actor: ClubActor,
  eventId: string,
  input: EventTicketInput,
  ticketId: string | null,
): Promise<SaveTicketResult> {
  const provider = onlineProvider();
  try {
    return await db.transaction(async (tx): Promise<SaveTicketResult> => {
      if (!(await lockEvent(tx, actor.clubId, eventId))) {
        return { ok: false, error: 'not_allowed' };
      }
      const event = await tx.execute(sql`
        SELECT (SELECT count(*)::int FROM club_event_tickets t
                 WHERE t.club_id = ev.club_id AND t.event_id = ev.id AND t.archived_at IS NULL) AS live
          FROM club_events ev
         WHERE ev.id = ${eventId}::uuid AND ev.status <> 'cancelled'
           AND ${clubWriteScope(actor, 'events.manage', 'ev')}
      `);
      const row = event.rows[0];
      if (!row) return { ok: false, error: 'not_allowed' };
      if (ticketId === null) {
        if (Number(row.live) >= EVENT_TICKETS_MAX) return { ok: false, error: 'too_many' };
        await tx.execute(sql`
          INSERT INTO club_event_tickets (club_id, event_id, name_bg, name_en, price_cents,
                                          member_price_cents, capacity, audience, sort_order)
          VALUES (${actor.clubId}::uuid, ${eventId}::uuid, ${input.nameBg}, ${input.nameEn},
                  ${input.priceCents}, ${input.memberPriceCents}, ${input.capacity},
                  ${input.audience}, ${input.sortOrder})
        `);
      } else {
        const updated = await tx.execute(sql`
          UPDATE club_event_tickets et
             SET name_bg = ${input.nameBg}, name_en = ${input.nameEn},
                 price_cents = ${input.priceCents}, member_price_cents = ${input.memberPriceCents},
                 capacity = ${input.capacity}, audience = ${input.audience},
                 sort_order = ${input.sortOrder}
           WHERE et.id = ${ticketId}::uuid AND et.event_id = ${eventId}::uuid
             AND et.archived_at IS NULL AND ${clubWriteScope(actor, 'events.manage', 'et')}
          RETURNING et.id
        `);
        if (updated.rows.length === 0) return { ok: false, error: 'not_allowed' };
      }
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'event_saved',
        detail: { eventId, ticket: ticketId === null ? 'created' : 'edited' },
      });
      const promotions = await promoteEventWaitlist(tx, actor.clubId, eventId, provider);
      return { ok: true, promotions };
    });
  } catch (error: unknown) {
    if (violatedConstraint(error) === 'club_events_capacity_taken') {
      return { ok: false, error: 'capacity_below_taken' };
    }
    throw error;
  }
}

/** Take a ticket off sale (events.manage): the places on it stay as they are. */
export async function archiveEventTicket(
  db: TransactionalDb,
  actor: ClubActor,
  eventId: string,
  ticketId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    if (!(await lockEvent(tx, actor.clubId, eventId))) return false;
    const archived = await tx.execute(sql`
      UPDATE club_event_tickets et SET archived_at = now()
       WHERE et.id = ${ticketId}::uuid AND et.event_id = ${eventId}::uuid
         AND et.archived_at IS NULL AND ${clubWriteScope(actor, 'events.manage', 'et')}
      RETURNING et.id
    `);
    if (archived.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'event_saved',
      detail: { eventId, ticket: 'archived' },
    });
    return true;
  });
}

/**
 * Put a draft on sale (events.manage): it needs a live ticket. Its court is
 * closed for its span from now on (0053's trigger) — `resource_taken` when a
 * booking or a class is already there.
 */
export async function publishEvent(
  db: TransactionalDb,
  actor: ClubActor,
  eventId: string,
): Promise<'ok' | 'not_allowed' | 'no_tickets' | 'resource_taken'> {
  try {
    return await db.transaction(async (tx) => {
      const published = await tx.execute(sql`
        UPDATE club_events ev SET status = 'published'
         WHERE ev.id = ${eventId}::uuid AND ev.status = 'draft' AND ev.ends_at > now()
           AND ${clubWriteScope(actor, 'events.manage', 'ev')}
           AND EXISTS (SELECT 1 FROM club_event_tickets t
                        WHERE t.club_id = ev.club_id AND t.event_id = ev.id AND t.archived_at IS NULL)
        RETURNING ev.id
      `);
      if (published.rows.length === 0) {
        const draft = await tx.execute(sql`
          SELECT 1 FROM club_events ev
           WHERE ev.id = ${eventId}::uuid AND ev.status = 'draft' AND ev.ends_at > now()
             AND ${clubScope(actor, 'events.manage', 'ev')}
        `);
        return draft.rows.length > 0 ? ('no_tickets' as const) : ('not_allowed' as const);
      }
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'event_published',
        detail: { eventId },
      });
      return 'ok' as const;
    });
  } catch (error: unknown) {
    if (resourceTaken(error)) return 'resource_taken';
    throw error;
  }
}

export type CancelEventResult =
  | {
      ok: true;
      /** Live places the club cancelled — told after the commit. */
      registrationIds: string[];
      /** Charges whose open payment pages must close (closeEventCheckouts). */
      chargeIds: string[];
      /**
       * Charges an invoice keeps alive (0050): not voided here — the credit
       * note comes first, from «Фактури».
       */
      invoiced: number;
    }
  | { ok: false };

/**
 * Cancel an event (events.manage) — final, and only before it has ended (a
 * past event is history: cancelling it would void what people paid for what
 * they had). Every live place goes with it (cancelled by the club): its
 * charge is voided — unless a live invoice keeps it (0050: the credit note
 * comes first; the office is told how many) — and money already paid is
 * listed as a refund the office owes (refundsDue). The court is free again
 * (0053's trigger). Locks the event, then the checkouts and charges, then
 * the places — the payment path's order after the event. The caller tells
 * the people, then closes their payment pages (closeEventCheckouts).
 */
export async function cancelEvent(
  db: TransactionalDb,
  actor: ClubActor,
  eventId: string,
): Promise<CancelEventResult> {
  return db.transaction(async (tx): Promise<CancelEventResult> => {
    if (!(await lockEvent(tx, actor.clubId, eventId))) return { ok: false };
    const cancelled = await tx.execute(sql`
      UPDATE club_events ev SET status = 'cancelled', cancelled_at = now()
       WHERE ev.id = ${eventId}::uuid AND ev.status <> 'cancelled' AND ev.ends_at > now()
         AND ${clubWriteScope(actor, 'events.manage', 'ev')}
      RETURNING ev.id
    `);
    if (cancelled.rows.length === 0) return { ok: false };
    const live = await tx.execute(sql`
      SELECT er.id, er.charge_id FROM club_event_registrations er
       WHERE er.club_id = ${actor.clubId}::uuid AND er.event_id = ${eventId}::uuid
         AND er.state IN ('held', 'confirmed', 'waitlisted')
    `);
    const chargeIds = live.rows
      .filter((row) => row.charge_id !== null)
      .map((row) => String(row.charge_id));
    if (chargeIds.length > 0) {
      await tx.execute(sql`
        SELECT id FROM club_checkouts
         WHERE charge_id = ANY(${sql.param(chargeIds)}::uuid[]) AND status = 'open'
         ORDER BY id FOR UPDATE
      `);
      await tx.execute(sql`
        SELECT id FROM club_charges WHERE id = ANY(${sql.param(chargeIds)}::uuid[])
         ORDER BY id FOR NO KEY UPDATE
      `);
    }
    const places = await tx.execute(sql`
      UPDATE club_event_registrations er
         SET state = 'cancelled', cancelled_at = now(), cancel_kind = 'club',
             hold_expires_at = NULL
       WHERE er.club_id = ${actor.clubId}::uuid AND er.event_id = ${eventId}::uuid
         AND er.state IN ('held', 'confirmed', 'waitlisted')
      RETURNING er.id
    `);
    let invoiced = 0;
    if (chargeIds.length > 0) {
      await tx.execute(sql`
        WITH v AS (
          UPDATE club_charges ch SET voided_at = now()
           WHERE ch.club_id = ${actor.clubId}::uuid AND ch.id = ANY(${sql.param(chargeIds)}::uuid[])
             AND ch.voided_at IS NULL
             AND NOT ${liveInvoiceFor(sql`ch.club_id`, sql`ch.id`)}
          RETURNING ch.club_id, ch.id, ch.member_id
        )
        INSERT INTO club_audit (club_id, actor_kind, actor_id, action, subject_member_id, detail)
        SELECT v.club_id, 'staff', ${actor.userId}, 'charge_voided', v.member_id,
               jsonb_build_object('chargeId', v.id::text, 'reason', 'event_cancelled')
          FROM v
      `);
      const kept = await tx.execute(sql`
        SELECT count(*)::int AS n FROM club_charges ch
         WHERE ch.club_id = ${actor.clubId}::uuid AND ch.id = ANY(${sql.param(chargeIds)}::uuid[])
           AND ch.voided_at IS NULL
      `);
      invoiced = Number(kept.rows[0]?.n ?? 0);
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'event_cancelled',
      detail: { eventId, places: places.rows.length, invoiced },
    });
    return {
      ok: true,
      registrationIds: places.rows.map((row) => String(row.id)),
      chargeIds,
      invoiced,
    };
  });
}

/**
 * Close the payment pages still open on these charges (after the commit that
 * ended their places): one query finds them, the provider is called only for
 * those.
 */
export async function closeEventCheckouts(
  clubId: string,
  chargeIds: readonly string[],
): Promise<void> {
  if (chargeIds.length === 0) return;
  const open = await getDb().execute(sql`
    SELECT DISTINCT charge_id FROM club_checkouts
     WHERE club_id = ${clubId}::uuid AND charge_id = ANY(${sql.param([...chargeIds])}::uuid[])
       AND status = 'open'
  `);
  for (const row of open.rows) await closeChargeCheckout(clubId, String(row.charge_id));
}

// ─── Registering ───────────────────────────────────────────────────────────

export type RegisterResult =
  | {
      ok: true;
      registrationId: string;
      state: 'confirmed' | 'held' | 'waitlisted';
      chargeId: string | null;
      /** Others who moved up first, in the same transaction — to be told. */
      promotions: EventPromotion[];
    }
  | {
      ok: false;
      error:
        | 'not_allowed'
        | 'closed'
        | 'audience_mismatch'
        | 'claim_first'
        | 'link_pending'
        | 'payment_unavailable'
        | 'hold_pending'
        | 'already_registered'
        | 'team_required';
    };

class Refused extends Error {
  constructor(readonly code: Exclude<RegisterResult, { ok: true }>['error']) {
    super(code);
  }
}

/**
 * Register a person for a ticket — at the desk (bookings.manage, any record
 * of the club, any time before the event ends) or by a member for their own
 * record or a child's (memberSelfScope; with no record yet, one is made as a
 * trial booking does), inside the registration window of a public event.
 *
 * Under the event lock: lapsed holds are released and the line moves FIRST,
 * so a newcomer never takes a seat somebody in line was owed; then the person
 * gets a seat if one is left — held while they pay when the event takes
 * payment online only — or joins the line. The seat trigger has the last
 * word. Online, an account holds at most one unpaid place at a club at once.
 */
export async function registerForEvent(
  db: TransactionalDb,
  by: { kind: 'staff'; actor: ClubActor } | { kind: 'member'; userId: string; clubId: string },
  eventId: string,
  request: EventRegistrationInput,
): Promise<RegisterResult> {
  const clubId = by.kind === 'staff' ? by.actor.clubId : by.clubId;
  const provider = onlineProvider();
  const takesPayments = by.kind === 'member' && (await clubTakesPayments(clubId));
  try {
    return await db.transaction(async (tx) => {
      let memberId = request.memberId;
      if (by.kind === 'member' && memberId === null) {
        const self = await ensureSelfRecord(tx, by.userId, clubId);
        if (!self.ok) throw new Refused(self.error);
        memberId = self.memberId;
      }
      if (memberId === null) throw new Refused('not_allowed');
      if (!(await lockEvent(tx, clubId, eventId))) throw new Refused('not_allowed');
      const event = (
        await tx.execute(sql`
          SELECT ev.status, ev.starts_at, ev.registration_opens_at, ev.registration_closes_at,
                 ev.team_event, ev.payment, ev.public, ev.title_bg, ev.ends_at > now() AS running,
                 to_char((ev.starts_at AT TIME ZONE 'Europe/Sofia')::date, 'YYYY-MM-DD') AS starts_on
            FROM club_events ev
           WHERE ev.club_id = ${clubId}::uuid AND ev.id = ${eventId}::uuid
        `)
      ).rows[0];
      if (!event) throw new Refused('not_allowed');
      const member = (
        await tx.execute(sql`
          SELECT m.id, m.is_minor,
                 EXISTS (SELECT 1 FROM club_membership_balances mb
                          WHERE mb.club_id = m.club_id AND mb.member_id = m.id
                            AND mb.kind <> 'trial' AND mb.cancelled_at IS NULL
                            AND mb.state <> 'exhausted'
                            AND ${String(event.starts_on)}::date BETWEEN mb.starts_on AND mb.effective_ends_on
                        ) AS holds_membership
            FROM club_members m
           WHERE m.club_id = ${clubId}::uuid AND m.id = ${memberId}::uuid AND m.archived_at IS NULL
             AND ${
               by.kind === 'staff'
                 ? clubActorMay(by.actor, 'bookings.manage', { write: true })
                 : sql`${memberSelfScope(by.userId, clubId, 'm')} AND ${clubWritableGuard(clubId)}`
             }
        `)
      ).rows[0];
      if (!member) throw new Refused('not_allowed');
      const open =
        by.kind === 'staff'
          ? event.status === 'published' && event.running === true
          : event.public === true &&
            registrationOpen(
              {
                status: String(event.status) as EventStatus,
                startsAt: new Date(iso(event.starts_at)),
                registrationOpensAt: event.registration_opens_at
                  ? new Date(iso(event.registration_opens_at))
                  : null,
                registrationClosesAt: event.registration_closes_at
                  ? new Date(iso(event.registration_closes_at))
                  : null,
              },
              new Date(),
            );
      if (!open) throw new Refused('closed');
      // Whether a team name is asked is the event's, never the form's.
      const teamName = event.team_event === true ? request.teamName : null;
      if (event.team_event === true && !teamName) throw new Refused('team_required');
      const ticket = (
        await tx.execute(sql`
          SELECT t.id, t.name_bg, t.price_cents, t.member_price_cents, t.audience
            FROM club_event_tickets t
           WHERE t.club_id = ${clubId}::uuid AND t.event_id = ${eventId}::uuid
             AND t.id = ${request.ticketId}::uuid AND t.archived_at IS NULL
        `)
      ).rows[0];
      if (!ticket) throw new Refused('not_allowed');
      if (!audienceFits(String(ticket.audience) as ClubPlanAudience, member.is_minor === true)) {
        throw new Refused('audience_mismatch');
      }
      const price = ticketPrice(
        {
          priceCents: Number(ticket.price_cents),
          memberPriceCents: intOrNull(ticket.member_price_cents),
        },
        member.holds_membership === true,
      );
      const paysOnline =
        by.kind === 'member' && event.payment === 'online_required' && price >= MIN_ONLINE_CENTS;
      if (by.kind === 'member') {
        if (paysOnline && !takesPayments) throw new Refused('payment_unavailable');
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`club_event_holds:${clubId}:${by.userId}`}, 0))`,
        );
        const holds = await tx.execute(sql`
          SELECT count(*)::int AS n
            FROM club_event_registrations er
            JOIN club_members m ON m.club_id = er.club_id AND m.id = er.member_id
           WHERE er.club_id = ${clubId}::uuid AND er.state = 'held' AND er.hold_expires_at > now()
             AND ${memberSelfScope(by.userId, clubId, 'm')}
        `);
        if (paysOnline && Number(holds.rows[0]?.n ?? 0) >= 1) throw new Refused('hold_pending');
      }
      // The line first: a lapsed hold frees its seat, and whoever waits gets it.
      await releaseLapsedEventHolds(tx, clubId, eventId);
      const promotions = await promoteEventWaitlist(tx, clubId, eventId, provider);
      const room = (
        await tx.execute(sql`
          SELECT (ev.capacity IS NULL OR
                   (SELECT count(*) FROM club_event_registrations er
                     WHERE er.club_id = ev.club_id AND er.event_id = ev.id
                       AND er.state IN ('held', 'confirmed')) < ev.capacity)
             AND (t.capacity IS NULL OR
                   (SELECT count(*) FROM club_event_registrations er
                     WHERE er.club_id = t.club_id AND er.ticket_id = t.id
                       AND er.state IN ('held', 'confirmed')) < t.capacity)
             -- The line first, until the start (the seat trigger's own rule);
             -- once it has started, the line is frozen and the desk seats.
             AND (ev.starts_at <= now() OR NOT EXISTS (
                   SELECT 1 FROM club_event_registrations w
                    WHERE w.club_id = t.club_id AND w.ticket_id = t.id
                      AND w.state = 'waitlisted' AND w.member_id IS NOT NULL
                      AND EXISTS (SELECT 1 FROM club_members wm
                                   WHERE wm.club_id = w.club_id AND wm.id = w.member_id
                                     AND wm.archived_at IS NULL))) AS free
            FROM club_events ev
            JOIN club_event_tickets t ON t.club_id = ev.club_id AND t.event_id = ev.id
           WHERE ev.club_id = ${clubId}::uuid AND ev.id = ${eventId}::uuid
             AND t.id = ${request.ticketId}::uuid
        `)
      ).rows[0];
      const seat = room?.free === true;
      const held = seat && paysOnline;
      let chargeId: string | null = null;
      if (seat && price > 0) {
        const charge = await tx.execute(sql`
          INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on,
                                    created_by)
          VALUES (${clubId}::uuid, ${memberId}::uuid, 'event',
                  ${`${String(event.title_bg)} · ${String(ticket.name_bg)}`.slice(0, 120)}, ${price},
                  (now() AT TIME ZONE 'Europe/Sofia')::date,
                  greatest((now() AT TIME ZONE 'Europe/Sofia')::date, ${String(event.starts_on)}::date),
                  ${by.kind === 'staff' ? by.actor.userId : null})
          RETURNING id
        `);
        chargeId = text(charge.rows[0]?.id);
      }
      const state = !seat ? 'waitlisted' : held ? 'held' : 'confirmed';
      const created = await tx.execute(sql`
        INSERT INTO club_event_registrations (club_id, event_id, ticket_id, member_id, state,
                                              hold_expires_at, price_cents, cancel_deadline_hours,
                                              charge_id, team_name, booked_by)
        SELECT ${clubId}::uuid, ${eventId}::uuid, ${request.ticketId}::uuid, ${memberId}::uuid,
               ${state},
               ${held ? sql`now() + make_interval(mins => ${EVENT_HOLD_MINUTES}::int)` : sql`NULL`},
               ${price}, ev.cancel_deadline_hours, ${chargeId}::uuid, ${teamName},
               ${by.kind === 'staff' ? by.actor.userId : null}
          FROM club_events ev
         WHERE ev.club_id = ${clubId}::uuid AND ev.id = ${eventId}::uuid
        RETURNING id
      `);
      const registrationId = String(created.rows[0]?.id);
      await recordClubAudit(tx, {
        clubId,
        by:
          by.kind === 'staff'
            ? { kind: 'staff', actor: by.actor }
            : { kind: 'member', userId: by.userId },
        action: 'event_registered',
        subjectMemberId: memberId,
        detail: { eventId, registrationId, state, priceCents: price },
      });
      return { ok: true, registrationId, state, chargeId, promotions } as const;
    });
  } catch (error: unknown) {
    if (error instanceof Refused) return { ok: false, error: error.code };
    if (violatedConstraint(error) === 'club_event_registrations_one_live') {
      return { ok: false, error: 'already_registered' };
    }
    throw error;
  }
}

export type CancelPlaceResult =
  | {
      ok: true;
      late: boolean;
      refundDue: boolean;
      /** A live invoice kept the charge (0050): the office issues the credit note. */
      invoiceLive: boolean;
      /** Who moved up into the freed seat — to be told. */
      promotions: EventPromotion[];
    }
  | { ok: false };

/**
 * Give a place up — the member for their own record or a child's before the
 * event starts, the desk (bookings.manage) for anybody's before it ends. Only
 * a member giving up a CONFIRMED seat after its snapshotted deadline is LATE:
 * the charge stays. Otherwise the charge is voided; money paid stays as a
 * refund the office owes (refundsDue). A seat freed goes to the line at once.
 * A payment page still open closes after the commit.
 */
export async function cancelEventPlace(
  db: TransactionalDb,
  by: { kind: 'staff'; actor: ClubActor } | { kind: 'member'; userId: string; clubId: string },
  registrationId: string,
): Promise<CancelPlaceResult> {
  const clubId = by.kind === 'staff' ? by.actor.clubId : by.clubId;
  const provider = onlineProvider();
  const done = await db.transaction(
    async (tx): Promise<{ result: CancelPlaceResult; chargeId: string | null }> => {
      const refused = { result: { ok: false } as const, chargeId: null };
      const live = sql`
        SELECT er.event_id, er.charge_id FROM club_event_registrations er
          JOIN club_events ev ON ev.club_id = er.club_id AND ev.id = er.event_id
         WHERE er.id = ${registrationId}::uuid AND er.club_id = ${clubId}::uuid
           AND er.state IN ('held', 'confirmed', 'waitlisted') AND ${
             by.kind === 'staff'
               ? sql`${clubWriteScope(by.actor, 'bookings.manage', 'er')} AND ev.ends_at > now()`
               : sql`EXISTS (SELECT 1 FROM club_members m
                              WHERE m.club_id = er.club_id AND m.id = er.member_id
                                AND ${memberSelfScope(by.userId, clubId, 'm')})
                     AND ${clubWritableGuard(clubId)} AND ev.starts_at > now()`
           }`;
      const found = (await tx.execute(live)).rows[0];
      if (!found) return refused;
      const eventId = String(found.event_id);
      await lockEvent(tx, clubId, eventId);
      // Re-read under the event lock: only a path holding it changes a place's
      // state or charge (a payment confirms, it never re-charges).
      const locked = (await tx.execute(live)).rows[0];
      if (!locked) return refused;
      const chargeId = text(locked.charge_id);
      if (chargeId !== null) {
        await tx.execute(sql`
          SELECT id FROM club_checkouts WHERE charge_id = ${chargeId}::uuid AND status = 'open'
             FOR UPDATE
        `);
        await tx.execute(sql`
          SELECT ch.id FROM club_charges ch
           WHERE ch.club_id = ${clubId}::uuid AND ch.id = ${chargeId}::uuid
             FOR NO KEY UPDATE
        `);
      }
      const updated = await tx.execute(sql`
        UPDATE club_event_registrations er
           SET state = CASE WHEN ${by.kind === 'member'} AND er.state = 'confirmed'
                             AND ${LATE_NOW}
                            THEN 'late_cancelled' ELSE 'cancelled' END,
               cancelled_at = now(), cancel_kind = ${by.kind === 'member' ? 'member' : 'staff'},
               hold_expires_at = NULL
          FROM club_events ev
         WHERE er.id = ${registrationId}::uuid AND er.club_id = ${clubId}::uuid
           AND ev.club_id = er.club_id AND ev.id = er.event_id
           AND er.state IN ('held', 'confirmed', 'waitlisted') AND ${
             by.kind === 'staff'
               ? sql`${clubWriteScope(by.actor, 'bookings.manage', 'er')} AND ev.ends_at > now()`
               : sql`EXISTS (SELECT 1 FROM club_members m
                              WHERE m.club_id = er.club_id AND m.id = er.member_id
                                AND ${memberSelfScope(by.userId, clubId, 'm')})
                     AND ${clubWritableGuard(clubId)} AND ev.starts_at > now()`
           }
        RETURNING er.state, er.member_id
      `);
      const row = updated.rows[0];
      if (!row) return refused;
      const late = row.state === 'late_cancelled';
      const memberId = text(row.member_id);
      const auditBy =
        by.kind === 'staff'
          ? ({ kind: 'staff', actor: by.actor } as const)
          : ({ kind: 'member', userId: by.userId } as const);
      let refundDue = false;
      let invoiceLive = false;
      if (!late && chargeId !== null) {
        // Voided even when paid (the reservations' rule): nothing more is owed
        // for a place that no longer exists, and what was paid is a refund —
        // unless a live invoice keeps the charge (0050): the credit note first.
        const voided = await tx.execute(sql`
          UPDATE club_charges ch SET voided_at = now()
           WHERE ch.club_id = ${clubId}::uuid AND ch.id = ${chargeId}::uuid
             AND ch.voided_at IS NULL AND NOT ${liveInvoiceFor(sql`ch.club_id`, sql`ch.id`)}
          RETURNING ch.id
        `);
        if (!voided.rows[0]) {
          const live = await tx.execute(sql`
            SELECT 1 FROM club_charges ch
             WHERE ch.club_id = ${clubId}::uuid AND ch.id = ${chargeId}::uuid
               AND ch.voided_at IS NULL
          `);
          invoiceLive = live.rows.length > 0;
        }
        if (voided.rows[0]) {
          await recordClubAudit(tx, {
            clubId,
            by: auditBy,
            action: 'charge_voided',
            subjectMemberId: memberId,
            detail: { chargeId, reason: 'event_place_cancelled' },
          });
        }
        const paid = await tx.execute(sql`
          SELECT coalesce(sum(pp.amount_cents), 0)::int AS net FROM club_payments pp
           WHERE pp.club_id = ${clubId}::uuid AND pp.charge_id = ${chargeId}::uuid
        `);
        refundDue = Number(paid.rows[0]?.net ?? 0) > 0;
      }
      await recordClubAudit(tx, {
        clubId,
        by: auditBy,
        action: 'event_registration_cancelled',
        subjectMemberId: memberId,
        detail: { eventId, registrationId, late, refundDue },
      });
      const promotions = await promoteEventWaitlist(tx, clubId, eventId, provider);
      return {
        result: { ok: true, late, refundDue, invoiceLive, promotions } as const,
        chargeId,
      };
    },
  );
  if (done.result.ok && !done.result.late && done.chargeId !== null) {
    await closeChargeCheckout(clubId, done.chargeId);
  }
  return done.result;
}

// ─── The member and the public ──────────────────────────────────────────────

export interface MemberEventPlace extends EventPlace {
  eventId: string;
  eventTitle: string;
  startsAt: string;
  endsAt: string;
  locationName: string;
  /** Until when giving a confirmed place up costs nothing. */
  freeCancelUntil: string;
}

/** The account's own (and its children's) places at events still to come — the portal. */
export async function memberEventPlaces(
  userId: string,
  clubId: string,
  locale: string,
  eventId: string | null = null,
): Promise<MemberEventPlace[]> {
  const result = await getDb().execute(sql`
    SELECT ${PLACE_COLUMNS}, m.display_name AS member_name,
           CASE WHEN ${locale} = 'en' THEN coalesce(et.name_en, et.name_bg) ELSE et.name_bg END AS ticket_name,
           ev.id AS event_id,
           CASE WHEN ${locale} = 'en' THEN coalesce(ev.title_en, ev.title_bg) ELSE ev.title_bg END AS event_title,
           ev.starts_at, ev.ends_at, l.name AS location_name,
           ${FREE_UNTIL} AS free_until
      FROM club_event_registrations er
      JOIN club_members m ON m.club_id = er.club_id AND m.id = er.member_id
      JOIN club_events ev ON ev.club_id = er.club_id AND ev.id = er.event_id
      JOIN club_event_tickets et ON et.club_id = er.club_id AND et.id = er.ticket_id
      JOIN club_locations l ON l.club_id = ev.club_id AND l.id = ev.location_id
     WHERE ${memberSelfScope(userId, clubId, 'm')}
       AND er.state IN ('held', 'confirmed', 'waitlisted') AND ev.ends_at > now()
       ${eventId === null ? sql`` : sql`AND ev.id = ${eventId}::uuid`}
     ORDER BY ev.starts_at, er.seq
     LIMIT 50
  `);
  return result.rows.map((row) => ({
    ...toPlace(row),
    eventId: String(row.event_id),
    eventTitle: String(row.event_title),
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    locationName: String(row.location_name),
    freeCancelUntil: iso(row.free_until),
  }));
}

/** A club's published, public events still to come — the club page. */
export async function publicEvents(
  clubId: string,
  locale: string,
  limit = 20,
): Promise<(ClubEvent & { fromCents: number | null })[]> {
  const result = await getDb().execute(sql`
    SELECT ${EVENT_COLUMNS(locale)},
           (SELECT min(t.price_cents) FROM club_event_tickets t
             WHERE t.club_id = ev.club_id AND t.event_id = ev.id AND t.archived_at IS NULL) AS from_cents
      FROM club_events ev ${EVENT_JOINS}
      JOIN clubs c ON c.id = ev.club_id
     WHERE ev.club_id = ${clubId}::uuid AND ${clubRenderableSql('c')}
       AND ev.status = 'published' AND ev.public AND ev.ends_at > now()
     ORDER BY ev.starts_at
     LIMIT ${Math.min(Math.max(limit, 1), 50)}
  `);
  return result.rows.map((row) => ({ ...toEvent(row), fromCents: intOrNull(row.from_cents) }));
}

export interface PublicEventTicket extends EventTicket {
  /** Seats left on this ticket within the event's own; null when unlimited. */
  seatsLeft: number | null;
}

export interface PublicEvent extends ClubEvent {
  tickets: PublicEventTicket[];
  /** Registration is open now for a member (the window, published). */
  open: boolean;
}

/**
 * One event for its public page: published and public (a cancelled one too,
 * so a shared link says what happened), on a club that is shown — or not
 * public, for a viewer who holds a place there (the desk registered them), so
 * they can see it, pay and give it up. The live tickets with the seats left —
 * never who took them.
 */
export async function publicEvent(
  clubId: string,
  eventId: string,
  locale: string,
  options: { viewerHasPlace?: boolean } = {},
): Promise<PublicEvent | null> {
  const db = getDb();
  const row = (
    await db.execute(sql`
      SELECT ${EVENT_COLUMNS(locale)}
        FROM club_events ev ${EVENT_JOINS}
        JOIN clubs c ON c.id = ev.club_id
       WHERE ev.club_id = ${clubId}::uuid AND ev.id = ${eventId}::uuid AND ${clubRenderableSql('c')}
         AND (ev.public OR ${options.viewerHasPlace === true})
         AND ev.status IN ('published', 'cancelled')
    `)
  ).rows[0];
  if (!row) return null;
  const event = toEvent(row);
  const tickets = await db.execute(sql`
    SELECT ${TICKET_COLUMNS(locale)}
      FROM club_event_tickets et
     WHERE et.club_id = ${clubId}::uuid AND et.event_id = ${eventId}::uuid
       AND et.archived_at IS NULL
     ORDER BY et.sort_order, et.created_at
  `);
  const eventLeft = event.capacity === null ? null : Math.max(0, event.capacity - event.taken);
  return {
    ...event,
    tickets: tickets.rows.map((t) => {
      const ticket = toTicket(t);
      const ticketLeft =
        ticket.capacity === null ? null : Math.max(0, ticket.capacity - ticket.taken);
      const seatsLeft =
        eventLeft === null
          ? ticketLeft
          : ticketLeft === null
            ? eventLeft
            : Math.min(eventLeft, ticketLeft);
      return { ...ticket, seatsLeft };
    }),
    // Open to registration only when public: a private event opened for a
    // place holder (viewerHasPlace) shows their place, never a form.
    open:
      event.public &&
      registrationOpen(
        {
          status: event.status,
          startsAt: new Date(event.startsAt),
          registrationOpensAt: event.registrationOpensAt
            ? new Date(event.registrationOpensAt)
            : null,
          registrationClosesAt: event.registrationClosesAt
            ? new Date(event.registrationClosesAt)
            : null,
        },
        new Date(),
      ),
  };
}

/**
 * A public event for its `.ics` (0053): published or cancelled (a calendar
 * that holds it must learn of the cancellation), public, on a club that is
 * shown. Nothing the event page does not show.
 */
export async function eventForCalendar(eventId: string): Promise<{
  id: string;
  title: string;
  clubSlug: string;
  locationName: string;
  startsAt: string;
  endsAt: string;
  cancelled: boolean;
} | null> {
  const row = (
    await getDb().execute(sql`
      SELECT ev.id, ev.title_bg, c.slug, l.name AS location_name, ev.starts_at, ev.ends_at,
             ev.status = 'cancelled' AS cancelled
        FROM club_events ev
        JOIN clubs c ON c.id = ev.club_id
        JOIN club_locations l ON l.club_id = ev.club_id AND l.id = ev.location_id
       WHERE ev.id = ${eventId}::uuid AND ${clubRenderableSql('c')}
         AND ev.public AND ev.status IN ('published', 'cancelled')
    `)
  ).rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    title: String(row.title_bg),
    clubSlug: String(row.slug),
    locationName: String(row.location_name),
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    cancelled: row.cancelled === true,
  };
}
