import { frozenStreakWeeks, passportEvents, passportTotals, sql, type SQL } from '@sportkarta/db';
import { evaluateBadges, LAUNCH_BADGES, passportStreaks } from '@sportkarta/lib/badges';

import { clubsEnabled } from '@/lib/clubs/access';
import { checkinWindowSql } from '@/lib/sessions/checkin';

/**
 * The signed-in member's strip at the top of the front page: what is next in
 * their calendar, their week streak and their badges.
 *
 * READ-ONLY. ownPassport() also records newly earned badges so that the
 * passport can mark them «ново» once; this summary folds the same events
 * through the same catalogue but writes nothing, so the passport stays the one
 * place that decides a badge has been seen. It skips the history list too —
 * the strip shows three numbers, not a timeline.
 *
 * «Next» means a place the member HOLDS: a session they are going to, a class
 * they are booked into — never one they are only waitlisted for, which would
 * send them to a door with no spot behind it. Both positions views derive
 * going/waitlisted with a window over the whole occurrence, so each query first
 * narrows to the account's own occurrences and only then asks the view —
 * an occurrence filter reaches inside the window, an account filter cannot.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export type NextUp =
  | {
      kind: 'session';
      href: string;
      title: string;
      sport: string;
      startsAtLocal: string;
      place: string | null;
    }
  | {
      kind: 'club';
      href: string;
      title: string;
      club: string;
      startsAtLocal: string;
      place: string;
    };

/** An игра the member signed up for whose check-in is open right now. */
export interface OpenCheckin {
  title: string;
  place: string | null;
}

export interface HomePersonal {
  next: NextUp | null;
  /**
   * Set while an игра they signed up for is inside its check-in window
   * and they have not checked in: the home's one call to action then is
   * «Сканирай кода» (UX audit N4, «today-first»).
   */
  checkin: OpenCheckin | null;
  streakWeeks: number;
  /** The week streak is alive but this week is still empty. */
  weeksAtRisk: boolean;
  earned: number;
  total: number;
  /** Earned badge slugs, most recent first, at most three. */
  latestBadges: string[];
  points: number;
}

/** A next-up candidate and its instant, so the sooner of two can be picked. */
interface Candidate {
  item: NextUp;
  startsAt: number;
}

async function nextSession(db: SqlRunner, userId: string): Promise<Candidate | null> {
  const result = await db.execute(sql`
    SELECT o.id, o.starts_at,
           to_char(o.starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
           s.title, s.sport, f.name AS facility_name
      FROM play_session_rsvps r
      JOIN play_session_occurrences o ON o.id = r.occurrence_id
      JOIN play_sessions s ON s.id = o.session_id
      JOIN facilities f ON f.id = s.facility_id
     WHERE r.user_id = ${userId}
       AND r.state = 'active'
       AND o.status <> 'cancelled'
       AND o.starts_at > now()
       AND EXISTS (SELECT 1 FROM play_session_rsvp_positions p
                    WHERE p.occurrence_id = o.id AND p.user_id = ${userId}
                      AND p.rsvp_status = 'going')
     ORDER BY o.starts_at
     LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    item: {
      kind: 'session',
      href: `/igra/${String(row.id)}`,
      title: String(row.title),
      sport: String(row.sport),
      startsAtLocal: String(row.starts_at_local),
      place: row.facility_name === null ? null : String(row.facility_name),
    },
    startsAt: new Date(row.starts_at as string | number | Date).getTime(),
  };
}

/**
 * An RSVP of this account whose occurrence is inside the check-in window now
 * (the same fragment the check-in page and the roster ask — checkinWindowSql)
 * and that has no check-in yet. Waitlisted RSVPs count too: attendance is
 * always recorded, whoever turns up (CLAUDE.md, Stage 5.4).
 */
async function openCheckin(db: SqlRunner, userId: string): Promise<OpenCheckin | null> {
  const result = await db.execute(sql`
    SELECT s.title, f.name AS facility_name
      FROM play_session_rsvps r
      JOIN play_session_occurrences o ON o.id = r.occurrence_id
      JOIN play_sessions s ON s.id = o.session_id
      JOIN facilities f ON f.id = s.facility_id
     WHERE r.user_id = ${userId}
       AND r.state = 'active'
       AND o.status <> 'cancelled'
       AND ${checkinWindowSql()}
       AND NOT EXISTS (SELECT 1 FROM play_session_checkins c
                        WHERE c.occurrence_id = o.id AND c.user_id = ${userId})
     ORDER BY o.starts_at
     LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    title: String(row.title),
    place: row.facility_name === null ? null : String(row.facility_name),
  };
}

