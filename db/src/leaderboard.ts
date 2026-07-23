import { instantToWall, SOFIA_TZ, zonedToInstant } from '@sportkarta/lib/recurrence';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Public leaderboards — national, per city, per sport (docs/ROADMAP.md §7,
 * Stage 5.2).
 *
 * WHO CAN APPEAR IS NOT DECIDED HERE. Every query below joins
 * `leaderboard_eligible_members` (migration 0011) instead of `users`, and that
 * view is the single definition: not a minor (a binding legal constant), has
 * opted their passport public (appearing on a ranked public list is individual
 * public exposure, and consent for it is the same opt-in that publishes a
 * passport), and has a handle to link to.
 *
 * The point of the view is that this file cannot get it wrong, and neither can
 * the next slice somebody adds. If a fourth dimension arrives — per quarter,
 * per age group, per season — it joins the view and inherits the rule without
 * its author needing to know the rule exists. Widening the view is the only way
 * to break that, which is why it says so in its own COMMENT and why
 * db/src/leaderboard-authz.test.ts attacks it directly.
 *
 * WHAT IS RANKED: points from `points_ledger`, which is contribution-scoped and
 * already anti-farmed by its idempotency keys (one award per facility added,
 * per person per facility verified, per person per facility per Sofia day for
 * conditions). A leaderboard is the strongest incentive this product has ever
 * created to game that ledger, and the defence is that the ledger was designed
 * not to be gameable before anything was ranking it.
 *
 * Check-ins are deliberately NOT ranked. They are self-attested until Stage
 * 4.3's signed QR exists, so ranking them would be ranking a claim.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export type LeaderboardScope =
  | { kind: 'national' }
  | { kind: 'city'; municipalityId: number }
  | { kind: 'sport'; sport: string };

/**
 * `month` is the current SOFIA civil month, not the last 30 days: a board that
 * silently re-bases every night gives no one a finish line. An all-time board
 * alone would freeze early adopters at the top forever, which is why both exist.
 */
export type LeaderboardPeriod = 'all_time' | 'month';

export interface LeaderboardEntry {
  /** Competition ranking: ties share a rank and the next rank skips. */
  rank: number;
  /** Public passport handle — the link target. Never the account id. */
  handle: string;
  displayName: string;
  homeCity: string | null;
  points: number;
  contributions: number;
}

export interface LeaderboardOptions {
  scope?: LeaderboardScope;
  period?: LeaderboardPeriod;
  limit?: number;
  /** Injected in tests so "this month" is not the wall clock. */
  now?: Date;
  timeZone?: string;
}

/** First instant of the current civil month in `timeZone`. */
export function monthStart(now: Date, timeZone: string = SOFIA_TZ): Date {
  const wall = instantToWall(now.getTime(), timeZone);
  return new Date(
    zonedToInstant({ year: wall.year, month: wall.month, day: 1, hour: 0, minute: 0 }, timeZone)
      .instantMs,
  );
}

/** The scope predicate, as SQL. `national` adds nothing. */
function scopeFilter(scope: LeaderboardScope): SQL {
  switch (scope.kind) {
    case 'national':
      return sql``;
    case 'city':
      return sql` AND f.municipality_id = ${scope.municipalityId}`;
    case 'sport':
      // A multi-sport pitch counts towards each of its sports, which is the
      // honest reading: work on a combined court is work on the football court.
      return sql` AND ${scope.sport} = ANY(f.sport_types)`;
  }
}

function periodFilter(period: LeaderboardPeriod, now: Date, timeZone: string): SQL {
  return period === 'all_time'
    ? sql``
    : sql` AND p.created_at >= ${monthStart(now, timeZone).toISOString()}::timestamptz`;
}

/**
 * A ranked page of the board.
 *
 * Ties share a rank (`rank()`, not `row_number()`): two members on 40 points
 * are both second, and telling them apart would mean inventing a difference
 * that is not there. The ORDER BY breaks the display tie by who reached the
 * total first — deterministic, and fairer than an arbitrary id ordering that
 * would silently favour whoever's random id sorted lower.
 */
