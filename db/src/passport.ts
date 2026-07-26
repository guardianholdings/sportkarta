import { sql, type SQL } from 'drizzle-orm';

import type { PassportEvent } from '@sportkarta/lib/badges';

/**
 * The passport's data layer (docs/ROADMAP.md §7, Stage 5.1).
 *
 * This module has exactly one job: turn a member's scattered history into the
 * flat PassportEvent stream that lib/src/badges folds. Every scoring decision
 * lives in that pure engine — nothing here knows what a badge is, which is what
 * lets a new badge be a config entry instead of a query change.
 *
 * TWO SOURCES, ONE SHAPE:
 *
 *  - points_ledger, for contributions. Reading the LEDGER rather than
 *    facility_edits is deliberate: the ledger's idempotency keys already
 *    express the anti-farming rules (one award per facility added, per person
 *    per facility verified, per person per facility per Sofia day for
 *    conditions — lib/src/points.ts). Badges inherit all of that for free, and
 *    a member spamming condition reports on one bench produces one event a day
 *    here, not a hundred.
 *  - play_session_checkins, for participation. The facility comes through the
 *    occurrence's session, so a check-in carries the same place and sport
 *    dimensions a contribution does and coverage rules work across both.
 *
 * The stream deliberately carries no names, no free text and no photos. It
 * feeds a scoring engine; anything in it is one careless render away from a
 * public page.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

function toSports(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Every scoreable thing a member has done, oldest first.
 *
 * Unbounded by design: a badge is a statement about someone's whole history, so
 * a LIMIT here would silently un-earn badges for the most active members —
 * exactly the people who would notice. The volume is bounded in practice by the
 * ledger's idempotency rules, and both scans are index-only on (user_id, …).
 */
export async function passportEvents(db: SqlRunner, userId: string): Promise<PassportEvent[]> {
  const result = await db.execute(sql`
    SELECT
      p.event::text        AS kind,
      p.created_at         AS at,
      p.facility_id::text  AS facility_id,
      f.municipality_id    AS municipality_id,
      f.sport_types        AS sports,
      p.points             AS points
    FROM points_ledger p
    LEFT JOIN facilities f ON f.id = p.facility_id
    WHERE p.user_id = ${userId}

    UNION ALL

    SELECT
      'session_checkin'    AS kind,
      c.checked_in_at      AS at,
      f.id::text           AS facility_id,
      f.municipality_id    AS municipality_id,
      -- The sport actually played, not the facility's whole list: a football
      -- session on a multi-sport pitch is football.
      ARRAY[s.sport]       AS sports,
      0                    AS points
    FROM play_session_checkins c
    JOIN play_session_occurrences o ON o.id = c.occurrence_id
    JOIN play_sessions s            ON s.id = o.session_id
    JOIN facilities f               ON f.id = s.facility_id
    WHERE c.user_id = ${userId}

    ORDER BY at ASC
  `);

  return result.rows.map((row) => ({
    kind: String(row.kind) as PassportEvent['kind'],
    at: new Date(String(row.at)),
    facilityId: row.facility_id === null ? null : String(row.facility_id),
    municipalityId: row.municipality_id === null ? null : Number(row.municipality_id).toString(),
    sports: toSports(row.sports),
    points: Number(row.points ?? 0),
  }));
}

export interface PassportTotals {
  points: number;
  facilitiesAdded: number;
  facilitiesVerified: number;
  conditionsReported: number;
  checkins: number;
  /** Account creation instant — the passport's "member since". */
  memberSince: string | null;
}

