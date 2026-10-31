import { getDb, sql, type SQL } from '@sportkarta/db';
import type { ClubPlanAudience, PriceRule } from '@sportkarta/lib/clubs';

import { recordClubAudit } from './audit';
import type {
  ClubServiceKind,
  ClubServicePayment,
  DayHours,
  PriceRuleInput,
  ServiceInput,
} from './input';
import { clubActorMay, clubScope, clubWriteScope, type ClubActor } from './scope';

/**
 * What a club's members book (0048, wave C): rentals (a court for an hour or
 * two) and appointments (a personal trainer), the resources and trainers each
 * may use, peak / off-peak price rules, and the hours a trainer takes
 * appointments. All schedule.manage, every write scoped in its statement.
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

export interface ClubService {
  id: string;
  locationId: string;
  kind: ClubServiceKind;
  nameBg: string;
  nameEn: string | null;
  descriptionBg: string | null;
  descriptionEn: string | null;
  durationMin: number;
  durationMax: number;
  stepMinutes: number;
  bufferMinutes: number;
  priceUnit: 'hour' | 'booking';
  priceCents: number;
  memberPriceCents: number | null;
  bookingWindowDays: number;
  cancelDeadlineHours: number;
  maxUpcomingPerMember: number;
  payment: ClubServicePayment;
  audience: ClubPlanAudience;
  visibility: 'public' | 'private';
  archived: boolean;
  resourceIds: string[];
  staffUserIds: string[];
}

export const SERVICE_COLUMNS = sql.raw(`sv.id, sv.location_id, sv.kind, sv.name_bg, sv.name_en,
  sv.description_bg, sv.description_en, sv.duration_min, sv.duration_max, sv.step_minutes,
  sv.buffer_minutes, sv.price_unit, sv.price_cents, sv.member_price_cents,
  sv.booking_window_days, sv.cancel_deadline_hours, sv.max_upcoming_per_member, sv.payment,
  sv.audience, sv.visibility,
  sv.archived_at IS NOT NULL AS archived,
  ARRAY(SELECT x.resource_id::text FROM club_service_resources x
         WHERE x.club_id = sv.club_id AND x.service_id = sv.id ORDER BY x.resource_id) AS resource_ids,
  ARRAY(SELECT y.staff_user_id FROM club_service_staff y
         WHERE y.club_id = sv.club_id AND y.service_id = sv.id ORDER BY y.staff_user_id) AS staff_ids`);

export function toService(row: Record<string, unknown>): ClubService {
  return {
    id: String(row.id),
    locationId: String(row.location_id),
    kind: row.kind === 'appointment' ? 'appointment' : 'rental',
    nameBg: String(row.name_bg),
    nameEn: text(row.name_en),
    descriptionBg: text(row.description_bg),
    descriptionEn: text(row.description_en),
    durationMin: Number(row.duration_min),
    durationMax: Number(row.duration_max),
    stepMinutes: Number(row.step_minutes),
    bufferMinutes: Number(row.buffer_minutes),
    priceUnit: row.price_unit === 'booking' ? 'booking' : 'hour',
    priceCents: Number(row.price_cents),
    memberPriceCents: row.member_price_cents === null ? null : Number(row.member_price_cents),
    bookingWindowDays: Number(row.booking_window_days),
    cancelDeadlineHours: Number(row.cancel_deadline_hours),
    maxUpcomingPerMember: Number(row.max_upcoming_per_member),
    payment: String(row.payment) as ClubServicePayment,
    audience: String(row.audience) as ClubPlanAudience,
    visibility: row.visibility === 'private' ? 'private' : 'public',
    archived: row.archived === true,
    resourceIds: Array.isArray(row.resource_ids) ? row.resource_ids.map(String) : [],
    staffUserIds: Array.isArray(row.staff_ids) ? row.staff_ids.map(String) : [],
  };
}

export async function clubServices(
  actor: ClubActor,
  options: { includeArchived?: boolean } = {},
): Promise<ClubService[]> {
  const result = await getDb().execute(sql`
    SELECT ${SERVICE_COLUMNS}
      FROM club_services sv
     WHERE ${clubScope(actor, 'schedule.view', 'sv')}
       AND ${options.includeArchived ? sql`true` : sql`sv.archived_at IS NULL`}
     ORDER BY sv.sort_order, sv.name_bg
  `);
  return result.rows.map(toService);
}

/**
 * Create (id null) or edit a service, and replace which resources and
 * trainers it may use: only the club's own resources AT THE SERVICE'S
 * LOCATION, and only the club's own staff — anything else is dropped by the
 * statement, not trusted from the form.
 */
