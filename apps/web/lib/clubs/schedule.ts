import { getDb, sql, type SQL } from '@sportkarta/db';
import type { ClubCheckinMethod, ClubSport, IsoDate } from '@sportkarta/lib/clubs';

import { recordClubAudit } from './audit';
import type { ClassInput } from './input';
import {
  clubActorMay,
  clubScope,
  clubWriteScope,
  occurrenceStaffScope,
  type ClubActor,
} from './scope';

/**
 * A club's timetable (0042): class series, their materialized occurrences, the
 * week grid and the roster.
 *
 * THE ROSTER PROJECTION. A trainer sees the roster of the classes they teach
 * and, on it, each person's display name and whether they are a minor — never
 * an email, a phone, a note, a debt or a card (permissions.ts; asserted by
 * apps/web/tests/club-projections.test.ts against `rosterForTrainer`). Front of
 * house additionally sees the coverage state the desk acts on.
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

export interface ClubClass extends ClassInput {
  id: string;
  status: 'scheduled' | 'cancelled';
  locationName: string;
  instructorName: string | null;
}

export async function listClasses(actor: ClubActor): Promise<ClubClass[]> {
  const result = await getDb().execute(sql`
    SELECT k.*, to_char(k.starts_at_local, 'YYYY-MM-DD HH24:MI:SS') AS starts_local_text,
           l.name AS location_name, coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(u.display_name), ''), split_part(u.email, '@', 1)) AS instructor_name,
           coalesce((SELECT array_agg(cp.plan_id::text) FROM club_class_plans cp
                      WHERE cp.class_id = k.id), '{}') AS plan_ids
      FROM club_classes k
      JOIN club_locations l ON l.id = k.location_id
      LEFT JOIN club_staff st ON st.club_id = k.club_id AND st.user_id = k.instructor_user_id
      LEFT JOIN users u ON u.id = k.instructor_user_id
     WHERE ${clubScope(actor, 'schedule.view', 'k')}
     ORDER BY k.status, k.starts_at_local
  `);
  return result.rows.map(toClass);
}

function toClass(row: Record<string, unknown>): ClubClass {
  return {
    id: String(row.id),
    title: String(row.title),
    description: text(row.description),
    sport: String(row.sport) as ClubSport,
    locationId: String(row.location_id),
    instructorUserId: text(row.instructor_user_id),
    startsAtLocal: String(row.starts_local_text),
    rrule: text(row.rrule),
    durationMinutes: Number(row.duration_minutes),
    capacity: row.capacity === null ? null : Number(row.capacity),
    bookingOpensHours: Number(row.booking_opens_hours),
    cancelDeadlineHours: Number(row.cancel_deadline_hours),
    dropInPriceCents: row.drop_in_price_cents === null ? null : Number(row.drop_in_price_cents),
    coversAllPlans: row.covers_all_plans === true,
    planIds: Array.isArray(row.plan_ids) ? row.plan_ids.map(String) : [],
    trialAllowed: row.trial_allowed === true,
    public: row.public === true,
    status: row.status === 'cancelled' ? 'cancelled' : 'scheduled',
    locationName: String(row.location_name),
    instructorName: text(row.instructor_name),
  };
}

export async function classById(actor: ClubActor, classId: string): Promise<ClubClass | null> {
  const result = await getDb().execute(sql`
    SELECT k.*, to_char(k.starts_at_local, 'YYYY-MM-DD HH24:MI:SS') AS starts_local_text,
           l.name AS location_name, coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(u.display_name), ''), split_part(u.email, '@', 1)) AS instructor_name,
           coalesce((SELECT array_agg(cp.plan_id::text) FROM club_class_plans cp
                      WHERE cp.class_id = k.id), '{}') AS plan_ids
      FROM club_classes k
      JOIN club_locations l ON l.id = k.location_id
      LEFT JOIN club_staff st ON st.club_id = k.club_id AND st.user_id = k.instructor_user_id
      LEFT JOIN users u ON u.id = k.instructor_user_id
     WHERE ${clubScope(actor, 'schedule.view', 'k')} AND k.id = ${classId}::uuid
  `);
  return result.rows[0] ? toClass(result.rows[0]) : null;
}

/**
 * Create or edit a class series. An edit sets materialized_through back to
 * NULL so the materializer re-expands the rule at once (the caller enqueues
 * it); occurrences the new rule no longer produces are reconciled there —
 * cancelled when somebody booked, removed otherwise, the past never touched.
 * The location and the plans must be this club's (composite keys refuse the
 * rest); the instructor must be this club's staff (composite FK to club_staff).
 */