/** Headline counters, computed in SQL rather than by counting the stream twice. */
export async function passportTotals(db: SqlRunner, userId: string): Promise<PassportTotals> {
  const result = await db.execute(sql`
    SELECT
      coalesce((SELECT sum(points) FROM points_ledger WHERE user_id = ${userId}), 0)::int
        AS points,
      (SELECT count(*) FROM points_ledger
        WHERE user_id = ${userId} AND event = 'facility_added')::int AS facilities_added,
      (SELECT count(*) FROM points_ledger
        WHERE user_id = ${userId} AND event = 'facility_verified')::int AS facilities_verified,
      (SELECT count(*) FROM points_ledger
        WHERE user_id = ${userId} AND event = 'condition_reported')::int AS conditions_reported,
      (SELECT count(*) FROM play_session_checkins WHERE user_id = ${userId})::int AS checkins,
      (SELECT created_at FROM users WHERE id = ${userId}) AS member_since
  `);
  const row = result.rows[0] ?? {};
  return {
    points: Number(row.points ?? 0),
    facilitiesAdded: Number(row.facilities_added ?? 0),
    facilitiesVerified: Number(row.facilities_verified ?? 0),
    conditionsReported: Number(row.conditions_reported ?? 0),
    checkins: Number(row.checkins ?? 0),
    memberSince: row.member_since === null || row.member_since === undefined
      ? null
      : String(row.member_since),
  };
}

export interface PassportHistoryEntry {
  kind: PassportEvent['kind'];
  at: string;
  facilityName: string | null;
  facilitySlug: string | null;
  /** For check-ins, the sport that was played. */
  sport: string | null;
  points: number;
}

/**
 * The member's OWN history — names, places and times.
 *
 * This is the one passport read that is allowed to be specific, because it is
 * showing a person their own life on a page only they can open
 * (`/pasport`, force-dynamic, noindex, behind requireUser). Nothing in this
 * shape may ever reach the public projection; apps/web/lib/passport.ts builds
 * that from aggregates instead, and a test pins it.
 */
export async function passportHistory(
  db: SqlRunner,
  userId: string,
  limit = 20,
): Promise<PassportHistoryEntry[]> {
  const result = await db.execute(sql`
    (
      SELECT p.event::text AS kind, p.created_at AS at, f.name AS facility_name,
             f.slug AS facility_slug, NULL::text AS sport, p.points AS points
      FROM points_ledger p
      LEFT JOIN facilities f ON f.id = p.facility_id
      WHERE p.user_id = ${userId}
    )
    UNION ALL
    (
      SELECT 'session_checkin' AS kind, c.checked_in_at AS at, f.name AS facility_name,
             f.slug AS facility_slug, s.sport AS sport, 0 AS points
      FROM play_session_checkins c
      JOIN play_session_occurrences o ON o.id = c.occurrence_id
      JOIN play_sessions s            ON s.id = o.session_id
      JOIN facilities f               ON f.id = s.facility_id
      WHERE c.user_id = ${userId}
    )
    ORDER BY at DESC
    LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    kind: String(row.kind) as PassportEvent['kind'],
    at: String(row.at),
    facilityName: row.facility_name === null ? null : String(row.facility_name),
    facilitySlug: row.facility_slug === null ? null : String(row.facility_slug),
    sport: row.sport === null ? null : String(row.sport),
    points: Number(row.points ?? 0),
  }));
}

export interface PublicPassportOwner {
  userId: string;
  displayName: string;
  homeCity: string | null;
  showActivity: boolean;
  memberSince: string;
}

/**
 * Resolve a public handle to its owner, or null.
 *
 * THE VISIBILITY TEST IS IN THE WHERE CLAUSE, not in a caller's `if`. A private
 * passport must be indistinguishable from one that does not exist — including to
 * somebody who kept an old link after the member went private again. Selecting
 * the row and letting the page decide would make that a one-line regression
 * away.
 *
 * An `AND is_minor = false` predicate stood here until migration 0020 (operator
 * decision 2026-07-25 — minors are treated as adults). Age is no longer part of
 * this question; consent is the whole of it.
 */
export async function publicPassportOwner(
  db: SqlRunner,
  handle: string,
): Promise<PublicPassportOwner | null> {
  const result = await db.execute(sql`
    SELECT id, display_name, home_city, public_show_activity, created_at
    FROM users
    WHERE public_handle = ${handle}
      AND profile_visibility = 'public'
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: String(row.id),
    displayName: String(row.display_name ?? ''),
    homeCity: row.home_city === null ? null : String(row.home_city),
    showActivity: row.public_show_activity === true,
    memberSince: String(row.created_at),
  };
}