export async function leaderboard(
  db: SqlRunner,
  options: LeaderboardOptions = {},
): Promise<LeaderboardEntry[]> {
  const scope = options.scope ?? { kind: 'national' };
  const period = options.period ?? 'all_time';
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const result = await db.execute(sql`
    SELECT
      m.public_handle AS handle,
      m.display_name  AS display_name,
      m.home_city     AS home_city,
      sum(p.points)::int  AS points,
      count(*)::int       AS contributions,
      rank() OVER (ORDER BY sum(p.points) DESC)::int AS rank
    FROM points_ledger p
    -- The view, never the users table: eligibility (minor / consent) is defined
    -- once, in migration 0011, and this join is how it gets enforced.
    JOIN leaderboard_eligible_members m ON m.id = p.user_id
    JOIN facilities f ON f.id = p.facility_id
    WHERE true
      ${scopeFilter(scope)}
      ${periodFilter(period, options.now ?? new Date(), timeZone)}
    GROUP BY m.id, m.public_handle, m.display_name, m.home_city
    ORDER BY points DESC, min(p.created_at) ASC
    LIMIT ${limit}
  `);

  return result.rows.map((row) => ({
    rank: Number(row.rank),
    handle: String(row.handle),
    displayName: String(row.display_name ?? ''),
    homeCity: row.home_city === null ? null : String(row.home_city),
    points: Number(row.points),
    contributions: Number(row.contributions),
  }));
}

export interface MemberStanding {
  rank: number;
  points: number;
  contributions: number;
  /** How many eligible members are on this board at all. */
  total: number;
}

/**
 * One member's own position — including well past the visible page, so someone
 * ranked 340th can still find out.
 *
 * Returns null when the member is not eligible. That covers minors and members
 * who have not published their passport, and the caller distinguishes them from
 * the profile it already holds rather than being told here: this function is
 * not the right place to explain a legal rule.
 */
export async function memberStanding(
  db: SqlRunner,
  userId: string,
  options: LeaderboardOptions = {},
): Promise<MemberStanding | null> {
  const scope = options.scope ?? { kind: 'national' };
  const period = options.period ?? 'all_time';
  const timeZone = options.timeZone ?? SOFIA_TZ;

  const result = await db.execute(sql`
    WITH board AS (
      SELECT
        m.id AS user_id,
        sum(p.points)::int AS points,
        count(*)::int AS contributions,
        rank() OVER (ORDER BY sum(p.points) DESC)::int AS rank
      FROM points_ledger p
      JOIN leaderboard_eligible_members m ON m.id = p.user_id
      JOIN facilities f ON f.id = p.facility_id
      WHERE true
        ${scopeFilter(scope)}
        ${periodFilter(period, options.now ?? new Date(), timeZone)}
      GROUP BY m.id
    )
    SELECT rank, points, contributions, (SELECT count(*)::int FROM board) AS total
    FROM board WHERE user_id = ${userId}
  `);

  const row = result.rows[0];
  if (!row) return null;
  return {
    rank: Number(row.rank),
    points: Number(row.points),
    contributions: Number(row.contributions),
    total: Number(row.total),
  };
}

/** Cities that have at least one ranked contribution — the board's own menu. */
export async function leaderboardCities(
  db: SqlRunner,
): Promise<{ municipalityId: number; members: number }[]> {
  const result = await db.execute(sql`
    SELECT f.municipality_id AS municipality_id, count(DISTINCT m.id)::int AS members
    FROM points_ledger p
    JOIN leaderboard_eligible_members m ON m.id = p.user_id
    JOIN facilities f ON f.id = p.facility_id
    WHERE f.municipality_id IS NOT NULL
    GROUP BY f.municipality_id
    HAVING count(DISTINCT m.id) > 0
    ORDER BY members DESC, f.municipality_id
  `);
  return result.rows.map((row) => ({
    municipalityId: Number(row.municipality_id),
    members: Number(row.members),
  }));
}
