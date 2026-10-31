import { getDb, sql, type SQL } from '@sportkarta/db';

import { recordClubAudit } from './audit';
import { pgError, violatedConstraint } from './errors';
import type { ClubResourceKind, DayHours, ResourceInput } from './input';
import { clubActorMay, clubScope, clubWriteScope, type ClubActor } from './scope';

/**
 * Courts, rooms and equipment, and when a location is open (0048, wave C).
 * The resources and hours are settings (settings.manage); closing a court for
 * maintenance is a schedule act (schedule.manage). Every write embeds the
 * actor's scope, and a block that would overlap a booking is refused by the
 * calendar's EXCLUDE constraint, never by a check here.
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

export interface ClubResource {
  id: string;
  locationId: string;
  locationName: string;
  kind: ClubResourceKind;
  name: string;
  quantity: number;
  sortOrder: number;
  archived: boolean;
}

export async function clubResources(
  actor: ClubActor,
  options: { includeArchived?: boolean } = {},
): Promise<ClubResource[]> {
  const result = await getDb().execute(sql`
    SELECT rs.id, rs.location_id, l.name AS location_name, rs.kind, rs.name, rs.quantity,
           rs.sort_order, rs.archived_at IS NOT NULL AS archived
      FROM club_resources rs
      JOIN club_locations l ON l.club_id = rs.club_id AND l.id = rs.location_id
     WHERE ${clubScope(actor, 'schedule.view', 'rs')}
       AND ${options.includeArchived ? sql`true` : sql`rs.archived_at IS NULL`}
     ORDER BY l.sort_order, l.name, rs.sort_order, rs.name
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    locationId: String(row.location_id),
    locationName: String(row.location_name),
    kind: String(row.kind) as ClubResourceKind,
    name: String(row.name),
    quantity: Number(row.quantity),
    sortOrder: Number(row.sort_order),
    archived: row.archived === true,
  }));
}

/**
 * A change the calendar refuses: a pool shrunk below what is already booked
 * at one moment (or made exclusive over overlapping bookings), a room moved
 * away from the location of a class that uses it, or a resource with future
 * bookings moved to another location or archived.
 */
export class ResourceChangeRefused extends Error {
  constructor(readonly code: 'quantity_conflict' | 'room_in_use' | 'resource_busy') {
    super(code);
  }
}

/**
 * The resource is in use from now on: live claims (bookings, class dates,
 * closures), or a running class that will keep claiming it on dates beyond
 * the materialised horizon.
 */
const FUTURE_CLAIMS = sql`(EXISTS (SELECT 1 FROM club_calendar_claims c
                                    WHERE c.club_id = rs.club_id AND c.resource_id = rs.id
                                      AND upper(c.during) > now())
                           OR EXISTS (SELECT 1 FROM club_classes k
                                       WHERE k.club_id = rs.club_id AND k.resource_id = rs.id
                                         AND k.status = 'scheduled'))`;

/**
 * Create (id null) or edit a resource. settings.manage on a writable club.
 * Moving it to another location drops its links to services there were at
 * the old one; with future bookings it cannot move at all.
 */
export async function saveResource(
  db: TransactionalDb,
  actor: ClubActor,
  resourceId: string | null,
  input: ResourceInput,
): Promise<string | null> {
  try {
    return await saveResourceOnce(db, actor, resourceId, input);
  } catch (error: unknown) {
    const constraint = violatedConstraint(error);
    if (
      constraint === 'club_calendar_claims_pool_full' ||
      constraint === 'club_calendar_claims_resource_free'
    ) {
      throw new ResourceChangeRefused('quantity_conflict');
    }
    if (constraint === 'club_classes_resource_fk') throw new ResourceChangeRefused('room_in_use');
    // A booking taking this resource at the same instant: rare, and safe to retry.
    if (pgError(error)?.code === '40P01') throw new ResourceChangeRefused('resource_busy');
    throw error;
  }
}