export async function saveClass(
  db: TransactionalDb,
  actor: ClubActor,
  classId: string | null,
  input: ClassInput,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const fields = sql`${input.locationId}::uuid, ${input.title}, ${input.description}, ${input.sport},
      ${input.instructorUserId}, ${input.startsAtLocal}::timestamp, ${input.rrule},
      ${input.durationMinutes}, ${input.capacity}, ${input.bookingOpensHours},
      ${input.cancelDeadlineHours}, ${input.dropInPriceCents}, ${input.coversAllPlans},
      ${input.trialAllowed}, ${input.public}`;
    const result = classId
      ? await tx.execute(sql`
          UPDATE club_classes k
             SET (location_id, title, description, sport, instructor_user_id, starts_at_local, rrule,
                  duration_minutes, capacity, booking_opens_hours, cancel_deadline_hours,
                  drop_in_price_cents, covers_all_plans, trial_allowed, public) = (${fields}),
                 materialized_through = NULL
           WHERE k.id = ${classId}::uuid AND k.status = 'scheduled'
             AND ${clubWriteScope(actor, 'schedule.manage', 'k')}
           RETURNING k.id`)
      : await tx.execute(sql`
          INSERT INTO club_classes (club_id, location_id, title, description, sport,
                                    instructor_user_id, starts_at_local, rrule, duration_minutes,
                                    capacity, booking_opens_hours, cancel_deadline_hours,
                                    drop_in_price_cents, covers_all_plans, trial_allowed, public,
                                    created_by)
          SELECT ${actor.clubId}::uuid, ${fields}, ${actor.userId}
           WHERE ${clubActorMay(actor, 'schedule.manage', { write: true })}
          RETURNING id`);
    const id = text(result.rows[0]?.id);
    if (!id) return null;
    await tx.execute(sql`DELETE FROM club_class_plans WHERE class_id = ${id}::uuid`);
    if (!input.coversAllPlans && input.planIds.length > 0) {
      await tx.execute(sql`
        INSERT INTO club_class_plans (club_id, class_id, plan_id)
        SELECT ${actor.clubId}::uuid, ${id}::uuid, p
          FROM unnest(${sql.param(input.planIds)}::uuid[]) AS p
      `);
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'class_saved',
      detail: { classId: id },
    });
    return id;
  });
}

/**
 * Cancel a series. The 0042 trigger cancels its future occurrences; this
 * returns those that had active bookings, so the caller can tell the bookers.
 */