export interface MonthlyActivity {
  /** `YYYY-MM` in Europe/Sofia. */
  month: string;
  contributions: number;
  checkins: number;
}

/**
 * Per-month counts for the opt-in public activity view.
 *
 * A MONTH IS THE FINEST GRAIN THIS IS ALLOWED TO HAVE, and the coarseness is
 * the feature. The private view can say "you verified Ovcha Kupel's pitch on
 * Tuesday at 18:00" because it is showing a member their own life. A public
 * page saying the same thing about a named person publishes where they
 * reliably are and when — a pattern-of-life disclosure, not a privacy
 * preference. So this aggregates to a month and drops the place entirely:
 * there is no facility id in the result to leak by accident later.
 */
export async function publicMonthlyActivity(
  db: SqlRunner,
  userId: string,
  months = 12,
): Promise<MonthlyActivity[]> {
  const result = await db.execute(sql`
    WITH events AS (
      SELECT created_at AS at, 1 AS is_contribution, 0 AS is_checkin
        FROM points_ledger WHERE user_id = ${userId}
      UNION ALL
      SELECT checked_in_at AS at, 0, 1
        FROM play_session_checkins WHERE user_id = ${userId}
    )
    SELECT
      -- Bucketed in Sofia civil time, like every other date in the product:
      -- an event at 22:30 UTC on 31 January belongs to February here.
      to_char(date_trunc('month', at AT TIME ZONE 'Europe/Sofia'), 'YYYY-MM') AS month,
      sum(is_contribution)::int AS contributions,
      sum(is_checkin)::int      AS checkins
    FROM events
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT ${months}
  `);
  return result.rows.map((row) => ({
    month: String(row.month),
    contributions: Number(row.contributions ?? 0),
    checkins: Number(row.checkins ?? 0),
  }));
}

/**
 * Record newly-earned badges so the member is congratulated exactly once.
 *
 * ON CONFLICT DO NOTHING against the (user_id, badge_slug) unique index — the
 * same argument as points_ledger and digest_sends: two concurrent page loads
 * must produce one row, and the guarantee belongs in the database rather than
 * in a check-then-insert that races.
 *
 * Returns the slugs this call actually inserted, i.e. the ones that are new to
 * this member right now. Nothing here decides whether a badge is HELD — the
 * engine already did, and this table is never read to answer that.
 */
export async function recordEarnedBadges(
  db: SqlRunner,
  userId: string,
  earned: readonly { slug: string; earnedAt: Date }[],
): Promise<string[]> {
  if (earned.length === 0) return [];

  const values = sql.join(
    earned.map((badge) => sql`(${userId}, ${badge.slug}, ${badge.earnedAt.toISOString()}::timestamptz)`),
    sql`, `,
  );

  const result = await db.execute(sql`
    INSERT INTO user_badges (user_id, badge_slug, earned_at)
    VALUES ${values}
    ON CONFLICT (user_id, badge_slug) DO NOTHING
    RETURNING badge_slug
  `);
  return result.rows.map((row) => String(row.badge_slug));
}

/** Slugs the member has not yet been shown, for the "new" marker. */
export async function unseenBadges(db: SqlRunner, userId: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT badge_slug FROM user_badges WHERE user_id = ${userId} AND seen_at IS NULL
  `);
  return result.rows.map((row) => String(row.badge_slug));
}

/** Mark everything currently new as seen. Idempotent. */
export async function markBadgesSeen(db: SqlRunner, userId: string): Promise<void> {
  await db.execute(sql`
    UPDATE user_badges SET seen_at = now() WHERE user_id = ${userId} AND seen_at IS NULL
  `);
}