export async function saveService(
  db: TransactionalDb,
  actor: ClubActor,
  serviceId: string | null,
  input: ServiceInput,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    const values = sql`${input.locationId}::uuid, ${input.kind}, ${input.nameBg}, ${input.nameEn},
      ${input.descriptionBg}, ${input.descriptionEn}, ${input.durationMin}, ${input.durationMax},
      ${input.stepMinutes}, ${input.bufferMinutes}, ${input.priceUnit}, ${input.priceCents},
      ${input.memberPriceCents}, ${input.bookingWindowDays}, ${input.cancelDeadlineHours},
      ${input.maxUpcomingPerMember}, ${input.payment}, ${input.audience}, ${input.visibility}`;
    const saved = await tx.execute(
      serviceId === null
        ? sql`
            INSERT INTO club_services (club_id, location_id, kind, name_bg, name_en, description_bg,
                                       description_en, duration_min, duration_max, step_minutes,
                                       buffer_minutes, price_unit, price_cents, member_price_cents,
                                       booking_window_days, cancel_deadline_hours,
                                       max_upcoming_per_member, payment, audience, visibility)
            SELECT ${actor.clubId}::uuid, ${values}
             WHERE ${clubActorMay(actor, 'schedule.manage', { write: true })}
            RETURNING id`
        : sql`
            UPDATE club_services sv
               SET (location_id, kind, name_bg, name_en, description_bg, description_en,
                    duration_min, duration_max, step_minutes, buffer_minutes, price_unit,
                    price_cents, member_price_cents, booking_window_days, cancel_deadline_hours,
                    max_upcoming_per_member, payment, audience, visibility) = (${values})
             WHERE sv.id = ${serviceId}::uuid AND ${clubWriteScope(actor, 'schedule.manage', 'sv')}
            RETURNING sv.id`,
    );
    const id = text(saved.rows[0]?.id);
    if (!id) return null;
    await tx.execute(sql`
      DELETE FROM club_service_resources x
       WHERE x.club_id = ${actor.clubId}::uuid AND x.service_id = ${id}::uuid
         AND ${clubActorMay(actor, 'schedule.manage', { write: true })}
    `);
    await tx.execute(sql`
      INSERT INTO club_service_resources (club_id, service_id, resource_id)
      SELECT rs.club_id, ${id}::uuid, rs.id FROM club_resources rs
       WHERE rs.club_id = ${actor.clubId}::uuid AND rs.archived_at IS NULL
         AND rs.location_id = ${input.locationId}::uuid
         AND rs.id = ANY(${sql.param(input.resourceIds)}::uuid[])
         AND ${clubActorMay(actor, 'schedule.manage', { write: true })}
    `);
    await tx.execute(sql`
      DELETE FROM club_service_staff y
       WHERE y.club_id = ${actor.clubId}::uuid AND y.service_id = ${id}::uuid
         AND ${clubActorMay(actor, 'schedule.manage', { write: true })}
    `);
    await tx.execute(sql`
      INSERT INTO club_service_staff (club_id, service_id, staff_user_id)
      SELECT s.club_id, ${id}::uuid, s.user_id FROM club_staff s
       WHERE s.club_id = ${actor.clubId}::uuid
         AND s.user_id = ANY(${sql.param(input.staffUserIds)}::text[])
         AND ${clubActorMay(actor, 'schedule.manage', { write: true })}
    `);
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'service_saved',
      detail: { serviceId: id },
    });
    return id;
  });
}

export async function setServiceArchived(
  db: TransactionalDb,
  actor: ClubActor,
  serviceId: string,
  archived: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_services sv SET archived_at = ${archived ? sql`now()` : sql`NULL`}
       WHERE sv.id = ${serviceId}::uuid AND (sv.archived_at IS NULL) = ${archived}
         AND ${clubWriteScope(actor, 'schedule.manage', 'sv')}
      RETURNING sv.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'service_archived',
      detail: { serviceId, archived },
    });
    return true;
  });
}

export interface ClubPriceRule extends PriceRule {
  id: string;
  serviceId: string;
}

