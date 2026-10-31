import {
  EVENT_OFFER_HOURS,
  EVENT_OFFER_MIN_MINUTES,
  MIN_ONLINE_CENTS,
} from '@sportkarta/lib/clubs';
import { sql, type SQL } from 'drizzle-orm';

import { chargeIdsOf, HOLD_GRACE_MINUTES, lockHoldCharges, voidHeldCharges } from './payments.js';

/**
 * Event places (0053): what frees a seat and what fills one, shared by the
 * web app (on the path that needs the seat — a registration, a cancellation)
 * and the worker's sweep.
 *
 * LOCK ORDER, everywhere: the EVENT row (FOR NO KEY UPDATE — the seat
 * trigger's own lock) → the open checkouts → the charges → the registrations.
 * A payment confirming a hold takes checkout → charge → registration and
 * never the event, so it cannot close a cycle with any of these.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/** The provider POPS takes payments through right now; null when it takes none. */
export type OnlineProvider = 'stripe' | 'fake' | null;

export interface EventPromotion {
  clubId: string;
  eventId: string;
  registrationId: string;
  /** confirmed: the seat is theirs; held: offered, to be paid by the hold's end. */
  state: 'confirmed' | 'held';
}

/** Lock an event row — the first lock of every path that gives or frees a seat. */
export async function lockEvent(tx: SqlRunner, clubId: string, eventId: string): Promise<boolean> {
  const row = await tx.execute(sql`
    SELECT 1 FROM club_events WHERE club_id = ${clubId}::uuid AND id = ${eventId}::uuid
       FOR NO KEY UPDATE
  `);
  return row.rows.length > 0;
}

/**
 * Release this event's lapsed holds — a registration's and a waitlist offer's
 * alike — the court holds' rule (releaseLapsedHolds): the place expires, its
 * charge is voided and its open checkout closed, in the caller's transaction,
 * after the caller locked the event. A payment that won the race confirmed
 * its place first and is no longer released; one that loses finds a void
 * charge and is recorded as unapplied for the office to refund. A place with
 * any money on its charge is never released.
 */
export async function releaseLapsedEventHolds(
  tx: SqlRunner,
  clubId: string,
  eventId: string,
): Promise<number> {
  const lapsed = sql`h.club_id = ${clubId}::uuid AND h.event_id = ${eventId}::uuid
    AND h.state = 'held'
    AND h.hold_expires_at < now() - make_interval(mins => ${HOLD_GRACE_MINUTES}::int)`;
  const candidates = (
    await tx.execute(sql`SELECT h.id, h.charge_id FROM club_event_registrations h WHERE ${lapsed}`)
  ).rows;
  if (candidates.length === 0) return 0;
  const ids = candidates.map((row) => String(row.id));
  await lockHoldCharges(tx, chargeIdsOf(candidates));
  await tx.execute(sql`
    SELECT id FROM club_event_registrations WHERE id = ANY(${sql.param(ids)}::uuid[])
     ORDER BY id FOR UPDATE
  `);
  const released = await tx.execute(sql`
    UPDATE club_event_registrations h
       SET state = 'expired', hold_expires_at = NULL, updated_at = now()
     WHERE h.id = ANY(${sql.param(ids)}::uuid[]) AND ${lapsed}
       AND NOT EXISTS (SELECT 1 FROM club_payments pp WHERE pp.charge_id = h.charge_id)
    RETURNING h.charge_id
  `);
  await voidHeldCharges(tx, chargeIdsOf(released.rows));
  return released.rows.length;
}

/**
 * Fill freed seats from the waitlist, in arrival order, after the caller
 * locked the event (and released its lapsed holds). Only a published event
 * that has not started moves its line (once it has, the desk seats whom it
 * sees). A person whose ticket is full stays in line while somebody behind
 * them on another ticket may go ahead; an erased or archived client's place
 * is never promoted.
 *
 * A place is OFFERED — held with its charge until it is paid from the portal
 * — only when it can be paid online: a priced place (at least
 * MIN_ONLINE_CENTS) at an event that takes payment online only, a club that
 * takes payments now (`provider`, and its live account), a person who can
 * open the portal (the record, or its guardian's, linked), and time to pay:
 * the offer lasts EVENT_OFFER_HOURS, never past the start, and none is made
 * with less than EVENT_OFFER_MIN_MINUTES left (the provider's floor).
 * Otherwise the place is CONFIRMED, its charge (if priced) owed at the desk —
 * and a seat given after the free-cancel deadline can still be given up free
 * (the seat time is recorded by the database).
 *
 * Returns who moved, for the notices the caller sends after the commit.
 */