async function saveResourceOnce(
  db: TransactionalDb,
  actor: ClubActor,
  resourceId: string | null,
  input: ResourceInput,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    if (resourceId !== null) {
      const moving = await tx.execute(sql`
        SELECT ${FUTURE_CLAIMS} AS busy FROM club_resources rs
         WHERE rs.id = ${resourceId}::uuid AND rs.location_id <> ${input.locationId}::uuid
           AND ${clubScope(actor, 'settings.manage', 'rs')}
      `);
      if (moving.rows[0]?.busy === true) throw new ResourceChangeRefused('resource_busy');
    }
    const saved = await tx.execute(
      resourceId === null
        ? sql`
            INSERT INTO club_resources (club_id, location_id, kind, name, quantity, sort_order)
            SELECT l.club_id, l.id, ${input.kind}, ${input.name}, ${input.quantity}, ${input.sortOrder}
              FROM club_locations l
             WHERE l.club_id = ${actor.clubId}::uuid AND l.id = ${input.locationId}::uuid
               AND ${clubActorMay(actor, 'settings.manage', { write: true })}
            RETURNING id`
        : sql`
            UPDATE club_resources rs
               SET location_id = ${input.locationId}::uuid, kind = ${input.kind},
                   name = ${input.name}, quantity = ${input.quantity}, sort_order = ${input.sortOrder}
             WHERE rs.id = ${resourceId}::uuid
               AND ${clubWriteScope(actor, 'settings.manage', 'rs')}
            RETURNING rs.id`,
    );
    const id = text(saved.rows[0]?.id);
    if (!id) return null;
    await tx.execute(sql`
      DELETE FROM club_service_resources x
       USING club_services sv
       WHERE x.club_id = ${actor.clubId}::uuid AND x.resource_id = ${id}::uuid
         AND sv.club_id = x.club_id AND sv.id = x.service_id
         AND sv.location_id <> ${input.locationId}::uuid
         AND ${clubActorMay(actor, 'settings.manage', { write: true })}
    `);
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'resource_saved',
      detail: { resourceId: id },
    });
    return id;
  });
}

/**
 * Archive or restore. A resource with future bookings, classes or closures
 * is not archived — its lane would vanish from the calendar while its claims
 * still stand, out of the office's sight.
 */
