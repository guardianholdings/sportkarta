import { sql, type SQL } from '@sportkarta/db';
import { isConditionState, normalizeConditionTags, type ConditionState } from '@sportkarta/lib';

import { awardPoints } from '../points';
import {
  type Coordinates,
  distanceToGeomSql,
  isOnSite,
  parseCoordinates,
} from './proximity';

import { ContributionError } from './errors';

/**
 * Condition reports (docs/ROADMAP.md §5, "condition layer").
 *
 * Each report is kept as history in facility_condition_reports, the latest one
 * is denormalised onto facilities.condition so the map never scans history, and
 * the change is audited in facility_edits like any other field change.
 *
 * A photo is optional here — unlike adding a facility. Requiring one would
 * suppress exactly the quick "the net is gone" reports this layer exists for.
 */

export interface ConditionReportInput {
  state: string;
  tags: readonly unknown[];
  /** Storage key of an already-processed (EXIF-stripped) photo, if any. */
  photoStoragePath?: string | null;
}

export interface ConditionReportResult {
  /** Metres from the facility, or null when no position was offered. */
  distanceM?: number | null;
  /** Whether the reporter was close enough to repaint the live condition. */
  onSite?: boolean;
  reportId: string;
  state: ConditionState;
  tags: string[];
  /** null when this is the first report for the facility. */
  previousState: ConditionState | null;
  awarded: boolean;
}

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export async function reportCondition(
  db: TransactionalDb,
  params: {
    userId: string;
    facilityId: string;
    input: ConditionReportInput;
    /** Where the reporter was standing, if they offered it. */
    position?: { lat: unknown; lon: unknown } | null;
    now?: Date;
  },
): Promise<ConditionReportResult> {
  if (!isConditionState(params.input.state)) throw new ContributionError('invalid_state');
  const state = params.input.state;
  const tags = normalizeConditionTags(params.input.tags);
  const coords: Coordinates | null = params.position
    ? parseCoordinates(params.position.lat, params.position.lon)
    : null;

  return db.transaction(async (tx) => {
    const existing = await tx.execute(sql`
      SELECT condition, ${distanceToGeomSql(sql`geom`, coords)} AS distance_m
      FROM facilities WHERE id = ${params.facilityId}::uuid
    `);
    const row = existing.rows[0];
    if (!row) throw new ContributionError('facility_not_found');
    const previousState = (row.condition as ConditionState | null) ?? null;
    const distanceM =
      row.distance_m === null || row.distance_m === undefined ? null : Number(row.distance_m);
    const onSite = isOnSite(distanceM);

    let photoId: string | null = null;
    if (params.input.photoStoragePath) {
      const photo = await tx.execute(sql`
        INSERT INTO facility_photos (facility_id, storage_path, status, uploaded_by)
        VALUES (${params.facilityId}::uuid, ${params.input.photoStoragePath}, 'pending', ${params.userId})
        RETURNING id
      `);
      photoId = (photo.rows[0]?.id as string | undefined) ?? null;
    }

    const inserted = await tx.execute(sql`
      INSERT INTO facility_condition_reports (facility_id, reporter_id, state, tags, photo_id)
      VALUES (${params.facilityId}::uuid, ${params.userId}, ${state}::facility_condition,
              ${sql.param(tags)}::text[], ${photoId})
      RETURNING id
    `);
    const reportId = String(inserted.rows[0]?.id);

    /**
     * THE REPORT IS ALWAYS RECORDED; ONLY THE LIVE CONDITION IS GATED.
     *
     * "The newest report wins" is right for a right-now fact, and it is exactly
     * what made this the cheapest way to mislead the map: one remote submission
     * repaints a working pitch as unusable for everybody. So the row above
     * always lands — it is public-interest data and a moderator needs to see it
     * — but the facility's own `condition` is only repainted by somebody who was
     * standing there. A remote report sits in the history with its distance
     * until a human or an on-site reporter confirms it.
     */
    if (onSite) {
      await tx.execute(sql`
        UPDATE facilities
        SET condition = ${state}::facility_condition, condition_reported_at = now()
        WHERE id = ${params.facilityId}::uuid
      `);
    }

    if (previousState !== state) {
      await tx.execute(sql`
        INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value, distance_m)
        VALUES (${params.facilityId}::uuid, ${params.userId}, 'crowd', 'condition',
                ${JSON.stringify(previousState)}::jsonb, ${JSON.stringify(state)}::jsonb,
                ${distanceM})
      `);
    }

    const awarded = onSite
      ? await awardPoints(tx, {
          userId: params.userId,
          event: 'condition_reported',
          facilityId: params.facilityId,
          ...(params.now ? { now: params.now } : {}),
        })
      : false;

    return { reportId, state, tags, previousState, awarded, distanceM, onSite };
  });
}
