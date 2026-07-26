import { sql, type SQL } from '@sportkarta/db';

import { checkinWindowSql } from './checkin';
import { SessionError } from './errors';

/**
 * The organiser's roster (docs/ROADMAP.md §6, Stage 4.3).
 *
 * THIS FILE IS THE ONE PLACE ATTENDEE NAMES CROSS THE LINE. The
 * `play_session_rsvp_positions` view deliberately carries no display name —
 * its comment says who may see an attendee list is a UI rule, not the view's
 * job — and the public occurrence page shows counts only. The rule, decided
 * here: the organiser of THIS series (or an admin) sees display names,
 * because running an in-person session requires knowing who signed up, and a
 * manual check-in means tapping a person. Nobody else does, and nothing else
 * rides along: no email, no role, and deliberately no minor flag — marking
 * which attendee is a child on a screen held up in a park would disclose
 * exactly what the minors rules exist to protect.
 *
 * Authorization is read from the database in the same request (organizer_id
 * on the row, or `users.role = 'admin'` — never the session cookie), and the
 * failure is `occurrence_not_found`/`not_organizer` exactly like the QR
 * screen, which renders both as a plain 404.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export type RosterCheckinMethod = 'self' | 'organizer' | 'qr';

export interface RosterMember {
  userId: string;
  /** Display name, or null when the member never set one. */
  displayName: string | null;
  /** Queue position from the arrival-ticket view (1-based). */
  position: number;
  rsvpStatus: 'going' | 'waitlisted';
  checkinMethod: RosterCheckinMethod | null;
}

/** Checked in without an active RSVP — a QR walk-in, or someone who withdrew. */
export interface RosterWalkIn {
  userId: string;
  displayName: string | null;
  checkinMethod: RosterCheckinMethod;
}

export interface OccurrenceRoster {
  occurrenceId: string;
  sessionId: string;
  title: string;
  /** Sofia wall clock `YYYY-MM-DDTHH:MM:SS`, formatted in SQL. */
  startsAtLocal: string;
  cancelled: boolean;
  started: boolean;
  /**
   * True while `checkIn` would accept a check-in — the SAME window expression
   * it evaluates (opens 30 min early, closes 2 h after the end), so the deck
   * never offers a button the domain function would refuse.
   */
  checkinOpen: boolean;
  capacity: number | null;
  members: RosterMember[];
  walkIns: RosterWalkIn[];
  checkedInCount: number;
}

export async function occurrenceRoster(
  db: SqlRunner,
  actorId: string,
  occurrenceId: string,
): Promise<OccurrenceRoster> {
  const gate = await db.execute(sql`
    SELECT o.session_id,
           s.title,
           to_char(o.starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS') AS starts_at_local,
           (o.status = 'cancelled') AS cancelled,
           (o.starts_at <= now()) AS started,
           ${checkinWindowSql()} AS checkin_open,
           s.capacity,
           (s.organizer_id = ${actorId}) AS is_organizer,
           EXISTS (SELECT 1 FROM users u WHERE u.id = ${actorId} AND u.role = 'admin') AS is_admin
      FROM play_session_occurrences o
      JOIN play_sessions s ON s.id = o.session_id
     WHERE o.id = ${occurrenceId}::uuid
  `);
  const head = gate.rows[0];
  if (!head) throw new SessionError('occurrence_not_found');
  if (head.is_organizer !== true && head.is_admin !== true) {
    throw new SessionError('not_organizer');
  }

  // Active RSVPs in queue order, each with its check-in state. A cancelled
  // occurrence still lists its RSVPs — they are who the cancellation notice
  // went to, and the organiser may still need to reach them.
  const memberRows = await db.execute(sql`
    SELECT p.user_id,
           u.display_name,
           p.position,
           p.rsvp_status,
           c.method AS checkin_method
      FROM play_session_rsvp_positions p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN play_session_checkins c
        ON c.occurrence_id = p.occurrence_id AND c.user_id = p.user_id
     WHERE p.occurrence_id = ${occurrenceId}::uuid
     ORDER BY p.position
  `);

  // Present without an active RSVP: QR walk-ins, and members who checked in
  // and later withdrew. Attendance is a fact and stays on the deck.
  const walkInRows = await db.execute(sql`
    SELECT c.user_id, u.display_name, c.method AS checkin_method
      FROM play_session_checkins c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN play_session_rsvp_positions p
        ON p.occurrence_id = c.occurrence_id AND p.user_id = c.user_id
     WHERE c.occurrence_id = ${occurrenceId}::uuid
       AND p.rsvp_id IS NULL
     ORDER BY c.checked_in_at, c.user_id
  `);

  const members: RosterMember[] = memberRows.rows.map((row) => ({
    userId: String(row.user_id),
    displayName: row.display_name === null ? null : String(row.display_name),
    position: Number(row.position),
    rsvpStatus: row.rsvp_status === 'waitlisted' ? 'waitlisted' : 'going',
    checkinMethod:
      row.checkin_method === null ? null : (String(row.checkin_method) as RosterCheckinMethod),
  }));
  const walkIns: RosterWalkIn[] = walkInRows.rows.map((row) => ({
    userId: String(row.user_id),
    displayName: row.display_name === null ? null : String(row.display_name),
    checkinMethod: String(row.checkin_method) as RosterCheckinMethod,
  }));

  return {
    occurrenceId,
    sessionId: String(head.session_id),
    title: String(head.title),
    startsAtLocal: String(head.starts_at_local),
    cancelled: head.cancelled === true,
    started: head.started === true,
    checkinOpen: head.checkin_open === true,
    capacity: head.capacity === null || head.capacity === undefined ? null : Number(head.capacity),
    members,
    walkIns,
    checkedInCount:
      members.filter((m) => m.checkinMethod !== null).length + walkIns.length,
  };
}
