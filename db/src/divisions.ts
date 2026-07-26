import {
  DIVISION_ACTIVE_WEEKS,
  DIVISION_MIN_MEMBERS,
  planDivisions,
  type DivisionAssignment,
  type DivisionCandidate,
} from '@sportkarta/lib/divisions';
import { previousBucketKey } from '@sportkarta/lib/badges';
import { addDays, SOFIA_TZ, zonedToInstant } from '@sportkarta/lib/recurrence';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Weekly divisions («дивизии») against the database — docs/ENGAGEMENT.md B2,
 * docs/ENGAGEMENT-IMPLEMENTATION.md phase 9.
 *
 * WHO CAN APPEAR IS NOT DECIDED HERE, exactly as in db/src/leaderboard.ts. Every
 * query below joins `leaderboard_eligible_members` (migration 0011, amended by
 * 0020) instead of `users`, and that view is the single definition of who has
 * consented to individual public exposure.
 *
 * It is joined TWICE across a division's life, and the second join is the one
 * people forget:
 *
 *  - AT ASSIGNMENT, so an unpublished member never occupies one of the thirty
 *    places. This is what operator decision 3 of 2026-07-26 chose over the
 *    anonymous-row variant.
 *  - AT DISPLAY, because a member may publish their passport on Monday and
 *    unpublish it on Wednesday. Without the second join their name would keep
 *    rendering all week on a page that had already been generated for them.
 *
 * RANKS ARE COMPUTED AFTER THE JOIN, never before. `db/src/campaigns.ts` states
 * the reason in its own comment and it applies unchanged here: ranking first and
 * filtering second produces 1, 2, 4, 7 — a board whose gaps advertise the
 * existence of hidden competitors, which is a disclosure about people who
 * declined to be disclosed.
 *
 * THE ROLLOVER RANKS EXACTLY WHAT THE LADDER SHOWED. `weekStandings` is one
 * function used by both the screen and the job, so a member who reads "6th, and
 * 7th promotes" on Sunday night gets promoted on Monday morning. Two queries of
 * "the same" ranking is how that promise quietly stops being true.
 *
 * WHAT IS RANKED: points earned inside the civil-Sofia week, from
 * `points_ledger` — operator decision 2026-07-26, reasoned in
 * lib/src/divisions/index.ts. The ledger already covers contributions AND
 * QR-verified attendance, it was hardened against farming before anything ranked
 * it, and it is the unit /klasirane already shows.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** `YYYY-MM-DD` — a Sofia Monday, as `bucketKeyFor(at, 'week')` produces it. */
export type WeekKey = string;

const WEEK_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The instant range a week key covers, `[from, to)`.
 *
 * Computed in TypeScript and bound as two timestamptz parameters, never as
 * `timezone('Europe/Sofia', created_at)` in the predicate: that expression is
 * STABLE rather than IMMUTABLE, so Postgres cannot use it in an index, and the
 * comparison would degrade `points_ledger_user_created_idx` into a sequential
 * scan of the whole ledger. It is also the repo-wide rule — every other
 * civil-Sofia boundary here is computed in TypeScript for the same reason.
 */
export function weekBounds(week: WeekKey, timeZone: string = SOFIA_TZ): { from: Date; to: Date } {
  const match = WEEK_KEY.exec(week);
  if (!match) throw new RangeError(`not a week key: ${week}`);
  const monday = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
  };
  return {
    from: new Date(zonedToInstant(monday, timeZone).instantMs),
    to: new Date(zonedToInstant(addDays(monday, 7), timeZone).instantMs),
  };
}

/**
 * Points earned by each member inside `[from, to)`, as a subquery.
 *
 * Driven from the eligibility view rather than from the ledger, which is both
 * the consent rule and the fast plan: `points_ledger_user_created_idx` leads
 * with `user_id`, so a nested loop over eligible members with a range scan on
 * `created_at` uses it — while the bare `created_at > …` across all users that
 * an implementer might write instead cannot, and reads the whole table.
 */
function weekPoints(from: Date, to: Date): SQL {
  return sql`
    SELECT m.id AS user_id,
           sum(p.points)::int   AS score,
           count(*)::int        AS events,
           min(p.created_at)    AS first_at
    FROM leaderboard_eligible_members m
    JOIN points_ledger p
      ON p.user_id = m.id
     AND p.created_at >= ${from.toISOString()}::timestamptz
     AND p.created_at <  ${to.toISOString()}::timestamptz
    GROUP BY m.id
  `;
}