export async function cancelClass(
  db: TransactionalDb,
  actor: ClubActor,
  classId: string,
): Promise<string[] | null> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_classes k SET status = 'cancelled'
       WHERE k.id = ${classId}::uuid AND k.status = 'scheduled'
         AND ${clubWriteScope(actor, 'schedule.manage', 'k')}
       RETURNING k.id
    `);
    if (updated.rows.length === 0) return null;
    const affected = await tx.execute(sql`
      SELECT DISTINCT o.id FROM club_class_occurrences o
        JOIN club_bookings b ON b.occurrence_id = o.id AND b.state = 'active'
       WHERE o.class_id = ${classId}::uuid AND o.status = 'cancelled' AND o.cancellation_scope = 'series'
         AND o.starts_at > now()
    `);
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'class_cancelled',
      detail: { classId },
    });
    return affected.rows.map((row) => String(row.id));
  });
}

export async function cancelOccurrence(
  db: TransactionalDb,
  actor: ClubActor,
  occurrenceId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_class_occurrences o
         SET status = 'cancelled', cancelled_at = now(), cancellation_scope = 'occurrence'
       WHERE o.id = ${occurrenceId}::uuid AND o.status = 'scheduled' AND o.starts_at > now()
         AND ${clubWriteScope(actor, 'schedule.manage', 'o')}
       RETURNING o.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'occurrence_cancelled',
      detail: { occurrenceId },
    });
    return true;
  });
}

export interface WeekOccurrence {
  id: string;
  classId: string;
  title: string;
  sport: ClubSport;
  startsAt: string;
  endsAt: string;
  /** Sofia wall clock, `YYYY-MM-DD HH:MM`. */
  localStart: string;
  locationId: string;
  locationName: string;
  instructorName: string | null;
  capacity: number | null;
  going: number;
  waitlisted: number;
  checkedIn: number;
  status: 'scheduled' | 'cancelled';
  mine: boolean;
}

/**
 * The occurrences starting in the Sofia week beginning `monday`, for the grid.
 * Every staff role sees the timetable; `mine` marks a trainer's own classes.
 */
export async function weekOccurrences(
  actor: ClubActor,
  monday: IsoDate,
  locationId: string | null,
  days = 7,
): Promise<WeekOccurrence[]> {
  const result = await getDb().execute(sql`
    SELECT o.id, o.class_id, k.title, k.sport, o.starts_at, o.ends_at,
           to_char(o.starts_at_local, 'YYYY-MM-DD HH24:MI') AS local_start,
           k.location_id, l.name AS location_name,
           coalesce(nullif(btrim(sto.display_name), ''), nullif(btrim(uo.display_name), ''), nullif(btrim(stk.display_name), ''), nullif(btrim(uk.display_name), ''), split_part(coalesce(uo.email, uk.email), '@', 1)) AS instructor_name,
           coalesce(o.capacity, k.capacity) AS capacity, o.status,
           coalesce(o.instructor_user_id, k.instructor_user_id) = ${actor.userId} AS mine,
           (SELECT count(*) FILTER (WHERE bp.booking_status = 'going')::int FROM club_booking_positions bp
             WHERE bp.club_id = o.club_id AND bp.occurrence_id = o.id) AS going,
           (SELECT count(*) FILTER (WHERE bp.booking_status = 'waitlisted')::int FROM club_booking_positions bp
             WHERE bp.club_id = o.club_id AND bp.occurrence_id = o.id) AS waitlisted,
           (SELECT count(*)::int FROM club_checkins ci WHERE ci.club_id = o.club_id AND ci.occurrence_id = o.id)
             AS checked_in
      FROM club_class_occurrences o
      JOIN club_classes k ON k.id = o.class_id
      JOIN club_locations l ON l.id = k.location_id
      LEFT JOIN club_staff sto ON sto.club_id = o.club_id AND sto.user_id = o.instructor_user_id
      LEFT JOIN users uo ON uo.id = o.instructor_user_id
      LEFT JOIN club_staff stk ON stk.club_id = k.club_id AND stk.user_id = k.instructor_user_id
      LEFT JOIN users uk ON uk.id = k.instructor_user_id
     WHERE ${clubScope(actor, 'schedule.view', 'o')}
       AND o.starts_at >= (${monday}::date::timestamp AT TIME ZONE 'Europe/Sofia')
       AND o.starts_at < ((${monday}::date + ${days}::int)::timestamp AT TIME ZONE 'Europe/Sofia')
       ${locationId ? sql`AND k.location_id = ${locationId}::uuid` : sql``}
     ORDER BY o.starts_at, k.title
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    classId: String(row.class_id),
    title: String(row.title),
    sport: String(row.sport) as ClubSport,
    startsAt: new Date(String(row.starts_at)).toISOString(),
    endsAt: new Date(String(row.ends_at)).toISOString(),
    localStart: String(row.local_start),
    locationId: String(row.location_id),
    locationName: String(row.location_name),
    instructorName: text(row.instructor_name),
    capacity: row.capacity === null ? null : Number(row.capacity),
    going: Number(row.going ?? 0),
    waitlisted: Number(row.waitlisted ?? 0),
    checkedIn: Number(row.checked_in ?? 0),
    status: row.status === 'cancelled' ? 'cancelled' : 'scheduled',
    mine: row.mine === true,
  }));
}

