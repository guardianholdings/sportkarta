import { sql, type SQL } from 'drizzle-orm';

/**
 * «Господар на игрището» — Local Legend per facility (docs/ENGAGEMENT.md B1).
 *
 * Most distinct Sofia days attended at one facility in a rolling 90 days. The
 * mechanic Strava proved and the one that actually fits this product: winnable
 * by a beginner because it rewards turning up rather than performance, it DECAYS
 * so it has to be defended, and it attaches identity to a PLACE — which is the
 * product's whole subject.
 *
 * WHAT THIS DELIBERATELY DOES NOT RETURN: a name.
 *
 * Operator decision, 2026-07-26. `/obekt/[slug]` is indexed — ~6,600 of them are
 * in the sitemap, and it cannot be noindex because it IS the SEO product.
 * Printing the holder's name there would publish a named person tied to one
 * place with a 90-day frequency count: a pattern-of-life disclosure on the one
 * page where the usual escape hatch is unavailable, and a different decision
 * from the one `/pasport` made when it chose noindex. So the facility page shows
 * the TITLE and the COUNT — "the most regular person here has come 12 times" —
 * which is a fact about the PLACE and an invitation, and names nobody.
 *
 * `holderUserId` is returned so a page can tell the HOLDER that they hold it.
 * Telling someone a fact about themselves is not public exposure; rendering that
 * id for anyone else is, and no caller may.
 *
 * ONLY `method = 'qr'` COUNTS. Migration 0014 made that the evidence tier by
 * CHECK: `self` is a button somebody tapped and `organizer` is somebody
 * vouching, and 0014 says in as many words that neither is evidence. Ranking
 * them would re-open the hole that CHECK closed. The accepted cost is real and
 * was decided knowingly: a member who reliably attends an organiser-run session
 * where nobody opens the QR screen can never hold the title of the place they
 * actually hold.
 *
 * DISTINCT SOFIA DAYS, not check-ins. The unique index on
 * (occurrence_id, user_id) already stops one occurrence counting twice, but two
 * occurrences on one day would. Counting days keeps the title a statement about
 * how often somebody comes rather than how many sessions happen to be scheduled.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Rolling window. Decays, so the title must be defended. */
export const LEGEND_WINDOW_DAYS = 90;

/**
 * Below this the title is not shown at all.
 *
 * Two reasons, and the second is the load-bearing one. A "legend" with one visit
 * is not a legend. And on a quiet facility a count of 1 attached to a title is
 * close to naming the single person who goes there — the same k-anonymity
 * reasoning behind CITY_BOARD_MIN_MEMBERS, applied to a place rather than a city.
 */
export const LEGEND_MIN_DAYS = 3;

export interface FacilityLegend {
  /** Distinct Sofia days the leader attended inside the window. */
  days: number;
  /**
   * The holder's ACCOUNT id — for telling the holder, and nobody else, that it
   * is theirs. Never render this, and never resolve it to a name for a viewer
   * who is not that person.
   */
  holderUserId: string;
}

/**
 * The current leader at one facility, or null when nobody qualifies.
 *
 * A live query rather than a materialized view: this reads ONE facility on a
 * page that is already dynamic, the window is a moving 90 days (so a view would
 * need refreshing to stay honest), and the whole corpus is 12k facilities of
 * which almost none have check-ins yet. If the facility page ever needs this at
 * list scale, that is the point to reach for a view — not before.
 *
 * Ties go to nobody in particular: `ORDER BY days DESC, user_id` is stable and
 * arbitrary, and since no name is shown the tie is invisible. When naming ever
 * arrives, the tie rule becomes a product decision (incumbent keeps it, versus
 * Strava's most-recent-to-reach-the-count, which flips weekly between regulars).
 */
export async function facilityLegend(
  db: SqlRunner,
  facilityId: string,
  now: Date = new Date(),
): Promise<FacilityLegend | null> {
  const result = await db.execute(sql`
    SELECT c.user_id::text AS user_id,
           count(DISTINCT (c.checked_in_at AT TIME ZONE 'Europe/Sofia')::date)::int AS days
      FROM play_session_checkins c
      JOIN play_session_occurrences o ON o.id = c.occurrence_id
      JOIN play_sessions s            ON s.id = o.session_id
     WHERE s.facility_id = ${facilityId}::uuid
       -- The evidence tier, by the same rule migration 0014 made a CHECK.
       AND c.method = 'qr'
       AND c.checked_in_at > ${now.toISOString()}::timestamptz
                             - ${`${String(LEGEND_WINDOW_DAYS)} days`}::interval
     GROUP BY c.user_id
    HAVING count(DISTINCT (c.checked_in_at AT TIME ZONE 'Europe/Sofia')::date) >= ${LEGEND_MIN_DAYS}
     ORDER BY days DESC, c.user_id
     LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return { days: Number(row.days), holderUserId: String(row.user_id) };
}
