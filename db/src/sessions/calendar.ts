import { randomBytes } from 'node:crypto';

import { sql, type SQL } from 'drizzle-orm';

/**
 * The private calendar feed (docs/ROADMAP.md §6, Stage 4.2).
 *
 * A calendar client cannot sign in. It fetches one URL, forever,
 * unauthenticated — so the URL IS the credential, and everything here follows
 * from that:
 *
 *  - The token is 192 random bits, well past the 128 the CHECK insists on.
 *  - It is NOT the account id and not derived from it. users.id is the
 *    better-auth session subject; a feed URL containing it would hand a live
 *    identifier to every calendar server that ever polls us.
 *  - Rotation is an UPDATE on a single row, so revoking kills every copy of the
 *    old URL at once. Once a feed URL has leaked into a shared calendar that is
 *    the only recovery available, so it must be one click.
 *
 * WHAT THE FEED EXPOSES, and why it is not more. Only the member's OWN
 * sessions: occurrences they hold an active RSVP for, plus the ones they
 * organise. A leaked token then reveals where one person plays football, which
 * is bad enough — it must never also become a directory of who else was there.
 * No attendee is named in the feed, not even a count of them.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** 24 bytes → 32 base64url characters, comfortably over the CHECK's floor. */
export function generateCalendarToken(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * The member's token, minting one on first use.
 *
 * ON CONFLICT DO NOTHING then re-read, rather than DO UPDATE: an UPDATE would
 * rotate the token on every call, silently breaking a calendar the member
 * subscribed to last month the next time anything touched this row.
 */
export async function ensureCalendarToken(db: SqlRunner, userId: string): Promise<string> {
  await db.execute(sql`
    INSERT INTO calendar_tokens (user_id, token)
    VALUES (${userId}, ${generateCalendarToken()})
    ON CONFLICT (user_id) DO NOTHING
  `);
  const result = await db.execute(sql`SELECT token FROM calendar_tokens WHERE user_id = ${userId}`);
  const token = result.rows[0]?.token;
  if (typeof token !== 'string') {
    throw new Error('calendar token could not be issued');
  }
  return token;
}

/** Revoke: every existing subscription URL stops working immediately. */
export async function rotateCalendarToken(db: SqlRunner, userId: string): Promise<string> {
  const token = generateCalendarToken();
  const result = await db.execute(sql`
    INSERT INTO calendar_tokens (user_id, token)
    VALUES (${userId}, ${token})
    ON CONFLICT (user_id) DO UPDATE SET token = EXCLUDED.token, rotated_at = now()
    RETURNING token
  `);
  return String(result.rows[0]?.token ?? token);
}

/** Null when the member has never opened the calendar panel. */
export async function calendarToken(db: SqlRunner, userId: string): Promise<string | null> {
  const result = await db.execute(sql`SELECT token FROM calendar_tokens WHERE user_id = ${userId}`);
  const token = result.rows[0]?.token;
  return typeof token === 'string' ? token : null;
}

export interface CalendarOccurrence {
  occurrenceId: string;
  startsAt: string;
  endsAt: string;
  title: string;
  sport: string;
  facilityName: string | null;
  facilitySlug: string | null;
  lat: number | null;
  lon: number | null;
  cancelled: boolean;
  /** The member's own role, so the feed can say "you are organising this". */
  organizing: boolean;
}

function toOccurrence(row: Record<string, unknown>): CalendarOccurrence {
  return {
    occurrenceId: String(row.occurrence_id),
    startsAt: new Date(row.starts_at as string | number | Date).toISOString(),
    endsAt: new Date(row.ends_at as string | number | Date).toISOString(),
    title: String(row.title),
    sport: String(row.sport),
    facilityName: (row.facility_name as string | null) ?? null,
    facilitySlug: (row.facility_slug as string | null) ?? null,
    lat: row.lat === null || row.lat === undefined ? null : Number(row.lat),
    lon: row.lon === null || row.lon === undefined ? null : Number(row.lon),
    cancelled: row.cancelled === true,
    organizing: row.organizing === true,
  };
}

/**
 * How far back the feed reaches. A calendar that drops an event the moment it
 * starts is disorienting — you look at yesterday and your Tuesday football is
 * simply gone, as though it never happened.
 */
export const FEED_PAST_DAYS = 14;

export interface CalendarFeed {
  userId: string;
  displayName: string;
  occurrences: CalendarOccurrence[];
}

/**
 * Resolve a feed token to its owner's sessions, or null for an unknown token.
 *
 * CANCELLED OCCURRENCES ARE INCLUDED, on purpose. A subscribed client that
 * simply stops seeing an event may keep showing it; the way to remove it is to
 * keep publishing it with STATUS:CANCELLED (see lib/src/ical). Dropping the row
 * here would leave a cancelled session sitting in somebody's calendar forever.
 */
export async function calendarFeed(db: SqlRunner, token: string): Promise<CalendarFeed | null> {
  const owner = await db.execute(sql`
    SELECT u.id, u.display_name
      FROM calendar_tokens ct
      JOIN users u ON u.id = ct.user_id
     WHERE ct.token = ${token}
  `);
  const ownerRow = owner.rows[0];
  if (!ownerRow) return null;
  const userId = String(ownerRow.id);

  const result = await db.execute(sql`
    SELECT o.id AS occurrence_id, o.starts_at, o.ends_at,
           (o.status = 'cancelled') AS cancelled,
           s.title, s.sport,
           (s.organizer_id = ${userId}) AS organizing,
           f.name AS facility_name, f.slug AS facility_slug,
           ST_Y(f.geom) AS lat, ST_X(f.geom) AS lon
      FROM play_session_occurrences o
      JOIN play_sessions s ON s.id = o.session_id
      JOIN facilities f ON f.id = s.facility_id
     WHERE o.starts_at >= now() - make_interval(days => ${FEED_PAST_DAYS})
       AND (
         -- The member's own attendance …
         EXISTS (
           SELECT 1 FROM play_session_rsvps r
            WHERE r.occurrence_id = o.id AND r.user_id = ${userId} AND r.state = 'active'
         )
         -- … or a series they are answerable for.
         OR s.organizer_id = ${userId}
       )
     ORDER BY o.starts_at
  `);

  return {
    userId,
    displayName: String(ownerRow.display_name ?? ''),
    occurrences: result.rows.map(toOccurrence),
  };
}

/**
 * One occurrence, for the per-session .ics download. Public information — the
 * session page it hangs off is public — so no token and no attendance data.
 */
export async function calendarOccurrence(
  db: SqlRunner,
  occurrenceId: string,
): Promise<CalendarOccurrence | null> {
  const result = await db.execute(sql`
    SELECT o.id AS occurrence_id, o.starts_at, o.ends_at,
           (o.status = 'cancelled') AS cancelled,
           s.title, s.sport,
           FALSE AS organizing,
           f.name AS facility_name, f.slug AS facility_slug,
           ST_Y(f.geom) AS lat, ST_X(f.geom) AS lon
      FROM play_session_occurrences o
      JOIN play_sessions s ON s.id = o.session_id
      JOIN facilities f ON f.id = s.facility_id
     WHERE o.id = ${occurrenceId}::uuid
       -- By-id read: the id is the capability — unlisted sessions must
       -- resolve here too (reachable by link, absent from listings).
       AND s.visibility IN ('public', 'unlisted')
  `);
  const row = result.rows[0];
  return row ? toOccurrence(row) : null;
}