export interface RosterPerson {
  memberId: string;
  displayName: string;
  isMinor: boolean;
  /** going / waitlisted (a booking), or walk_in (checked in without one). */
  kind: 'going' | 'waitlisted' | 'walk_in';
  position: number | null;
  bookingId: string | null;
  checkedIn: boolean;
  checkinMethod: ClubCheckinMethod | null;
  /** Front of house only: whether a live abonnement covers this person. */
  covered: boolean | null;
  isTrial: boolean;
}

export interface Roster {
  occurrenceId: string;
  classId: string;
  title: string;
  sport: ClubSport;
  startsAt: string;
  endsAt: string;
  localStart: string;
  locationId: string;
  locationName: string;
  instructorName: string | null;
  capacity: number | null;
  status: 'scheduled' | 'cancelled';
  people: RosterPerson[];
}

/**
 * The roster of one occurrence. `full` (front of house) adds whether each
 * person is covered; a trainer's projection never selects anything beyond a
 * display name and the minor flag.
 */
export async function occurrenceRoster(
  actor: ClubActor,
  occurrenceId: string,
  full: boolean,
): Promise<Roster | null> {
  const db = getDb();
  const header = await db.execute(sql`
    SELECT o.id, o.class_id, k.title, k.sport, o.starts_at, o.ends_at,
           to_char(o.starts_at_local, 'YYYY-MM-DD HH24:MI') AS local_start, k.location_id,
           l.name AS location_name, coalesce(o.capacity, k.capacity) AS capacity, o.status,
           coalesce(nullif(btrim(sto.display_name), ''), nullif(btrim(uo.display_name), ''), nullif(btrim(stk.display_name), ''), nullif(btrim(uk.display_name), ''), split_part(coalesce(uo.email, uk.email), '@', 1)) AS instructor_name
      FROM club_class_occurrences o
      JOIN club_classes k ON k.id = o.class_id
      JOIN club_locations l ON l.id = k.location_id
      LEFT JOIN club_staff sto ON sto.club_id = o.club_id AND sto.user_id = o.instructor_user_id
      LEFT JOIN users uo ON uo.id = o.instructor_user_id
      LEFT JOIN club_staff stk ON stk.club_id = k.club_id AND stk.user_id = k.instructor_user_id
      LEFT JOIN users uk ON uk.id = k.instructor_user_id
     WHERE o.id = ${occurrenceId}::uuid
       AND ${occurrenceStaffScope(actor, { all: 'roster.view', own: 'roster.view_own' })}
  `);
  const h = header.rows[0];
  if (!h) return null;
  const people = full
    ? await rosterForDesk(db, actor.clubId, occurrenceId)
    : await rosterForTrainer(db, actor.clubId, occurrenceId);
  return {
    occurrenceId: String(h.id),
    classId: String(h.class_id),
    title: String(h.title),
    sport: String(h.sport) as ClubSport,
    startsAt: new Date(String(h.starts_at)).toISOString(),
    endsAt: new Date(String(h.ends_at)).toISOString(),
    localStart: String(h.local_start),
    locationId: String(h.location_id),
    locationName: String(h.location_name),
    instructorName: text(h.instructor_name),
    capacity: h.capacity === null ? null : Number(h.capacity),
    status: h.status === 'cancelled' ? 'cancelled' : 'scheduled',
    people,
  };
}

const ROSTER_ORDER = sql`ORDER BY (kind = 'walk_in'), position NULLS LAST, lower(display_name)`;

/**
 * THE TRAINER'S PROJECTION. Only these columns, by construction — the
 * projections test greps this function for contact and money columns.
 */
