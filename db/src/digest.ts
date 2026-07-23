import {
  addDays,
  instantToWall,
  isoWeekday,
  SOFIA_TZ,
  zonedToInstant,
  type WallClock,
} from '@sportkarta/lib/recurrence';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The weekly city digest query (docs/ROADMAP.md §6, Stage 4.4).
 *
 * This module exists so that "the page and the email come from the same query"
 * is a fact about the code rather than a claim in a comment. `apps/worker`
 * cannot import `apps/web/lib`, so a query either lives here — next to
 * stats.ts, which the worker and the web app already share — or it gets written
 * twice and drifts. `/sedmitsata/[city]` and the `digest.weekly` job both call
 * `weeklyDigest`.
 *
 * THE WEEK IS A SOFIA WALL CLOCK WEEK: Monday 00:00 local to the next Monday
 * 00:00 local. The week containing a DST transition is therefore 167 or 169
 * hours long and still starts and ends at midnight, which is what "this week"
 * means to a person. Computing it from instants (`now - 7 * 86400000`) would
 * slide the boundary by an hour twice a year and put a Sunday-evening session
 * in the wrong digest. The conversion is the same engine the recurrence
 * expansion uses (lib/src/recurrence/zoned.ts).
 */

/**
 * Ceiling on one city-week. A plaintext email and a single page both stop being
 * usable long before this, and an unbounded query behind a scheduled job is how
 * one busy city takes the send down.
 */
export const MAX_WEEK_OCCURRENCES = 500;

/** Matches the drizzle db and any transaction handle. */
interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface DigestOccurrence {
  occurrenceId: string;
  sessionId: string;
  /** UTC instant. */
  startsAt: Date;
  /** The Sofia wall clock it reads as, `YYYY-MM-DDTHH:MM:SS`. */
  startsAtLocal: string;
  durationMinutes: number;
  sport: string;
  title: string;
  facilityId: string;
  facilityName: string | null;
  facilitySlug: string | null;
  /** NULL = unlimited. */
  capacity: number | null;
  going: number;
}

export interface DigestWeek {
  municipalityId: number;
  /** The Sofia Monday, `YYYY-MM-DD` — also the digest_sends key. */
  weekStart: string;
  from: Date;
  to: Date;
  occurrences: DigestOccurrence[];
}

/** The Sofia Monday 00:00 on or before `now`, as a wall clock. */
export function weekStartFor(now: Date, timeZone: string = SOFIA_TZ): WallClock {
  const local = instantToWall(now.getTime(), timeZone);
  const midnight: WallClock = { ...local, hour: 0, minute: 0 };
  return addDays(midnight, -(isoWeekday(midnight) - 1));
}

