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

export interface PointsSummary {
  total: number;
  entries: {
    event: PointsEvent;
    points: number;
    facilityId: string;
    facilityName: string | null;
    facilitySlug: string | null;
    createdAt: string;
  }[];
}

/**
 * A member's own score and recent contributions. Deliberately per-user and
 * never a ranking: ranking anybody publicly needs their opt-in, which lives in
 * `leaderboard_eligible_members`, so a page about one member reads their own
 * history and never other people's positions.
 */
export async function pointsSummary(
  db: SqlRunner,
  userId: string,
  limit = 10,
): Promise<PointsSummary> {
  const totalResult = await db.execute(sql`
    SELECT coalesce(sum(points), 0)::int AS total FROM points_ledger WHERE user_id = ${userId}
  `);
  const entriesResult = await db.execute(sql`
    SELECT p.event, p.points, p.facility_id, p.created_at, f.name, f.slug
    FROM points_ledger p
    LEFT JOIN facilities f ON f.id = p.facility_id
    WHERE p.user_id = ${userId}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ${limit}
  `);

  return {
    total: Number(totalResult.rows[0]?.total ?? 0),
    entries: entriesResult.rows.map((row) => ({
      event: row.event as PointsEvent,
      points: Number(row.points),
      facilityId: String(row.facility_id),
      facilityName: (row.name as string | null) ?? null,
      facilitySlug: (row.slug as string | null) ?? null,
      createdAt: String(row.created_at),
    })),
  };
}
