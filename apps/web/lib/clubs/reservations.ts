import { HOLD_GRACE_MINUTES, getDb, releaseLapsedHolds, sql, type SQL } from '@sportkarta/db';
import {
  addDaysIso,
  availableSlots,
  isIsoDate,
  parseClock,
  parseClosing,
  priceFor,
  saturatedIntervals,
  serviceDurations,
  sofiaToday,
  type BusyInterval,
  type IsoDate,
  type OpeningHours,
  type PriceRule,
  type Slot,
} from '@sportkarta/lib/clubs';
import { SOFIA_TZ, zonedToDate } from '@sportkarta/lib/recurrence';

import { clubWritableGuard } from './access';
import { recordClubAudit } from './audit';
import { ensureSelfRecord } from './bookings';
import { pgError, violatedConstraint } from './errors';
import { MAX_BOOKING_WINDOW_DAYS, type ReservationRequest } from './input';
import { MIN_ONLINE_CENTS, closeChargeCheckout, clubTakesPayments } from './payments';
import { clubActorMay, clubScope, clubWriteScope, memberSelfScope, type ClubActor } from './scope';
import { SERVICE_COLUMNS, toPriceRule, toService, type ClubService } from './services';

/**
 * Booking courts, rooms and trainers (0048, wave C).
 *
 * AVAILABILITY is computed here from the calendar's own data — the location's
 * opening hours, a trainer's appointment hours, every claim on the day (class
 * occurrences, reservations with their buffers, blocks), the classes a trainer
 * teaches — through the pure slot engine, and priced through the pure price
 * table. BOOKING recomputes that availability on the server and inserts; the
 * calendar's EXCLUDE constraints are the last word, so two people taking the
 * same court at once get one booking and one `slot_taken`, never two.
 *
 * Money follows the club's books: a priced booking raises an ordinary charge
 * (kind `reservation`, due on the day) the member pays at the desk or online
 * from the portal (wave E). A service that REQUIRES payment online holds the
 * slot for HOLD_MINUTES while the member pays; the paid charge confirms it
 * (db/src/clubs/payments.ts), an unpaid hold is released by the worker.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/**
 * How long a slot waits for an online payment. Stripe's shortest Checkout
 * session is 30 minutes from its creation; the session is set to expire with
 * the hold, so the hold leaves a margin over that floor.
 */
export const HOLD_MINUTES = 35;

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