/** `YYYY-MM-DD` for a wall clock — the form `digest_sends.week_start` expects. */
export function formatWeekStart(weekStart: WallClock): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(weekStart.year, 4)}-${pad(weekStart.month)}-${pad(weekStart.day)}`;
}

/**
 * The instants bounding a wall-clock week. `to` is the NEXT Monday 00:00 local,
 * resolved through the tz database rather than `from + 7 days` of elapsed time —
 * that difference is the whole point.
 */
export function weekWindow(
  weekStart: WallClock,
  timeZone: string = SOFIA_TZ,
): { from: Date; to: Date } {
  return {
    from: new Date(zonedToInstant(weekStart, timeZone).instantMs),
    to: new Date(zonedToInstant(addDays(weekStart, 7), timeZone).instantMs),
  };
}

export interface WeeklyDigestOptions {
  municipalityId: number;
  /** Sofia Monday. Defaults to the week containing `now`. */
  weekStart?: WallClock;
  now?: Date;
  timeZone?: string;
}

/**
 * Everything happening in one city in one week.
 *
 * Only `scheduled` occurrences of `scheduled`, `public` series: a cancelled
 * session must not appear on the page or in the mail, and an `unlisted` series
 * is link-only by definition — putting it in a city digest would be exactly the
 * disclosure the visibility setting exists to prevent.
 */
export async function weeklyDigest(
  db: SqlRunner,
  options: WeeklyDigestOptions,
): Promise<DigestWeek> {
  const timeZone = options.timeZone ?? SOFIA_TZ;
  const weekStart = options.weekStart ?? weekStartFor(options.now ?? new Date(), timeZone);
  const { from, to } = weekWindow(weekStart, timeZone);

  const result = await db.execute(sql`
    SELECT
      o.id            AS occurrence_id,
      o.session_id    AS session_id,
      o.starts_at     AS starts_at,
      to_char(o.starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
      s.duration_minutes AS duration_minutes,
      s.sport         AS sport,
      s.title         AS title,
      s.capacity      AS capacity,
      f.id            AS facility_id,
      f.name          AS facility_name,
      f.slug          AS facility_slug,
      (SELECT count(*)::int FROM play_session_rsvp_positions p
        WHERE p.occurrence_id = o.id AND p.rsvp_status = 'going') AS going
    FROM play_session_occurrences o
    JOIN play_sessions s ON s.id = o.session_id
    JOIN facilities f    ON f.id = s.facility_id
    WHERE f.municipality_id = ${options.municipalityId}
      AND o.status = 'scheduled'
      AND s.status = 'scheduled'
      AND s.visibility = 'public'
      AND o.starts_at >= ${from.toISOString()}::timestamptz
      AND o.starts_at <  ${to.toISOString()}::timestamptz
    ORDER BY o.starts_at, f.name NULLS LAST, s.title
    LIMIT ${MAX_WEEK_OCCURRENCES}
  `);

  return {
    municipalityId: options.municipalityId,
    weekStart: formatWeekStart(weekStart),
    from,
    to,
    occurrences: result.rows.map((row) => ({
      occurrenceId: String(row.occurrence_id),
      sessionId: String(row.session_id),
      startsAt: new Date(String(row.starts_at)),
      startsAtLocal: String(row.starts_at_local),
      durationMinutes: Number(row.duration_minutes),
      sport: String(row.sport),
      title: String(row.title),
      facilityId: String(row.facility_id),
      facilityName: row.facility_name === null ? null : String(row.facility_name),
      facilitySlug: row.facility_slug === null ? null : String(row.facility_slug),
      capacity: row.capacity === null ? null : Number(row.capacity),
      going: Number(row.going ?? 0),
    })),
  };
}

export interface DigestRecipient {
  userId: string;
  email: string;
  displayName: string;
  unsubscribeToken: string;
  municipalityId: number;
  municipalityNameBg: string;
  municipalityNameEn: string;
}

/**
 * Everyone opted in to a city's digest. Used only by the job — the address is
 * read here, at send time, and never stored in a job payload that would outlive
 * the account it names.
 */
export async function digestRecipients(
  db: SqlRunner,
  municipalityId?: number,
): Promise<DigestRecipient[]> {
  const scope =
    municipalityId === undefined ? sql`TRUE` : sql`d.municipality_id = ${municipalityId}`;
  const result = await db.execute(sql`
    SELECT d.user_id, u.email, u.display_name, d.unsubscribe_token,
           d.municipality_id, m.name_bg, m.name_en
      FROM digest_subscriptions d
      JOIN users u ON u.id = d.user_id
      JOIN municipalities m ON m.id = d.municipality_id
     WHERE ${scope}
     ORDER BY d.municipality_id, d.user_id
  `);
  return result.rows.map((row) => ({
    userId: String(row.user_id),
    email: String(row.email),
    displayName: String(row.display_name ?? ''),
    unsubscribeToken: String(row.unsubscribe_token),
    municipalityId: Number(row.municipality_id),
    municipalityNameBg: String(row.name_bg),
    municipalityNameEn: String(row.name_en),
  }));
}

/**
 * Claim this week's send for one subscriber. Returns false when somebody (a
 * retry, an overlapping schedule, another worker) already claimed it.
 *
 * MUST be called inside the same transaction as the send, and BEFORE it — that
 * ordering is the whole guarantee. `week_start` is passed as a 'YYYY-MM-DD'
 * STRING, never a Date: node-postgres would serialise a Date through the
 * process timezone and a UTC worker would key a Sofia Monday to the Sunday.
 * The CHECK on the column catches that, loudly, before any mail goes out.
 */
export async function claimDigestSend(
  tx: SqlRunner,
  userId: string,
  municipalityId: number,
  weekStart: string,
): Promise<boolean> {
  const result = await tx.execute(sql`
    INSERT INTO digest_sends (user_id, municipality_id, week_start)
    VALUES (${userId}, ${municipalityId}, ${weekStart}::date)
    ON CONFLICT (user_id, municipality_id, week_start) DO NOTHING
    RETURNING id
  `);
  return result.rows.length > 0;
}
