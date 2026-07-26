import { getDb, sql } from '@sportkarta/db';

/**
 * The read behind the public session page (docs/ROADMAP.md §6, Stage 4.2).
 *
 * WHAT THIS DELIBERATELY DOES NOT RETURN: an attendee list. Migration 0008 says
 * it in the view's own comment — who may see who is coming is a UI rule, not
 * the view's job — and the pattern-of-life rule decides that rule here: a
 * public page that names a person next to a place and a time publishes where
 * they reliably are on a Tuesday evening. That is true of every member at every
 * age, which is why removing the minors boundary (0020) changed nothing here.
 * The page shows COUNTS, plus the viewer's own position, and nothing about
 * anybody else. Not even a first name.
 *
 * The organiser is named, because somebody has to be answerable for a session
 * strangers are being invited to, and organising one is a public act.
 */

export interface OccurrenceView {
  occurrenceId: string;
  sessionId: string;
  title: string;
  description: string | null;
  sport: string;
  skillLevel: string;
  /** Sofia wall clock `YYYY-MM-DDTHH:MM:SS` — formatted in SQL, never re-read. */
  startsAtLocal: string;
  startsAt: string;
  durationMinutes: number;
  cancelled: boolean;
  /** True once it has started; RSVP closes then. */
  started: boolean;
  facilityName: string | null;
  facilitySlug: string | null;
  organizerName: string | null;
  capacity: number | null;
  going: number;
  waitlisted: number;
  /** The viewer's own place, or null when they are not attending. */
  viewerPosition: number | null;
  viewerStatus: 'going' | 'waitlisted' | null;
  viewerIsOrganizer: boolean;
}

export interface SessionSummary {
  occurrenceId: string;
  title: string;
  sport: string;
  /** Sofia wall clock `YYYY-MM-DDTHH:MM:SS`, formatted in SQL. */
  startsAtLocal: string;
  facilityName: string | null;
  facilitySlug: string | null;
  capacity: number | null;
  going: number;
}

/**
 * Upcoming PUBLIC session occurrences, soonest first — the read behind the
 * `/sesii` index (the discovery surface the audit found missing). Same
 * visibility + cancellation rules as the single-occurrence page: `public`
 * sessions only, non-cancelled occurrences, in the future. No attendee names —
 * a count only, exactly as the occurrence view is careful to.
 */
export async function listUpcomingSessions(limit = 40): Promise<SessionSummary[]> {
  const result = await getDb().execute(sql`
    SELECT
      o.id AS occurrence_id,
      to_char(o.starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
      s.title, s.sport, s.capacity::int AS capacity,
      f.name AS facility_name, f.slug AS facility_slug,
      (SELECT count(*)::int FROM play_session_rsvp_positions p
        WHERE p.occurrence_id = o.id AND p.rsvp_status = 'going') AS going
    FROM play_session_occurrences o
    JOIN play_sessions s ON s.id = o.session_id
    JOIN facilities f ON f.id = s.facility_id
    WHERE s.visibility = 'public'
      AND o.status <> 'cancelled'
      AND o.starts_at > now()
    ORDER BY o.starts_at
    LIMIT ${limit}
  `);
  return result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      occurrenceId: String(row.occurrence_id),
      title: String(row.title),
      sport: String(row.sport),
      startsAtLocal: String(row.starts_at_local),
      facilityName: (row.facility_name as string | null) ?? null,
      facilitySlug: (row.facility_slug as string | null) ?? null,
      capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
      going: Number(row.going ?? 0),
    };
  });
}

export async function occurrenceView(
  occurrenceId: string,
  viewerId: string | null,
): Promise<OccurrenceView | null> {
  const result = await getDb().execute(sql`
    SELECT
      o.id AS occurrence_id,
      o.session_id,
      to_char(o.starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
      o.starts_at,
      (o.status = 'cancelled') AS cancelled,
      (o.starts_at <= now()) AS started,
      s.title, s.description, s.sport, s.skill_level, s.duration_minutes,
      s.capacity::int AS capacity,
      f.name AS facility_name, f.slug AS facility_slug,
      -- The organiser's display name, or NULL if they erased their account —
      -- in which case a trigger has already cancelled the series (0008), so the
      -- page shows a cancelled session with nobody named, which is the truth.
      u.display_name AS organizer_name,
      (s.organizer_id IS NOT DISTINCT FROM ${viewerId}) AS viewer_is_organizer,
      (SELECT count(*)::int FROM play_session_rsvp_positions p
        WHERE p.occurrence_id = o.id AND p.rsvp_status = 'going') AS going,
      (SELECT count(*)::int FROM play_session_rsvp_positions p
        WHERE p.occurrence_id = o.id AND p.rsvp_status = 'waitlisted') AS waitlisted,
      (SELECT p.position::int FROM play_session_rsvp_positions p
        WHERE p.occurrence_id = o.id AND p.user_id = ${viewerId}) AS viewer_position,
      (SELECT p.rsvp_status FROM play_session_rsvp_positions p
        WHERE p.occurrence_id = o.id AND p.user_id = ${viewerId}) AS viewer_status
    FROM play_session_occurrences o
    JOIN play_sessions s ON s.id = o.session_id
    JOIN facilities f ON f.id = s.facility_id
    LEFT JOIN users u ON u.id = s.organizer_id
    WHERE o.id = ${occurrenceId}::uuid
      AND s.visibility = 'public'
  `);
  const row = result.rows[0];
  if (!row) return null;

  return {
    occurrenceId: String(row.occurrence_id),
    sessionId: String(row.session_id),
    title: String(row.title),
    description: (row.description as string | null) ?? null,
    sport: String(row.sport),
    skillLevel: String(row.skill_level),
    startsAtLocal: String(row.starts_at_local),
    startsAt: new Date(row.starts_at as string | number | Date).toISOString(),
    durationMinutes: Number(row.duration_minutes),
    cancelled: row.cancelled === true,
    started: row.started === true,
    facilityName: (row.facility_name as string | null) ?? null,
    facilitySlug: (row.facility_slug as string | null) ?? null,
    organizerName: (row.organizer_name as string | null) ?? null,
    capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
    going: Number(row.going ?? 0),
    waitlisted: Number(row.waitlisted ?? 0),
    viewerPosition: row.viewer_position === null ? null : Number(row.viewer_position),
    viewerStatus:
      row.viewer_status === 'going' || row.viewer_status === 'waitlisted'
        ? row.viewer_status
        : null,
    // `IS NOT DISTINCT FROM` treats NULL = NULL as true, which would make an
    // anonymous visitor the organiser of an orphaned series. Guarded here.
    viewerIsOrganizer: viewerId !== null && row.viewer_is_organizer === true,
  };
}