/** ISO weekday of a civil date (1 = Monday). */
export function isoWeekdayOf(date: IsoDate): number {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

function dayStart(date: IsoDate): Date {
  const [year, month, day] = date.split('-').map(Number);
  return zonedToDate(
    { year: year ?? 0, month: month ?? 1, day: day ?? 1, hour: 0, minute: 0 },
    SOFIA_TZ,
  );
}

function overlap(a: OpeningHours, b: OpeningHours): OpeningHours | null {
  const opens = Math.max(parseClock(a.opens) ?? 0, parseClock(b.opens) ?? 0);
  const closes = Math.min(parseClosing(a.closes) ?? 0, parseClosing(b.closes) ?? 0);
  if (closes <= opens) return null;
  const clock = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { opens: clock(opens), closes: clock(closes) };
}

interface BookableService extends ClubService {
  resources: { id: string; quantity: number }[];
  rules: PriceRule[];
}

async function loadService(
  db: SqlRunner,
  clubId: string,
  serviceId: string,
): Promise<BookableService | null> {
  const row = (
    await db.execute(sql`
      SELECT ${SERVICE_COLUMNS} FROM club_services sv
       WHERE sv.club_id = ${clubId}::uuid AND sv.id = ${serviceId}::uuid AND sv.archived_at IS NULL
    `)
  ).rows[0];
  if (!row) return null;
  const [resources, rules] = await Promise.all([
    db.execute(sql`
      SELECT rs.id, rs.quantity FROM club_service_resources x
        JOIN club_resources rs ON rs.club_id = x.club_id AND rs.id = x.resource_id
       WHERE x.club_id = ${clubId}::uuid AND x.service_id = ${serviceId}::uuid
         AND rs.archived_at IS NULL
       ORDER BY rs.sort_order, rs.name
    `),
    db.execute(sql`
      SELECT pr.id, pr.service_id, pr.weekdays, to_char(pr.from_local, 'HH24:MI') AS from_local,
             to_char(pr.to_local, 'HH24:MI') AS to_local, pr.price_cents, pr.member_price_cents,
             pr.priority
        FROM club_price_rules pr
       WHERE pr.club_id = ${clubId}::uuid AND pr.service_id = ${serviceId}::uuid
    `),
  ]);
  return {
    ...toService(row),
    resources: resources.rows.map((r) => ({ id: String(r.id), quantity: Number(r.quantity) })),
    rules: rules.rows.map(toPriceRule),
  };
}

export interface AvailableSlot {
  local: string;
  startsAt: string;
  endsAt: string;
  resourceId: string | null;
  staffUserId: string | null;
  priceCents: number;
}

/**
 * The bookable starts of a service on one day, each with the resource and/or
 * trainer it would take and its price. `office` lifts the public-only and
 * member-window rules (the desk books private services and up to the 42-day
 * cap); `member` prices at the member rate.
 */
export async function availability(
  db: SqlRunner,
  clubId: string,
  serviceId: string,
  date: IsoDate,
  durationMinutes: number,
  options: { member: boolean; office: boolean; now?: number },
): Promise<AvailableSlot[]> {
  const service = await loadService(db, clubId, serviceId);
  if (!service || !isIsoDate(date)) return [];
  if (!options.office && service.visibility !== 'public') return [];
  if (
    !serviceDurations(service.durationMin, service.durationMax, service.stepMinutes).includes(
      durationMinutes,
    )
  ) {
    return [];
  }
  const today = sofiaToday();
  const window = options.office ? MAX_BOOKING_WINDOW_DAYS : service.bookingWindowDays;
  if (date < today || date > addDaysIso(today, window)) return [];
  const weekday = isoWeekdayOf(date);
  const hoursRow = (
    await db.execute(sql`
      SELECT to_char(opens, 'HH24:MI') AS opens, to_char(closes, 'HH24:MI') AS closes
        FROM club_location_hours
       WHERE club_id = ${clubId}::uuid AND location_id = ${service.locationId}::uuid
         AND weekday = ${weekday}
    `)
  ).rows[0];
  if (!hoursRow) return [];
  const hours: OpeningHours = { opens: String(hoursRow.opens), closes: String(hoursRow.closes) };
  // Busy time from half a day either side, so a buffer or a long block that
  // crosses midnight is still seen.
  const from = new Date(dayStart(date).getTime() - 12 * 3_600_000).toISOString();
  const to = new Date(dayStart(addDaysIso(date, 1)).getTime() + 12 * 3_600_000).toISOString();
  const notBefore = options.now ?? Date.now();
  const base = {
    date,
    timeZone: SOFIA_TZ,
    durationMinutes,
    stepMinutes: service.stepMinutes,
    notBefore,
  };

  const resourceIds = service.resources.map((r) => r.id);
  const resourceBusy = new Map<string, BusyInterval[]>();
  if (resourceIds.length > 0) {
    // A hold blocks until its grace has passed too (a payment made in its
    // last moments lands first); after that, nothing, even before the sweep.
    const claims = await db.execute(sql`
      SELECT c.resource_id, lower(c.during) AS s, upper(c.during) AS e, c.units
        FROM club_calendar_claims c
       WHERE c.club_id = ${clubId}::uuid AND c.resource_id = ANY(${sql.param(resourceIds)}::uuid[])
         AND c.during && tstzrange(${from}::timestamptz, ${to}::timestamptz)
         AND NOT EXISTS (SELECT 1 FROM club_reservations h
                          WHERE c.source = 'reservation' AND h.id = c.source_id
                            AND h.state = 'held'
                            AND h.hold_expires_at < now() - make_interval(mins => ${HOLD_GRACE_MINUTES}::int))
    `);
    for (const row of claims.rows) {
      const list = resourceBusy.get(String(row.resource_id)) ?? [];
      list.push({
        start: Date.parse(iso(row.s)),
        end: Date.parse(iso(row.e)),
        units: Number(row.units ?? 1),
      });
      resourceBusy.set(String(row.resource_id), list);
    }
  }
  const resourceSlots = new Map<string, Slot[]>(
    service.resources.map((r) => [
      r.id,
      availableSlots({
        ...base,
        hours,
        bufferMinutes: service.bufferMinutes,
        busy: saturatedIntervals(resourceBusy.get(r.id) ?? [], r.quantity),
      }),
    ]),
  );
  const freeResourceAt = (local: string): string | null =>
    service.resources.find((r) => resourceSlots.get(r.id)?.some((s) => s.local === local))?.id ??
    null;

  const offered = new Map<string, Omit<AvailableSlot, 'priceCents'>>();
  if (service.kind === 'rental') {
    for (const r of service.resources) {
      for (const slot of resourceSlots.get(r.id) ?? []) {
        if (!offered.has(slot.local)) {
          offered.set(slot.local, {
            local: slot.local,
            startsAt: slot.startsAt.toISOString(),
            endsAt: slot.endsAt.toISOString(),
            resourceId: r.id,
            staffUserId: null,
          });
        }
      }
    }
  } else if (service.staffUserIds.length > 0) {
    const [staffHours, staffBusy] = await Promise.all([
      db.execute(sql`
        SELECT staff_user_id, to_char(opens, 'HH24:MI') AS opens, to_char(closes, 'HH24:MI') AS closes
          FROM club_staff_hours
         WHERE club_id = ${clubId}::uuid AND location_id = ${service.locationId}::uuid
           AND weekday = ${weekday}
           AND staff_user_id = ANY(${sql.param(service.staffUserIds)}::text[])
      `),
      // A trainer is busy with their claims (appointments, leave) AND with the
      // classes they teach, which the calendar does not claim (see 0048).
      db.execute(sql`
        SELECT c.staff_user_id AS who, lower(c.during) AS s, upper(c.during) AS e
          FROM club_calendar_claims c
         WHERE c.club_id = ${clubId}::uuid
           AND c.staff_user_id = ANY(${sql.param(service.staffUserIds)}::text[])
           AND c.during && tstzrange(${from}::timestamptz, ${to}::timestamptz)
           AND NOT EXISTS (SELECT 1 FROM club_reservations h
                            WHERE c.source = 'reservation' AND h.id = c.source_id
                              AND h.state = 'held'
                              AND h.hold_expires_at < now() - make_interval(mins => ${HOLD_GRACE_MINUTES}::int))
        UNION ALL
        SELECT coalesce(o.instructor_user_id, k.instructor_user_id), o.starts_at, o.ends_at
          FROM club_class_occurrences o
          JOIN club_classes k ON k.club_id = o.club_id AND k.id = o.class_id
         WHERE o.club_id = ${clubId}::uuid AND o.status = 'scheduled'
           AND coalesce(o.instructor_user_id, k.instructor_user_id) = ANY(${sql.param(service.staffUserIds)}::text[])
           AND o.starts_at < ${to}::timestamptz AND o.ends_at > ${from}::timestamptz
      `),
    ]);
    for (const staffId of service.staffUserIds) {
      const own = staffHours.rows.find((r) => String(r.staff_user_id) === staffId);
      if (!own) continue;
      const window = overlap(hours, { opens: String(own.opens), closes: String(own.closes) });
      if (!window) continue;
      const busy = staffBusy.rows
        .filter((r) => String(r.who) === staffId)
        .map((r) => ({ start: Date.parse(iso(r.s)), end: Date.parse(iso(r.e)) }));
      for (const slot of availableSlots({ ...base, hours: window, bufferMinutes: 0, busy })) {
        if (offered.has(slot.local)) continue;
        const resourceId = service.resources.length > 0 ? freeResourceAt(slot.local) : null;
        if (service.resources.length > 0 && resourceId === null) continue;
        offered.set(slot.local, {
          local: slot.local,
          startsAt: slot.startsAt.toISOString(),
          endsAt: slot.endsAt.toISOString(),
          resourceId,
          staffUserId: staffId,
        });
      }
    }
  }
  return [...offered.values()]
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .map((slot) => ({
      ...slot,
      priceCents:
        priceFor({
          unit: service.priceUnit,
          baseCents: service.priceCents,
          memberBaseCents: service.memberPriceCents,
          rules: service.rules,
          weekday,
          startLocal: slot.local,
          durationMinutes,
          member: options.member,
        }) ?? service.priceCents,
    }));
}

export type BookingResult =
  | { ok: true; reservationId: string; chargeId: string | null; state: 'confirmed' | 'held' }
  | {
      ok: false;
      error:
        | 'not_allowed'
        | 'slot_taken'
        | 'audience_mismatch'
        | 'claim_first'
        | 'link_pending'
        | 'payment_unavailable'
        | 'hold_pending'
        | 'limit_reached';
    };

class Refused extends Error {
  constructor(readonly code: Exclude<BookingResult, { ok: true }>['error']) {
    super(code);
  }
}

/** Unpaid holds one account may have at a club at once: pay or cancel, then book again. */
export const MAX_LIVE_HOLDS = 1;

/**
 * Book a slot — at the desk (bookings.manage, for any record of the club) or
 * by a member for their own record or a child's (memberSelfScope; with no
 * record yet, one is created as a trial booking does). The slot is recomputed
 * here, never taken from the form. Every refusal rolls back.
 *
 * Online, an account holds at most MAX_LIVE_HOLDS unpaid slots at a club and
 * at most the service's `max_upcoming_per_member` upcoming bookings of it —
 * per ACCOUNT, a parent's and their children's together (the cap is against
 * one person emptying a calendar, and the parent is that person) — counted
 * under a per-account lock, so two tabs cannot both slip under the cap. The
 * desk is not capped.
 */
export async function bookReservation(
  db: TransactionalDb,
  by: { kind: 'staff'; actor: ClubActor } | { kind: 'member'; userId: string; clubId: string },
  request: ReservationRequest,
): Promise<BookingResult> {
  const clubId = by.kind === 'staff' ? by.actor.clubId : by.clubId;
  // Read before the transaction: it asks the provider settings, not the books.
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
      // The member price on the DAY booked, from a real abonnement — a trial
      // or one that has run out by then does not unlock it.
      const member = (
        await tx.execute(sql`
          SELECT m.id, m.is_minor,
                 EXISTS (SELECT 1 FROM club_membership_balances mb
                          WHERE mb.club_id = m.club_id AND mb.member_id = m.id
                            AND mb.kind <> 'trial' AND mb.cancelled_at IS NULL
                            AND mb.state <> 'exhausted'
                            AND ${request.date}::date BETWEEN mb.starts_on AND mb.effective_ends_on
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
      const service = await loadService(tx, clubId, request.serviceId);
      if (!service || (by.kind === 'member' && service.visibility !== 'public')) {
        throw new Refused('not_allowed');
      }
      const minor = member.is_minor === true;
      if ((service.audience === 'adults' && minor) || (service.audience === 'minors' && !minor)) {
        throw new Refused('audience_mismatch');
      }
      if (by.kind === 'member') {
        if (service.payment === 'online_required' && !takesPayments) {
          throw new Refused('payment_unavailable');
        }
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`club_reservations:${clubId}:${by.userId}`}, 0))`,
        );
        const mine = (
          await tx.execute(sql`
            SELECT count(*) FILTER (WHERE rv.service_id = ${service.id}::uuid
                                      AND rv.state IN ('held', 'confirmed')
                                      AND rv.ends_at > now())::int AS upcoming,
                   count(*) FILTER (WHERE rv.state = 'held'
                                      AND rv.hold_expires_at > now() - make_interval(mins => ${HOLD_GRACE_MINUTES}::int))::int AS holds
              FROM club_reservations rv
              JOIN club_members m ON m.club_id = rv.club_id AND m.id = rv.member_id
             WHERE rv.club_id = ${clubId}::uuid AND ${memberSelfScope(by.userId, clubId, 'm')}
          `)
        ).rows[0];
        if (Number(mine?.holds ?? 0) >= MAX_LIVE_HOLDS) throw new Refused('hold_pending');
        if (Number(mine?.upcoming ?? 0) >= service.maxUpcomingPerMember) {
          throw new Refused('limit_reached');
        }
      }
      const slots = await availability(
        tx,
        clubId,
        request.serviceId,
        request.date,
        request.durationMinutes,
        { member: member.holds_membership === true, office: by.kind === 'staff' },
      );
      const slot = slots.find((s) => s.local === request.local);
      if (!slot) throw new Refused('slot_taken');
      // A lapsed hold on this slot is released here, as the sweep would —
      // its charge voided and its checkout closed in this same transaction.
      await releaseLapsedHolds(tx, {
        clubId,
        resourceId: slot.resourceId,
        staffUserId: slot.staffUserId,
      });
      // Only a member paying for themselves online waits on a hold, and only
      // for an amount the provider can take; the desk books outright and
      // takes the money however it does.
      const held =
        by.kind === 'member' &&
        service.payment === 'online_required' &&
        slot.priceCents >= MIN_ONLINE_CENTS;
      let chargeId: string | null = null;
      if (slot.priceCents > 0) {
        const charge = await tx.execute(sql`
          INSERT INTO club_charges (club_id, member_id, kind, label, amount_cents, issued_on, due_on,
                                    created_by)
          VALUES (${clubId}::uuid, ${memberId}::uuid, 'reservation',
                  ${`${service.nameBg} · ${request.date} ${request.local}`.slice(0, 120)},
                  ${slot.priceCents}, ${sofiaToday()}::date, ${request.date}::date,
                  ${by.kind === 'staff' ? by.actor.userId : null})
          RETURNING id
        `);
        chargeId = text(charge.rows[0]?.id);
      }
      const created = await tx.execute(sql`
        INSERT INTO club_reservations (club_id, service_id, member_id, resource_id, staff_user_id,
                                       starts_at, ends_at, buffer_minutes, state, hold_expires_at,
                                       price_cents, cancel_deadline_hours, charge_id, booked_by)
        VALUES (${clubId}::uuid, ${service.id}::uuid, ${memberId}::uuid, ${slot.resourceId}::uuid,
                ${slot.staffUserId}, ${slot.startsAt}::timestamptz, ${slot.endsAt}::timestamptz,
                ${service.bufferMinutes}, ${held ? 'held' : 'confirmed'},
                ${held ? sql`now() + make_interval(mins => ${HOLD_MINUTES}::int)` : sql`NULL`},
                ${slot.priceCents}, ${service.cancelDeadlineHours}, ${chargeId}::uuid,
                ${by.kind === 'staff' ? by.actor.userId : null})
        RETURNING id
      `);
      const reservationId = String(created.rows[0]?.id);
      await recordClubAudit(tx, {
        clubId,
        by:
          by.kind === 'staff'
            ? { kind: 'staff', actor: by.actor }
            : { kind: 'member', userId: by.userId },
        action: 'reservation_created',
        subjectMemberId: memberId,
        detail: { reservationId, serviceId: service.id, priceCents: slot.priceCents },
      });
      return { ok: true, reservationId, chargeId, state: held ? 'held' : 'confirmed' } as const;
    });
  } catch (error: unknown) {
    if (error instanceof Refused) return { ok: false, error: error.code };
    const constraint = violatedConstraint(error);
    // Someone took the slot between the availability read and the insert.
    if (
      constraint === 'club_calendar_claims_resource_free' ||
      constraint === 'club_calendar_claims_staff_free' ||
      constraint === 'club_calendar_claims_pool_full' ||
      // The resource's own settings changing at the same instant (its
      // quantity trigger re-marking claims): rare; the member simply retries.
      pgError(error)?.code === '40P01'
    ) {
      return { ok: false, error: 'slot_taken' };
    }
    throw error;
  }
}