export interface StandingRow {
  /** Competition rank within the group. Ties share a rank and the next rank skips. */
  rank: number;
  /** Points earned inside the week. Zero is a real and common value. */
  score: number;
  events: number;
  /** Public passport handle — the link target. Never the account id. */
  handle: string;
  displayName: string;
  /** Present so a caller can highlight the viewer's own row; never rendered. */
  userId: string;
  groupId: number;
  tier: number;
  ordinal: number;
  /** Members visible in this group, after the consent join. */
  groupSize: number;
}

function mapStanding(row: Record<string, unknown>): StandingRow {
  return {
    rank: Number(row.rank),
    score: Number(row.score ?? 0),
    events: Number(row.events ?? 0),
    handle: String(row.handle ?? ''),
    displayName: String(row.display_name ?? ''),
    userId: String(row.user_id),
    groupId: Number(row.group_id),
    tier: Number(row.tier),
    ordinal: Number(row.ordinal),
    groupSize: Number(row.group_size),
  };
}

export interface StandingsOptions {
  timeZone?: string;
  /** One group only. Omit for every group in the week. */
  groupId?: number;
}

/**
 * A week's ladder, ranked within each group.
 *
 * The ONE ranking query. The screen calls it to render, the rollover calls it to
 * decide who moves, and there is deliberately no second implementation shaped
 * differently "for the job" — the moment those two disagree, a member is
 * promoted or not for reasons the page they were reading did not show.
 *
 * Ordering matches `leaderboard()`: score descending, ties broken by who reached
 * the total first. Deterministic, and fairer than an id ordering that would
 * silently favour whoever's random id sorted lower.
 *
 * A member assigned on Monday who has since unpublished their passport drops out
 * of the INNER JOIN and out of `group_size`, and the ranks close up behind them.
 */
export async function weekStandings(
  db: SqlRunner,
  week: WeekKey,
  options: StandingsOptions = {},
): Promise<StandingRow[]> {
  const { from, to } = weekBounds(week, options.timeZone ?? SOFIA_TZ);
  const groupFilter = options.groupId === undefined ? sql`` : sql` AND g.id = ${options.groupId}`;

  const result = await db.execute(sql`
    WITH visible AS (
      -- The consent join. INNER, so an unpublished member yields no row at all
      -- rather than a row a caller might decide not to print — which would move
      -- the guarantee from SQL into JSX, where the rule forbids it.
      SELECT dm.user_id      AS user_id,
             g.id            AS group_id,
             g.tier          AS tier,
             g.ordinal       AS ordinal,
             m.public_handle AS handle,
             m.display_name  AS display_name
      FROM division_members dm
      JOIN division_groups g ON g.id = dm.group_id
      JOIN leaderboard_eligible_members m ON m.id = dm.user_id
      WHERE dm.week_start = ${week}::date${groupFilter}
    )
    SELECT v.user_id, v.group_id, v.tier, v.ordinal, v.handle, v.display_name,
           coalesce(w.score, 0)::int  AS score,
           coalesce(w.events, 0)::int AS events,
           count(*)      OVER (PARTITION BY v.group_id)::int AS group_size,
           -- Ranked AFTER the consent join, so the board reads 1, 2, 3.
           rank() OVER (
             PARTITION BY v.group_id
             ORDER BY coalesce(w.score, 0) DESC, w.first_at ASC NULLS LAST, v.user_id
           )::int AS rank
    FROM visible v
    LEFT JOIN (${weekPoints(from, to)}) w ON w.user_id = v.user_id
    ORDER BY v.tier DESC, v.ordinal, rank, v.user_id
  `);
  return result.rows.map(mapStanding);
}

/** Which group a member is in for a week, or null. */
export async function memberDivision(
  db: SqlRunner,
  userId: string,
  week: WeekKey,
): Promise<{ groupId: number; tier: number; ordinal: number } | null> {
  const result = await db.execute(sql`
    SELECT g.id AS group_id, g.tier AS tier, g.ordinal AS ordinal
    FROM division_members dm
    JOIN division_groups g ON g.id = dm.group_id
    WHERE dm.user_id = ${userId} AND dm.week_start = ${week}::date
  `);
  const row = result.rows[0];
  if (!row) return null;
  return { groupId: Number(row.group_id), tier: Number(row.tier), ordinal: Number(row.ordinal) };
}