/**
 * The next club class booked through an ACTIVE link of this account — its own
 * record, or a child whose guardian is that record. The calendar feed's rule
 * (db/src/sessions/calendar.ts), so the strip and the feed cannot disagree.
 */
async function nextClubClass(
  db: SqlRunner,
  userId: string,
  locale: string,
): Promise<Candidate | null> {
  if (!clubsEnabled()) return null;
  const result = await db.execute(sql`
    SELECT o.starts_at,
           to_char(o.starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
           k.title, l.name AS location, c.slug,
           CASE WHEN ${locale} = 'en' THEN coalesce(c.name_en, c.name_bg) ELSE c.name_bg END AS club
      FROM club_bookings b
      JOIN club_members m ON m.club_id = b.club_id AND m.id = b.member_id
      JOIN club_class_occurrences o ON o.club_id = b.club_id AND o.id = b.occurrence_id
      JOIN club_classes k ON k.id = o.class_id
      JOIN club_locations l ON l.id = k.location_id
      JOIN clubs c ON c.id = b.club_id AND c.status <> 'archived'
     WHERE b.state = 'active'
       AND o.status = 'scheduled'
       AND o.starts_at > now()
       AND (EXISTS (SELECT 1 FROM club_member_links ml
                     WHERE ml.member_id = m.id AND ml.user_id = ${userId} AND ml.status = 'active')
            OR EXISTS (SELECT 1 FROM club_member_links gl
                        WHERE gl.member_id = m.guardian_member_id AND gl.user_id = ${userId}
                          AND gl.status = 'active'))
       AND EXISTS (SELECT 1 FROM club_booking_positions p
                    WHERE p.occurrence_id = b.occurrence_id AND p.booking_id = b.id
                      AND p.booking_status = 'going')
     ORDER BY o.starts_at
     LIMIT 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    item: {
      kind: 'club',
      href: `/klub/${String(row.slug)}/az`,
      title: String(row.title),
      club: String(row.club),
      startsAtLocal: String(row.starts_at_local),
      place: String(row.location),
    },
    startsAt: new Date(row.starts_at as string | number | Date).getTime(),
  };
}

export async function homePersonal(
  db: SqlRunner,
  userId: string,
  locale: string,
  now: Date = new Date(),
): Promise<HomePersonal> {
  const [events, frozen, totals, session, club, checkin] = await Promise.all([
    passportEvents(db, userId),
    frozenStreakWeeks(db, userId),
    passportTotals(db, userId),
    nextSession(db, userId),
    nextClubClass(db, userId, locale),
    openCheckin(db, userId),
  ]);

  // One set of forgiven weeks for the badges and the streak, as on /pasport.
  const badges = evaluateBadges(LAUNCH_BADGES, events, { now, frozen });
  const streaks = passportStreaks(events, { now, frozen });
  const earned = badges
    .filter((badge) => badge.earnedAt !== null)
    .sort((a, b) => (b.earnedAt?.getTime() ?? 0) - (a.earnedAt?.getTime() ?? 0));

  const sooner = [session, club]
    .filter((candidate): candidate is Candidate => candidate !== null)
    .sort((a, b) => a.startsAt - b.startsAt)[0];

  return {
    next: sooner?.item ?? null,
    checkin,
    streakWeeks: streaks.weeks.current,
    weeksAtRisk: streaks.weeks.atRisk,
    earned: earned.length,
    total: badges.length,
    latestBadges: earned.slice(0, 3).map((badge) => badge.slug),
    points: totals.points,
  };
}