export async function priceRules(actor: ClubActor): Promise<ClubPriceRule[]> {
  const result = await getDb().execute(sql`
    SELECT pr.id, pr.service_id, pr.weekdays, to_char(pr.from_local, 'HH24:MI') AS from_local,
           to_char(pr.to_local, 'HH24:MI') AS to_local, pr.price_cents, pr.member_price_cents,
           pr.priority
      FROM club_price_rules pr
     WHERE ${clubScope(actor, 'schedule.view', 'pr')}
     ORDER BY pr.service_id, pr.priority DESC, pr.from_local
  `);
  return result.rows.map(toPriceRule);
}

export function toPriceRule(row: Record<string, unknown>): ClubPriceRule {
  return {
    id: String(row.id),
    serviceId: String(row.service_id),
    weekdays: Array.isArray(row.weekdays) ? row.weekdays.map(Number) : [],
    from: String(row.from_local),
    to: String(row.to_local),
    priceCents: Number(row.price_cents),
    memberPriceCents: row.member_price_cents === null ? null : Number(row.member_price_cents),
    priority: Number(row.priority),
  };
}

export async function addPriceRule(
  db: TransactionalDb,
  actor: ClubActor,
  serviceId: string,
  input: PriceRuleInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const created = await tx.execute(sql`
      INSERT INTO club_price_rules (club_id, service_id, weekdays, from_local, to_local,
                                    price_cents, member_price_cents, priority)
      SELECT sv.club_id, sv.id, ${sql.param(input.weekdays)}::smallint[], ${input.from}::time,
             ${input.to}::time, ${input.priceCents}, ${input.memberPriceCents}, ${input.priority}
        FROM club_services sv
       WHERE sv.id = ${serviceId}::uuid AND ${clubWriteScope(actor, 'schedule.manage', 'sv')}
      RETURNING id
    `);
    if (created.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'service_saved',
      detail: { serviceId, priceRule: 'added' },
    });
    return true;
  });
}

export async function removePriceRule(
  db: TransactionalDb,
  actor: ClubActor,
  ruleId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx.execute(sql`
      DELETE FROM club_price_rules pr
       WHERE pr.id = ${ruleId}::uuid AND ${clubWriteScope(actor, 'schedule.manage', 'pr')}
      RETURNING pr.service_id
    `);
    const serviceId = text(removed.rows[0]?.service_id);
    if (!serviceId) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'service_saved',
      detail: { serviceId, priceRule: 'removed' },
    });
    return true;
  });
}

export interface StaffHours extends DayHours {
  staffUserId: string;
  locationId: string;
}

export async function staffHours(actor: ClubActor): Promise<StaffHours[]> {
  const result = await getDb().execute(sql`
    SELECT sh.staff_user_id, sh.location_id, sh.weekday, to_char(sh.opens, 'HH24:MI') AS opens,
           to_char(sh.closes, 'HH24:MI') AS closes
      FROM club_staff_hours sh
     WHERE ${clubScope(actor, 'schedule.view', 'sh')}
     ORDER BY sh.staff_user_id, sh.location_id, sh.weekday
  `);
  return result.rows.map((row) => ({
    staffUserId: String(row.staff_user_id),
    locationId: String(row.location_id),
    weekday: Number(row.weekday),
    opens: String(row.opens),
    closes: String(row.closes),
  }));
}

/** Replace when a trainer takes appointments at one location. schedule.manage. */
export async function saveStaffHours(
  db: TransactionalDb,
  actor: ClubActor,
  staffUserId: string,
  locationId: string,
  days: readonly DayHours[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const allowed = await tx.execute(sql`
      SELECT 1 FROM club_staff s
        JOIN club_locations l ON l.club_id = s.club_id AND l.id = ${locationId}::uuid
       WHERE s.club_id = ${actor.clubId}::uuid AND s.user_id = ${staffUserId}
         AND ${clubActorMay(actor, 'schedule.manage', { write: true })}
    `);
    if (allowed.rows.length === 0) return false;
    await tx.execute(sql`
      DELETE FROM club_staff_hours sh
       WHERE sh.staff_user_id = ${staffUserId} AND sh.location_id = ${locationId}::uuid
         AND ${clubWriteScope(actor, 'schedule.manage', 'sh')}
    `);
    for (const day of days) {
      await tx.execute(sql`
        INSERT INTO club_staff_hours (club_id, staff_user_id, location_id, weekday, opens, closes)
        SELECT ${actor.clubId}::uuid, ${staffUserId}, ${locationId}::uuid, ${day.weekday},
               ${day.opens}::time, ${day.closes}::time
         WHERE ${clubActorMay(actor, 'schedule.manage', { write: true })}
      `);
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'hours_saved',
      detail: { locationId, staff: true, days: days.length },
    });
    return true;
  });
}