/**
 * The tier a member held in a week, ignoring consent.
 *
 * Deliberately NOT joined to the eligibility view, and this is the one place
 * that is correct: it answers "where was I", for the member themselves, on their
 * own passport. It never returns a name, a handle or anyone else's row, so it
 * discloses nothing about anybody — and gating it would mean a member who
 * unpublishes stops being told their own history.
 */
export async function memberTier(
  db: SqlRunner,
  userId: string,
  week: WeekKey,
): Promise<number | null> {
  const result = await db.execute(sql`
    SELECT g.tier AS tier
    FROM division_members dm
    JOIN division_groups g ON g.id = dm.group_id
    WHERE dm.user_id = ${userId} AND dm.week_start = ${week}::date
  `);
  const row = result.rows[0];
  return row ? Number(row.tier) : null;
}

/** Whether a week has a ladder at all — false below `DIVISION_MIN_MEMBERS`. */
export async function divisionsExist(db: SqlRunner, week: WeekKey): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1 FROM division_groups WHERE week_start = ${week}::date LIMIT 1
  `);
  return result.rows.length > 0;
}

export interface RolloverOptions {
  timeZone?: string;
  /** Injected in tests so "the last four weeks" is not the wall clock. */
  now?: Date;
  minMembers?: number;
}

/**
 * Everyone who should have a place in `week`, with the history that decides where.
 *
 * ACTIVE, not merely eligible: a member must have scored inside the last
 * `DIVISION_ACTIVE_WEEKS`. A ladder padded with dormant accounts hands every
 * active member a top finish for turning up once and fills the visible field
 * with rows that will never move.
 *
 * `previousTier` comes from the last week the member was ASSIGNED, not
 * necessarily the week just closed — so somebody who missed August returns at
 * the tier they left, which `tierFor` then keeps. Looking only at the closed
 * week would silently reset every returning member to the entry tier, which is
 * the same punishment twice for one absence.
 */
export async function divisionCandidates(
  db: SqlRunner,
  week: WeekKey,
  options: RolloverOptions = {},
): Promise<DivisionCandidate[]> {
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const { from } = weekBounds(week, timeZone);
  const windowStart = new Date(from.getTime() - DIVISION_ACTIVE_WEEKS * 7 * 24 * 60 * 60 * 1000);

  const result = await db.execute(sql`
    SELECT m.id::text AS user_id,
           sum(p.points)::int AS recent_score,
           (
             SELECT g.tier
             FROM division_members dm
             JOIN division_groups g ON g.id = dm.group_id
             WHERE dm.user_id = m.id AND dm.week_start < ${week}::date
             ORDER BY dm.week_start DESC
             LIMIT 1
           ) AS previous_tier
    FROM leaderboard_eligible_members m
    JOIN points_ledger p
      ON p.user_id = m.id
     AND p.created_at >= ${windowStart.toISOString()}::timestamptz
     AND p.created_at <  ${from.toISOString()}::timestamptz
    GROUP BY m.id
    HAVING sum(p.points) > 0
    ORDER BY m.id
  `);

  return result.rows.map((row) => ({
    userId: String(row.user_id),
    recentScore: Number(row.recent_score ?? 0),
    previousTier: row.previous_tier === null || row.previous_tier === undefined
      ? null
      : Number(row.previous_tier),
    place: null,
    previousSize: undefined,
  }));
}

export interface RolloverReport {
  /** The week the ladder was written for. */
  week: WeekKey;
  groups: number;
  members: number;
  /** True when the floor was not met and nothing was written. */
  belowFloor: boolean;
}

/**
 * Write one week's ladder. Idempotent.
 *
 * THIS IS ALSO THE BOOTSTRAP, and that is the design rather than an accident.
 * The plan warned that "the rollover closes last week and assigns next — nothing
 * creates week one, so it is a no-op forever". So there is no separate seeding
 * job: this function derives each member's tier from whatever history exists,
 * and when there is none, `tierFor` returns the entry tier for everybody. Week
 * one is simply the general case with an empty left-hand side. A dedicated
 * bootstrap would have been a second code path that runs exactly once, in
 * production, unrehearsed — which is the same reasoning that made the badge
 * backfill a cutoff rather than a flag in phase 3.
 *
 * IDEMPOTENT MEANS "DOES NOT DUPLICATE", NOT "CONVERGES ON THE CURRENT PLAN",
 * and the difference matters. The plan is deterministic, so a re-run computes
 * the same assignment; the write is ON CONFLICT DO NOTHING, so a run that died
 * after three of five groups finishes the other two next time. But an assignment
 * already recorded is never revised. Correcting a wrong-but-complete ladder
 * means deleting that week's rows — members first, then groups — and running
 * again; this function will not self-heal one.
 *
 * BELOW THE FLOOR IT WRITES NOTHING — no group rows, so no ladder, so
 * `/klasirane` renders none. The floor needs no separate check anywhere else
 * because there is nothing to check: the week simply has no groups.
 */
export async function runDivisionRollover(
  db: SqlRunner,
  week: WeekKey,
  options: RolloverOptions = {},
): Promise<RolloverReport> {
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const minMembers = options.minMembers ?? DIVISION_MIN_MEMBERS;

  const candidates = await divisionCandidates(db, week, { ...options, timeZone });
  if (candidates.length < minMembers) {
    return { week, groups: 0, members: 0, belowFloor: true };
  }

  // How the week that just closed actually finished, read through the SAME
  // ranking the ladder displayed all week. `previousBucketKey` rather than a
  // local date subtraction: the streak module is the one place civil-week
  // arithmetic is implemented, and a second copy here would be a second thing
  // that can disagree with it about a DST week.
  const previousWeek = previousBucketKey(week, 'week');
  const closed = await weekStandings(db, previousWeek, { timeZone });
  const places = new Map(
    closed.map((row) => [
      row.userId,
      { place: { rank: row.rank, score: row.score }, size: row.groupSize },
    ]),
  );

  const withHistory: DivisionCandidate[] = candidates.map((candidate) => {
    const finished = places.get(candidate.userId);
    return finished
      ? { ...candidate, place: finished.place, previousSize: finished.size }
      : candidate;
  });

  const plan = planDivisions(withHistory, { minMembers });
  if (plan.length === 0) return { week, groups: 0, members: 0, belowFloor: true };

  await writeAssignments(db, week, plan);
  const groups = new Set(plan.map((a) => `${a.tier}:${a.ordinal}`)).size;
  return { week, groups, members: plan.length, belowFloor: false };
}

/**
 * Insert the groups and their members.
 *
 * Groups are inserted first so the composite FK has a target, then members are
 * attached. Both are ON CONFLICT DO NOTHING, so re-running a week adds only what
 * is missing rather than erroring — the property that lets the operator simply
 * run the job again after a worker restart. It does not revise what is already
 * there; see `runDivisionRollover`.
 *
 * The member insert's arbiter is `(user_id, week_start)` rather than the primary
 * key, and it has to be: a duplicate `(group_id, user_id)` implies a duplicate
 * `(user_id, week_start)`, so the unique index fires first either way — but
 * naming the PK would let a member who is being MOVED between groups slip past
 * the arbiter and raise on the unique index instead of being skipped.
 */
async function writeAssignments(
  db: SqlRunner,
  week: WeekKey,
  plan: readonly DivisionAssignment[],
): Promise<void> {
  const groupKeys = [...new Set(plan.map((a) => `${a.tier}:${a.ordinal}`))].map((key) => {
    const [tier, ordinal] = key.split(':');
    return { tier: Number(tier), ordinal: Number(ordinal) };
  });

  for (const group of groupKeys) {
    await db.execute(sql`
      INSERT INTO division_groups (week_start, tier, ordinal)
      VALUES (${week}::date, ${group.tier}, ${group.ordinal})
      ON CONFLICT (week_start, tier, ordinal) DO NOTHING
    `);
  }

  for (const assignment of plan) {
    await db.execute(sql`
      INSERT INTO division_members (group_id, user_id, week_start)
      SELECT g.id, ${assignment.userId}, ${week}::date
      FROM division_groups g
      WHERE g.week_start = ${week}::date
        AND g.tier = ${assignment.tier}
        AND g.ordinal = ${assignment.ordinal}
      ON CONFLICT (user_id, week_start) DO NOTHING
    `);
  }
}