export async function promoteEventWaitlist(
  tx: SqlRunner,
  clubId: string,
  eventId: string,
  provider: OnlineProvider,
): Promise<EventPromotion[]> {
  const event = (
    await tx.execute(sql`
      SELECT e.status, e.capacity, e.payment, e.title_bg, e.starts_at > now() AS upcoming,
             e.starts_at > now() + make_interval(mins => ${EVENT_OFFER_MIN_MINUTES}::int) AS time_to_pay,
             to_char((e.starts_at AT TIME ZONE 'Europe/Sofia')::date, 'YYYY-MM-DD') AS starts_on,
             (SELECT count(*)::int FROM club_event_registrations r
               WHERE r.club_id = e.club_id AND r.event_id = e.id
                 AND r.state IN ('held', 'confirmed')) AS taken,
             ${
               provider === null
                 ? sql`false`
                 : sql`EXISTS (SELECT 1 FROM club_payment_accounts pa
                                WHERE pa.club_id = e.club_id AND pa.disconnected_at IS NULL
                                  AND pa.charges_enabled AND pa.provider = ${provider})`
             } AS online
        FROM club_events e
       WHERE e.club_id = ${clubId}::uuid AND e.id = ${eventId}::uuid
         FOR NO KEY UPDATE
    `)
  ).rows[0];
  if (!event || event.status !== 'published' || event.upcoming !== true) return [];
  let free =
    event.capacity === null || event.capacity === undefined
      ? Number.POSITIVE_INFINITY
      : Number(event.capacity) - Number(event.taken);
  if (free <= 0) return [];
  const waiting = await tx.execute(sql`
    SELECT r.id, r.member_id, r.ticket_id, r.price_cents, t.name_bg, t.capacity AS ticket_capacity,
           (SELECT count(*)::int FROM club_event_registrations s
             WHERE s.club_id = r.club_id AND s.ticket_id = r.ticket_id
               AND s.state IN ('held', 'confirmed')) AS ticket_taken,
           (EXISTS (SELECT 1 FROM club_member_links ml
                     WHERE ml.member_id = m.id AND ml.status = 'active')
            OR EXISTS (SELECT 1 FROM club_member_links gl
                        WHERE gl.member_id = m.guardian_member_id AND gl.status = 'active')) AS reachable
      FROM club_event_registrations r
      JOIN club_event_tickets t ON t.club_id = r.club_id AND t.id = r.ticket_id
      JOIN club_members m ON m.club_id = r.club_id AND m.id = r.member_id
     WHERE r.club_id = ${clubId}::uuid AND r.event_id = ${eventId}::uuid
       AND r.state = 'waitlisted' AND m.archived_at IS NULL
     ORDER BY r.seq
       FOR UPDATE OF r
  `);
  const offersOnline =
    event.payment === 'online_required' && event.online === true && event.time_to_pay === true;
  const ticketTaken = new Map<string, number>();
  const promoted: EventPromotion[] = [];
  for (const row of waiting.rows) {
    if (free <= 0) break;
    const ticketId = String(row.ticket_id);
    const taken = ticketTaken.get(ticketId) ?? Number(row.ticket_taken);
    const ticketCapacity =
      row.ticket_capacity === null || row.ticket_capacity === undefined
        ? null
        : Number(row.ticket_capacity);
    if (ticketCapacity !== null && taken >= ticketCapacity) continue;
    const registrationId = String(row.id);
    const price = Number(row.price_cents);
    let chargeId: string | null = null;
    if (price > 0) {
      const charge = await tx.execute(sql`
        INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on)
        VALUES (${clubId}::uuid, ${String(row.member_id)}::uuid, 'event',
                ${`${String(event.title_bg)} · ${String(row.name_bg)}`.slice(0, 120)}, ${price},
                (now() AT TIME ZONE 'Europe/Sofia')::date,
                greatest((now() AT TIME ZONE 'Europe/Sofia')::date, ${String(event.starts_on)}::date))
        RETURNING id
      `);
      chargeId = String(charge.rows[0]?.id);
    }
    const held = offersOnline && price >= MIN_ONLINE_CENTS && row.reachable === true;
    await tx.execute(sql`
      UPDATE club_event_registrations r
         SET state = ${held ? 'held' : 'confirmed'},
             hold_expires_at = ${
               held
                 ? sql`(SELECT least(now() + make_interval(hours => ${EVENT_OFFER_HOURS}::int), e.starts_at)
                          FROM club_events e WHERE e.club_id = r.club_id AND e.id = r.event_id)`
                 : sql`NULL`
             },
             charge_id = ${chargeId}::uuid, updated_at = now()
       WHERE r.club_id = ${clubId}::uuid AND r.id = ${registrationId}::uuid
    `);
    await tx.execute(sql`
      INSERT INTO club_audit (club_id, actor_kind, actor_id, action, subject_member_id, detail)
      VALUES (${clubId}::uuid, 'system', NULL, 'event_registered', ${String(row.member_id)}::uuid,
              jsonb_build_object('eventId', ${eventId}::text, 'registrationId', ${registrationId}::text,
                                 'promoted', true))
    `);
    promoted.push({ clubId, eventId, registrationId, state: held ? 'held' : 'confirmed' });
    ticketTaken.set(ticketId, taken + 1);
    free -= 1;
  }
  return promoted;
}

