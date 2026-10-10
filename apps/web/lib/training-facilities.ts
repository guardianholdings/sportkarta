import { sql, type SQL } from '@sportkarta/db';

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Long enough for "where do I usually go"; short enough to scan on a phone. */
export const MEMBER_FACILITIES_LIMIT = 30;

/**
 * The training form's place picker: the member's OWN places, most recent first.
 *
 * "Own" means somewhere they have been, by their own record: a training they
 * logged there, a contribution they made to it (every one is a `points_ledger`
 * row carrying the facility), or a session they checked in at. The picker used
 * to offer the 100 most recently UPDATED facilities nationwide — whatever an
 * import or a stranger touched last, in any town — under a comment promising
 * exactly this list (UX audit 2026-10-10, S-5).
 *
 * EVERY BRANCH IS KEYED BY THE MEMBER. This list is somebody's pattern of life
 * and is shown only to them, on a page behind requireUser(); a branch that
 * forgot its `user_id` predicate would put other people's places in it. A place
 * that is not here is what the field's «not at a facility from the map» option
 * is for — the field stays optional.
 */
export async function memberFacilities(
  db: SqlRunner,
  userId: string,
  limit: number = MEMBER_FACILITIES_LIMIT,
): Promise<{ id: string; name: string }[]> {
  const result = await db.execute(sql`
    WITH visits AS (
      SELECT t.facility_id, t.started_at AS at
        FROM training_logs t
       WHERE t.user_id = ${userId} AND t.facility_id IS NOT NULL
      UNION ALL
      SELECT p.facility_id, p.created_at AS at
        FROM points_ledger p
       WHERE p.user_id = ${userId}
      UNION ALL
      SELECT s.facility_id, c.checked_in_at AS at
        FROM play_session_checkins c
        JOIN play_session_occurrences o ON o.id = c.occurrence_id
        JOIN play_sessions s ON s.id = o.session_id
       WHERE c.user_id = ${userId}
    ), latest AS (
      SELECT facility_id, max(at) AS at FROM visits GROUP BY facility_id
    )
    SELECT f.id::text AS id, f.name
      FROM latest l
      JOIN facilities f ON f.id = l.facility_id
     WHERE f.status <> 'gone' AND f.name IS NOT NULL AND btrim(f.name) <> ''
     ORDER BY l.at DESC, f.name
     LIMIT ${limit}
  `);
  return result.rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
}