export async function rosterForTrainer(
  db: SqlRunner,
  clubId: string,
  occurrenceId: string,
): Promise<RosterPerson[]> {
  const result = await db.execute(sql`
    SELECT * FROM (
      SELECT bp.member_id, m.display_name, m.is_minor,
             bp.booking_status AS kind, bp.position::int AS position, bp.booking_id, bp.is_trial,
             ci.method AS checkin_method
        FROM club_booking_positions bp
        JOIN club_members m ON m.club_id = bp.club_id AND m.id = bp.member_id
        LEFT JOIN club_checkins ci ON ci.club_id = bp.club_id AND ci.occurrence_id = bp.occurrence_id
                                  AND ci.member_id = bp.member_id
       WHERE bp.club_id = ${clubId}::uuid AND bp.occurrence_id = ${occurrenceId}::uuid
      UNION ALL
      SELECT ci.member_id, m.display_name, m.is_minor, 'walk_in', NULL, NULL, false, ci.method
        FROM club_checkins ci
        JOIN club_members m ON m.club_id = ci.club_id AND m.id = ci.member_id
       WHERE ci.club_id = ${clubId}::uuid AND ci.occurrence_id = ${occurrenceId}::uuid
         AND NOT EXISTS (SELECT 1 FROM club_bookings b WHERE b.occurrence_id = ci.occurrence_id
                            AND b.member_id = ci.member_id AND b.state = 'active')
    ) r ${ROSTER_ORDER}
  `);
  return result.rows.map((row) => toPerson(row, false));
}

async function rosterForDesk(
  db: SqlRunner,
  clubId: string,
  occurrenceId: string,
): Promise<RosterPerson[]> {
  const result = await db.execute(sql`
    SELECT r.*, EXISTS (
             SELECT 1 FROM club_membership_balances mb
              WHERE mb.club_id = ${clubId}::uuid AND mb.member_id = r.member_id
                AND mb.state = 'active') AS covered
      FROM (
        SELECT bp.member_id, m.display_name, m.is_minor,
               bp.booking_status AS kind, bp.position::int AS position, bp.booking_id, bp.is_trial,
               ci.method AS checkin_method
          FROM club_booking_positions bp
          JOIN club_members m ON m.club_id = bp.club_id AND m.id = bp.member_id
          LEFT JOIN club_checkins ci ON ci.club_id = bp.club_id AND ci.occurrence_id = bp.occurrence_id
                                    AND ci.member_id = bp.member_id
         WHERE bp.club_id = ${clubId}::uuid AND bp.occurrence_id = ${occurrenceId}::uuid
        UNION ALL
        SELECT ci.member_id, m.display_name, m.is_minor, 'walk_in', NULL, NULL, false, ci.method
          FROM club_checkins ci
          JOIN club_members m ON m.club_id = ci.club_id AND m.id = ci.member_id
         WHERE ci.club_id = ${clubId}::uuid AND ci.occurrence_id = ${occurrenceId}::uuid
           AND NOT EXISTS (SELECT 1 FROM club_bookings b WHERE b.occurrence_id = ci.occurrence_id
                              AND b.member_id = ci.member_id AND b.state = 'active')
      ) r ${ROSTER_ORDER}
  `);
  return result.rows.map((row) => toPerson(row, true));
}

function toPerson(row: Record<string, unknown>, full: boolean): RosterPerson {
  const kind =
    row.kind === 'waitlisted' ? 'waitlisted' : row.kind === 'walk_in' ? 'walk_in' : 'going';
  return {
    memberId: String(row.member_id),
    displayName: String(row.display_name),
    isMinor: row.is_minor === true,
    kind,
    position: row.position === null ? null : Number(row.position),
    bookingId: text(row.booking_id),
    checkedIn: row.checkin_method !== null && row.checkin_method !== undefined,
    checkinMethod: (text(row.checkin_method) as ClubCheckinMethod | null) ?? null,
    covered: full ? row.covered === true : null,
    isTrial: row.is_trial === true,
  };
}