/**
 * The worker's sweep: every event with a lapsed hold, one transaction each —
 * the hold released, then the line moved into the freed seat. An event that
 * fails is left for the next sweep, and never takes the committed promotions
 * of the others with it (they are returned, to be told).
 */
export async function expireEventHolds(
  db: TransactionalDb,
  provider: OnlineProvider,
): Promise<EventPromotion[]> {
  const lapsed = await db.execute(sql`
    SELECT DISTINCT h.club_id, h.event_id FROM club_event_registrations h
     WHERE h.state = 'held'
       AND h.hold_expires_at < now() - make_interval(mins => ${HOLD_GRACE_MINUTES}::int)
     ORDER BY h.club_id, h.event_id
     LIMIT 500
  `);
  const promoted: EventPromotion[] = [];
  for (const row of lapsed.rows) {
    const clubId = String(row.club_id);
    const eventId = String(row.event_id);
    try {
      promoted.push(
        ...(await db.transaction(async (tx) => {
          if (!(await lockEvent(tx, clubId, eventId))) return [];
          if ((await releaseLapsedEventHolds(tx, clubId, eventId)) === 0) return [];
          return promoteEventWaitlist(tx, clubId, eventId, provider);
        })),
      );
    } catch (error: unknown) {
      // The event's id and the error's name only — never a person.
      console.warn(
        `[clubs] event holds sweep: event ${eventId} left for the next run (${
          error instanceof Error ? error.name : 'error'
        })`,
      );
    }
  }
  return promoted;
}

/** One event place as its notice needs it (the worker's club.notify). */
export interface ClubEventPlaceMail {
  registrationId: string;
  clubId: string;
  memberId: string;
  state: string;
  cancelKind: string | null;
  eventStatus: string;
  /** In the club's language: the notice goes out in the recipient's, the name stays the club's. */
  title: string;
  ticketName: string;
  /** Sofia wall clock `YYYY-MM-DDTHH:MM:SS`. */
  startsAtLocal: string;
  locationName: string;
  /** Sofia wall clock of a held place's end; null when not held. */
  holdEndsLocal: string | null;
  /** Place in line, waitlisted only. */
  position: number | null;
  /** A held place's hold has not run out yet. */
  holdLive: boolean;
}

/** The places behind a notice. An erased client's place has nobody to tell. */
export async function eventPlacesForMail(
  db: SqlRunner,
  registrationIds: string[],
): Promise<ClubEventPlaceMail[]> {
  if (registrationIds.length === 0) return [];
  const local = (column: SQL) =>
    sql`to_char(${column} AT TIME ZONE 'Europe/Sofia', 'YYYY-MM-DD"T"HH24:MI:SS')`;
  const result = await db.execute(sql`
    SELECT r.id, r.club_id, r.member_id, r.state, r.cancel_kind, ev.status AS event_status,
           CASE WHEN c.locale = 'en' THEN coalesce(ev.title_en, ev.title_bg) ELSE ev.title_bg END AS title,
           CASE WHEN c.locale = 'en' THEN coalesce(t.name_en, t.name_bg) ELSE t.name_bg END AS ticket,
           ${local(sql`ev.starts_at`)} AS starts_local, l.name AS location_name,
           CASE WHEN r.state = 'held' THEN ${local(sql`r.hold_expires_at`)} END AS hold_local,
           (r.state = 'held' AND r.hold_expires_at > now()) AS hold_live,
           CASE WHEN r.state = 'waitlisted' THEN
             (SELECT count(*)::int FROM club_event_registrations w
               WHERE w.club_id = r.club_id AND w.event_id = r.event_id AND w.state = 'waitlisted'
                 AND w.seq <= r.seq) END AS position
      FROM club_event_registrations r
      JOIN club_events ev ON ev.club_id = r.club_id AND ev.id = r.event_id
      JOIN club_event_tickets t ON t.club_id = r.club_id AND t.id = r.ticket_id
      JOIN club_locations l ON l.club_id = ev.club_id AND l.id = ev.location_id
      JOIN clubs c ON c.id = r.club_id
     WHERE r.id = ANY(${sql.param(registrationIds)}::uuid[]) AND r.member_id IS NOT NULL
     ORDER BY ev.starts_at, r.seq
  `);
  return result.rows.map((row) => ({
    registrationId: String(row.id),
    clubId: String(row.club_id),
    memberId: String(row.member_id),
    state: String(row.state),
    cancelKind: row.cancel_kind === null ? null : String(row.cancel_kind),
    eventStatus: String(row.event_status),
    title: String(row.title),
    ticketName: String(row.ticket),
    startsAtLocal: String(row.starts_local),
    locationName: String(row.location_name),
    holdEndsLocal: row.hold_local === null ? null : String(row.hold_local),
    position: row.position === null || row.position === undefined ? null : Number(row.position),
    holdLive: row.hold_live === true,
  }));
}