export type CancelResult = { ok: true; late: boolean; refundDue: boolean } | { ok: false };

/**
 * Cancel a booking — the member for their own record or a child's, the desk
 * (bookings.manage) for any, an erased client's included.
 *
 * Only a member's cancellation of a CONFIRMED booking after its deadline —
 * the deadline snapshotted when it was booked — is LATE: the charge stays, as
 * a class's late cancellation would. A held booking was never the member's
 * yet, so it is simply released. Otherwise an unpaid charge is voided (and
 * logged as such); money already paid stays on the books as a refund the
 * office owes, listed on «Плащания» until it is recorded (`refundsDue`).
 *
 * Locks the charge before the booking — the order every hold path uses.
 * Once committed, a cancellation that is not late closes the charge's open
 * checkout at the provider, so its payment page stops taking money.
 */
export async function cancelReservation(
  db: TransactionalDb,
  by: { kind: 'staff'; actor: ClubActor } | { kind: 'member'; userId: string; clubId: string },
  reservationId: string,
): Promise<CancelResult> {
  const clubId = by.kind === 'staff' ? by.actor.clubId : by.clubId;
  const { result, chargeId } = await cancelOnce(db, by, clubId, reservationId);
  if (result.ok && !result.late && chargeId !== null) await closeChargeCheckout(clubId, chargeId);
  return result;
}