export async function setResourceArchived(
  db: TransactionalDb,
  actor: ClubActor,
  resourceId: string,
  archived: boolean,
): Promise<'ok' | 'not_found' | 'busy'> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_resources rs SET archived_at = ${archived ? sql`now()` : sql`NULL`}
       WHERE rs.id = ${resourceId}::uuid AND (rs.archived_at IS NULL) = ${archived}
         AND ${clubWriteScope(actor, 'settings.manage', 'rs')}
         AND ${archived ? sql`NOT ${FUTURE_CLAIMS}` : sql`true`}
      RETURNING rs.id
    `);
    if (updated.rows.length === 0) {
      const busy = await tx.execute(sql`
        SELECT 1 FROM club_resources rs
         WHERE rs.id = ${resourceId}::uuid AND ${clubScope(actor, 'settings.manage', 'rs')}
           AND ${FUTURE_CLAIMS}
      `);
      return archived && busy.rows.length > 0 ? 'busy' : 'not_found';
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'resource_archived',
      detail: { resourceId, archived },
    });
    return 'ok';
  });
}

/** A location's week of opening hours (closed days are absent). */
export async function locationHours(actor: ClubActor, locationId: string): Promise<DayHours[]> {
  const result = await getDb().execute(sql`
    SELECT lh.weekday, to_char(lh.opens, 'HH24:MI') AS opens, to_char(lh.closes, 'HH24:MI') AS closes
      FROM club_location_hours lh
     WHERE ${clubScope(actor, 'schedule.view', 'lh')} AND lh.location_id = ${locationId}::uuid
     ORDER BY lh.weekday
  `);
  return result.rows.map((row) => ({
    weekday: Number(row.weekday),
    opens: String(row.opens),
    closes: String(row.closes),
  }));
}

/** Replace a location's opening hours. settings.manage on a writable club. */
export async function saveLocationHours(
  db: TransactionalDb,
  actor: ClubActor,
  locationId: string,
  days: readonly DayHours[],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const allowed = await tx.execute(sql`
      SELECT 1 FROM club_locations l
       WHERE l.club_id = ${actor.clubId}::uuid AND l.id = ${locationId}::uuid
         AND ${clubActorMay(actor, 'settings.manage', { write: true })}
         FOR NO KEY UPDATE OF l
    `);
    if (allowed.rows.length === 0) return false;
    await tx.execute(sql`
      DELETE FROM club_location_hours lh
       WHERE lh.location_id = ${locationId}::uuid
         AND ${clubWriteScope(actor, 'settings.manage', 'lh')}
    `);
    for (const day of days) {
      await tx.execute(sql`
        INSERT INTO club_location_hours (club_id, location_id, weekday, opens, closes)
        SELECT ${actor.clubId}::uuid, ${locationId}::uuid, ${day.weekday}, ${day.opens}::time,
               ${day.closes}::time
         WHERE ${clubActorMay(actor, 'settings.manage', { write: true })}
      `);
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'hours_saved',
      detail: { locationId, days: days.length },
    });
    return true;
  });
}

export interface ResourceBlock {
  id: string;
  resourceId: string;
  resourceName: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  /** The event that closes the resource (0053): removed with the event, not here. */
  eventId: string | null;
}

export async function upcomingResourceBlocks(actor: ClubActor): Promise<ResourceBlock[]> {
  const result = await getDb().execute(sql`
    SELECT tb.id, tb.resource_id, rs.name, tb.starts_at, tb.ends_at, tb.reason, tb.event_id
      FROM club_time_blocks tb
      JOIN club_resources rs ON rs.club_id = tb.club_id AND rs.id = tb.resource_id
     WHERE ${clubScope(actor, 'schedule.view', 'tb')} AND tb.ends_at > now()
     ORDER BY tb.starts_at
     LIMIT 100
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    resourceId: String(row.resource_id),
    resourceName: String(row.name),
    startsAt: new Date(String(row.starts_at)).toISOString(),
    endsAt: new Date(String(row.ends_at)).toISOString(),
    reason: String(row.reason),
    eventId: row.event_id === null || row.event_id === undefined ? null : String(row.event_id),
  }));
}

/**
 * Close a resource for a stretch of time (maintenance, an event). Refused
 * with `conflict` when it would overlap a class, a booking or another block
 * there — the calendar's constraint decides, the office then moves those.
 */
export async function addResourceBlock(
  db: TransactionalDb,
  actor: ClubActor,
  input: { resourceId: string; startsAt: string; endsAt: string; reason: 'training' | 'other' },
): Promise<'ok' | 'not_allowed' | 'conflict'> {
  try {
    return await db.transaction(async (tx) => {
      const created = await tx.execute(sql`
        INSERT INTO club_time_blocks (club_id, resource_id, starts_at, ends_at, reason, created_by)
        SELECT rs.club_id, rs.id, ${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz,
               ${input.reason}, ${actor.userId}
          FROM club_resources rs
         WHERE rs.id = ${input.resourceId}::uuid AND rs.archived_at IS NULL
           AND ${clubWriteScope(actor, 'schedule.manage', 'rs')}
        RETURNING id
      `);
      if (created.rows.length === 0) return 'not_allowed' as const;
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'time_off_saved',
        detail: { resourceId: input.resourceId },
      });
      return 'ok' as const;
    });
  } catch (error: unknown) {
    const constraint = violatedConstraint(error);
    if (
      constraint === 'club_calendar_claims_resource_free' ||
      constraint === 'club_calendar_claims_pool_full'
    ) {
      return 'conflict';
    }
    throw error;
  }
}

/** An event's closure (0053) is the event's: it goes when the event is cancelled or moved. */
export async function removeResourceBlock(
  db: TransactionalDb,
  actor: ClubActor,
  blockId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx.execute(sql`
      DELETE FROM club_time_blocks tb
       WHERE tb.id = ${blockId}::uuid AND tb.resource_id IS NOT NULL
         AND tb.event_id IS NULL
         AND ${clubWriteScope(actor, 'schedule.manage', 'tb')}
      RETURNING tb.id
    `);
    if (removed.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'time_off_removed',
      detail: {},
    });
    return true;
  });
}
