import { sql, type SQL } from '@sportkarta/db';
import { awardKey, POINTS_BY_EVENT, type PointsEvent } from '@sportkarta/lib/points';

/**
 * Awarding points (docs/ROADMAP.md §5). Earning only — there is no spending
 * mechanic, so nothing here ever subtracts.
 *
 * Idempotency lives in the database, not in a check-then-insert: the key is
 * UNIQUE and the insert is ON CONFLICT DO NOTHING, so two concurrent requests
 * that both "see no award yet" still produce exactly one row. Call this inside
 * the same transaction as the contribution it pays for, so a rolled-back
 * contribution takes its award with it.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface AwardInput {
  userId: string;
  event: PointsEvent;
  facilityId: string;
  now?: Date;
}

/** True when this call created the award; false when it had already been earned. */
export async function awardPoints(db: SqlRunner, input: AwardInput): Promise<boolean> {
  const key = awardKey({
    event: input.event,
    facilityId: input.facilityId,
    userId: input.userId,
    ...(input.now ? { now: input.now } : {}),
  });
  const points = POINTS_BY_EVENT[input.event];

  const result = await db.execute(sql`
    INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key)
    VALUES (${input.userId}, ${input.event}::points_event, ${points}, ${input.facilityId}::uuid, ${key})
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id
  `);
  return result.rows.length > 0;
}