async function cancelOnce(
  db: TransactionalDb,
  by: { kind: 'staff'; actor: ClubActor } | { kind: 'member'; userId: string; clubId: string },
  clubId: string,
  reservationId: string,
): Promise<{ result: CancelResult; chargeId: string | null }> {
  const refused = { result: { ok: false } as const, chargeId: null };
  return db.transaction(async (tx) => {
    const found = (
      await tx.execute(sql`
        SELECT rv.charge_id FROM club_reservations rv
         WHERE rv.id = ${reservationId}::uuid AND rv.club_id = ${clubId}::uuid
           AND rv.state IN ('held', 'confirmed') AND rv.starts_at > now()
           AND ${
             by.kind === 'staff'
               ? clubWriteScope(by.actor, 'bookings.manage', 'rv')
               : sql`EXISTS (SELECT 1 FROM club_members m
                              WHERE m.club_id = rv.club_id AND m.id = rv.member_id
                                AND ${memberSelfScope(by.userId, clubId, 'm')})
                     AND ${clubWritableGuard(clubId)}`
           }
      `)
    ).rows[0];
    if (!found) return refused;
    const chargeId = text(found.charge_id);
    if (chargeId !== null) {
      await tx.execute(sql`
        SELECT ch.id FROM club_charges ch
         WHERE ch.club_id = ${clubId}::uuid AND ch.id = ${chargeId}::uuid
           FOR NO KEY UPDATE
      `);
    }
    const updated = await tx.execute(sql`
      UPDATE club_reservations rv
         SET state = CASE WHEN ${by.kind === 'member'} AND rv.state = 'confirmed'
                           AND rv.starts_at - make_interval(hours => rv.cancel_deadline_hours) < now()
                          THEN 'late_cancelled' ELSE 'cancelled' END,
             cancelled_at = now(), cancel_kind = ${by.kind === 'member' ? 'member' : 'staff'},
             hold_expires_at = NULL
       WHERE rv.id = ${reservationId}::uuid AND rv.club_id = ${clubId}::uuid
         AND rv.state IN ('held', 'confirmed') AND rv.starts_at > now()
         AND ${
           by.kind === 'staff'
             ? clubWriteScope(by.actor, 'bookings.manage', 'rv')
             : sql`EXISTS (SELECT 1 FROM club_members m
                            WHERE m.club_id = rv.club_id AND m.id = rv.member_id
                              AND ${memberSelfScope(by.userId, clubId, 'm')})
                   AND ${clubWritableGuard(clubId)}`
         }
      RETURNING rv.state, rv.member_id
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
    if (!late && chargeId !== null) {
      // Voided even when money was paid on it: nothing more is owed for a
      // booking that no longer exists (a part-paid one would otherwise go on
      // "owing" the rest), a void charge refuses any further payment, and what
      // was paid shows as a refund the club owes.
      const voided = await tx.execute(sql`
        UPDATE club_charges ch SET voided_at = now()
         WHERE ch.club_id = ${clubId}::uuid AND ch.id = ${chargeId}::uuid
           AND ch.voided_at IS NULL
        RETURNING ch.id
      `);
      if (voided.rows[0]) {
        await recordClubAudit(tx, {
          clubId,
          by: auditBy,
          action: 'charge_voided',
          subjectMemberId: memberId,
          detail: { chargeId, reason: 'reservation_cancelled' },
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
      action: 'reservation_cancelled',
      subjectMemberId: memberId,
      detail: { reservationId, late, refundDue },
    });
    return { result: { ok: true, late, refundDue } as const, chargeId };
  });
}

export interface RefundDue {
  reservationId: string;
  chargeId: string;
  memberId: string | null;
  memberName: string | null;
  serviceName: string;
  startsAt: string;
  paidCents: number;
  /** Of it, paid with prepaid credit — which goes back to the credit (0050). */
  creditCents: number;
  /** Card money still on it: refunded through the provider, from its row in the ledger. */
  online: boolean;
}

/**
 * Bookings cancelled in time after they were paid: money the club owes back.
 * Derived, not stored — a booking leaves this list the moment the refund is
 * recorded against its charge (net paid falls to zero).
 */
export async function refundsDue(actor: ClubActor): Promise<RefundDue[]> {
  const result = await getDb().execute(sql`
    SELECT rv.id, rv.charge_id, rv.member_id, m.display_name, sv.name_bg AS service,
           rv.starts_at, net.paid_cents, net.credit_cents, net.online
      FROM club_reservations rv
      JOIN club_services sv ON sv.club_id = rv.club_id AND sv.id = rv.service_id
      JOIN LATERAL (SELECT sum(pp.amount_cents)::int AS paid_cents,
                           coalesce(sum(pp.amount_cents) FILTER (WHERE pp.method = 'wallet'), 0)::int
                             AS credit_cents,
                           coalesce(sum(pp.amount_cents)
                                      FILTER (WHERE pp.method = 'card_online'), 0) > 0 AS online
                      FROM club_payments pp
                     WHERE pp.club_id = rv.club_id AND pp.charge_id = rv.charge_id) net ON true
      LEFT JOIN club_members m ON m.club_id = rv.club_id AND m.id = rv.member_id
     WHERE ${clubScope(actor, 'payments.view', 'rv')}
       AND rv.state IN ('cancelled', 'expired') AND net.paid_cents > 0
     ORDER BY rv.cancelled_at DESC NULLS LAST, rv.starts_at DESC
     LIMIT 100
  `);
  return result.rows.map((row) => ({
    reservationId: String(row.id),
    chargeId: String(row.charge_id),
    memberId: text(row.member_id),
    memberName: text(row.display_name),
    serviceName: String(row.service),
    startsAt: iso(row.starts_at),
    paidCents: Number(row.paid_cents),
    creditCents: Number(row.credit_cents ?? 0),
    online: row.online === true,
  }));
}

export interface MemberReservation {
  id: string;
  memberId: string;
  memberName: string;
  serviceName: string;
  startsAt: string;
  endsAt: string;
  resourceName: string | null;
  trainerName: string | null;
  state: 'held' | 'confirmed';
  priceCents: number;
  freeCancelUntil: string;
  chargeId: string | null;
  owedCents: number;
}

/** The account's own (and its children's) upcoming bookings — the portal. */
export async function memberReservations(
  userId: string,
  clubId: string,
  locale: string,
): Promise<MemberReservation[]> {
  const result = await getDb().execute(sql`
    SELECT rv.id, rv.member_id, m.display_name,
           CASE WHEN ${locale} = 'en' THEN coalesce(sv.name_en, sv.name_bg) ELSE sv.name_bg END AS service,
           rv.starts_at, rv.ends_at, rs.name AS resource_name,
           coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(u.display_name), '')) AS trainer,
           rv.state, rv.price_cents, rv.charge_id,
           rv.starts_at - make_interval(hours => rv.cancel_deadline_hours) AS free_until,
           coalesce((SELECT cb.due_cents FROM club_charge_balances cb
                      WHERE cb.charge_id = rv.charge_id), 0) AS owed
      FROM club_reservations rv
      JOIN club_members m ON m.club_id = rv.club_id AND m.id = rv.member_id
      JOIN club_services sv ON sv.club_id = rv.club_id AND sv.id = rv.service_id
      LEFT JOIN club_resources rs ON rs.club_id = rv.club_id AND rs.id = rv.resource_id
      LEFT JOIN club_staff st ON st.club_id = rv.club_id AND st.user_id = rv.staff_user_id
      LEFT JOIN users u ON u.id = rv.staff_user_id
     WHERE ${memberSelfScope(userId, clubId, 'm')}
       AND rv.state IN ('held', 'confirmed') AND rv.ends_at > now()
     ORDER BY rv.starts_at
     LIMIT 50
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    memberId: String(row.member_id),
    memberName: String(row.display_name),
    serviceName: String(row.service),
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    resourceName: text(row.resource_name),
    trainerName: text(row.trainer),
    state: row.state === 'held' ? 'held' : 'confirmed',
    priceCents: Number(row.price_cents),
    freeCancelUntil: iso(row.free_until),
    chargeId: text(row.charge_id),
    owedCents: Number(row.owed ?? 0),
  }));
}

export interface CalendarItem {
  kind: 'class' | 'reservation' | 'block';
  id: string;
  startsAt: string;
  endsAt: string;
  title: string;
  /** Only for staff who may see members (members.view). */
  memberName: string | null;
  state: string | null;
}

export interface CalendarLane {
  id: string;
  name: string;
  items: CalendarItem[];
}

/**
 * One day at one location for the office: a lane per resource (its classes,
 * bookings and closures) and a lane per trainer with appointments. Names of
 * clients only for staff who may see members — decided in the statement.
 */
export async function dayCalendar(
  actor: ClubActor,
  locationId: string,
  date: IsoDate,
): Promise<{ resources: CalendarLane[]; trainers: CalendarLane[] }> {
  const db = getDb();
  const name = sql`CASE WHEN ${clubActorMay(actor, 'members.view', { write: false })}
                        THEN m.display_name END`;
  const from = dayStart(date).toISOString();
  const to = dayStart(addDaysIso(date, 1)).toISOString();
  const [resources, items, trainerItems] = await Promise.all([
    db.execute(sql`
      SELECT rs.id, rs.name FROM club_resources rs
       WHERE ${clubScope(actor, 'schedule.view', 'rs')} AND rs.location_id = ${locationId}::uuid
         AND rs.archived_at IS NULL
       ORDER BY rs.sort_order, rs.name
    `),
    db.execute(sql`
      SELECT 'reservation' AS kind, rv.id, rv.resource_id AS lane, rv.starts_at, rv.ends_at,
             sv.name_bg AS title, ${name} AS member, rv.state
        FROM club_reservations rv
        JOIN club_services sv ON sv.club_id = rv.club_id AND sv.id = rv.service_id
        LEFT JOIN club_members m ON m.club_id = rv.club_id AND m.id = rv.member_id
       WHERE ${clubScope(actor, 'schedule.view', 'rv')} AND rv.resource_id IS NOT NULL
         AND rv.state IN ('held', 'confirmed')
         AND rv.starts_at < ${to}::timestamptz AND rv.ends_at > ${from}::timestamptz
      UNION ALL
      SELECT 'class', o.id, k.resource_id, o.starts_at, o.ends_at, k.title, NULL, o.status
        FROM club_class_occurrences o
        JOIN club_classes k ON k.club_id = o.club_id AND k.id = o.class_id
       WHERE o.club_id = ${actor.clubId}::uuid AND k.resource_id IS NOT NULL
         AND o.status = 'scheduled'
         AND o.starts_at < ${to}::timestamptz AND o.ends_at > ${from}::timestamptz
      UNION ALL
      SELECT 'block', tb.id, tb.resource_id, tb.starts_at, tb.ends_at, tb.reason, NULL, NULL
        FROM club_time_blocks tb
       WHERE tb.club_id = ${actor.clubId}::uuid AND tb.resource_id IS NOT NULL
         AND tb.starts_at < ${to}::timestamptz AND tb.ends_at > ${from}::timestamptz
       ORDER BY 4
    `),
    db.execute(sql`
      SELECT rv.id, rv.staff_user_id AS lane, rv.starts_at, rv.ends_at, sv.name_bg AS title,
             ${name} AS member, rv.state,
             coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(u.display_name), '')) AS trainer
        FROM club_reservations rv
        JOIN club_services sv ON sv.club_id = rv.club_id AND sv.id = rv.service_id
        LEFT JOIN club_members m ON m.club_id = rv.club_id AND m.id = rv.member_id
        LEFT JOIN club_staff st ON st.club_id = rv.club_id AND st.user_id = rv.staff_user_id
        LEFT JOIN users u ON u.id = rv.staff_user_id
       WHERE ${clubScope(actor, 'schedule.view', 'rv')} AND rv.staff_user_id IS NOT NULL
         AND sv.location_id = ${locationId}::uuid AND rv.state IN ('held', 'confirmed')
         AND rv.starts_at < ${to}::timestamptz AND rv.ends_at > ${from}::timestamptz
       ORDER BY rv.starts_at
    `),
  ]);
  const item = (row: Record<string, unknown>, kind: CalendarItem['kind']): CalendarItem => ({
    kind,
    id: String(row.id),
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    title: String(row.title),
    memberName: text(row.member),
    state: text(row.state),
  });
  const resourceLanes = resources.rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    items: items.rows
      .filter((row) => String(row.lane) === String(r.id))
      .map((row) => item(row, String(row.kind) as CalendarItem['kind'])),
  }));
  const trainers = new Map<string, CalendarLane>();
  for (const row of trainerItems.rows) {
    const lane = String(row.lane);
    const entry = trainers.get(lane) ?? { id: lane, name: text(row.trainer) ?? '—', items: [] };
    entry.items.push(item(row, 'reservation'));
    trainers.set(lane, entry);
  }
  return { resources: resourceLanes, trainers: [...trainers.values()] };
}

export interface PublicService {
  id: string;
  kind: ClubService['kind'];
  name: string;
  description: string | null;
  durations: number[];
  priceCents: number;
  priceUnit: 'hour' | 'booking';
  memberPriceCents: number | null;
  payment: ClubService['payment'];
  bookingWindowDays: number;
  cancelDeadlineHours: number;
  audience: ClubService['audience'];
}

/** A club's PUBLIC, live services — the portal's booking page and the club page. */
export async function publicServices(clubId: string, locale: string): Promise<PublicService[]> {
  const result = await getDb().execute(sql`
    SELECT ${SERVICE_COLUMNS} FROM club_services sv
     WHERE sv.club_id = ${clubId}::uuid AND sv.visibility = 'public' AND sv.archived_at IS NULL
     ORDER BY sv.sort_order, sv.name_bg
  `);
  return result.rows.map(toService).map((service) => ({
    id: service.id,
    kind: service.kind,
    name: locale === 'en' ? (service.nameEn ?? service.nameBg) : service.nameBg,
    description:
      locale === 'en' ? (service.descriptionEn ?? service.descriptionBg) : service.descriptionBg,
    durations: serviceDurations(service.durationMin, service.durationMax, service.stepMinutes),
    priceCents: service.priceCents,
    priceUnit: service.priceUnit,
    memberPriceCents: service.memberPriceCents,
    payment: service.payment,
    bookingWindowDays: service.bookingWindowDays,
    cancelDeadlineHours: service.cancelDeadlineHours,
    audience: service.audience,
  }));
}
