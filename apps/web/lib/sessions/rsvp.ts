import { sql, type SQL } from '@sportkarta/db';

import { SessionError } from './errors';

/**
 * RSVP and waitlist (docs/ROADMAP.md §6, Stage 4.1).
 *
 * There is deliberately very little logic here, because the design puts it in
 * the schema: an RSVP draws an arrival ticket, position is `row_number()` over
 * the active rows, and going/waitlisted is read from the view
 * `play_session_rsvp_positions`. Nothing in this file decides who is going, so
 * nothing in this file can get it wrong, race another request, or need a lock.
 *
 * Concretely: joining a full session is not an error. It is a waitlist place,
 * and if somebody ahead withdraws the promotion happens with no code running —
 * the row_number simply shifts.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export type RsvpStatus = 'going' | 'waitlisted';

export interface RsvpResult {
  rsvpId: string;
  position: number;
  status: RsvpStatus;
}

/**
 * Join, or re-join after withdrawing. A re-join draws a FRESH ticket
 * (`nextval`) and goes to the back of the queue — leaving and rejoining must
 * not jump anyone who has been waiting since.
 *
 * The database refuses an RSVP to a cancelled or already-started occurrence
 * (play_session_rsvps_occurrence_open), so the guard here is for the message,
 * not for the rule.
 */
export async function rsvp(
  db: SqlRunner,
  userId: string,
  occurrenceId: string,
): Promise<RsvpResult> {
  await assertOccurrenceOpen(db, occurrenceId);

  const inserted = await db.execute(sql`
    INSERT INTO play_session_rsvps (occurrence_id, user_id)
    VALUES (${occurrenceId}::uuid, ${userId})
    ON CONFLICT (occurrence_id, user_id) DO UPDATE
      SET state = 'active',
          withdrawn_at = NULL,
          updated_at = now(),
          -- Only a re-join redraws the ticket. An idempotent repeat of the same
          -- request must not push the person to the back of their own queue.
          seq = CASE WHEN play_session_rsvps.state = 'withdrawn'
                     THEN nextval('play_session_rsvp_seq')
                     ELSE play_session_rsvps.seq END
    RETURNING id
  `);
  const rsvpId = String(inserted.rows[0]?.id);
  return { rsvpId, ...(await positionOf(db, occurrenceId, userId)) };
}

/** Leave. The next person on the waitlist is promoted by arithmetic, not code. */
export async function withdraw(db: SqlRunner, userId: string, occurrenceId: string): Promise<void> {
  const result = await db.execute(sql`
    UPDATE play_session_rsvps
       SET state = 'withdrawn', withdrawn_at = now(), updated_at = now()
     WHERE occurrence_id = ${occurrenceId}::uuid AND user_id = ${userId} AND state = 'active'
    RETURNING id
  `);
  if (result.rows.length === 0) throw new SessionError('not_attending');
}

async function assertOccurrenceOpen(db: SqlRunner, occurrenceId: string): Promise<void> {
  const result = await db.execute(sql`
    SELECT status, (starts_at <= now()) AS started
      FROM play_session_occurrences WHERE id = ${occurrenceId}::uuid
  `);
  const row = result.rows[0];
  if (!row) throw new SessionError('occurrence_not_found');
  if (row.status === 'cancelled') throw new SessionError('occurrence_cancelled');
  if (row.started === true) throw new SessionError('occurrence_started');
}

async function positionOf(
  db: SqlRunner,
  occurrenceId: string,
  userId: string,
): Promise<{ position: number; status: RsvpStatus }> {
  const result = await db.execute(sql`
    SELECT position, rsvp_status FROM play_session_rsvp_positions
     WHERE occurrence_id = ${occurrenceId}::uuid AND user_id = ${userId}
  `);
  const row = result.rows[0];
  if (!row) throw new SessionError('not_attending');
  return { position: Number(row.position), status: row.rsvp_status as RsvpStatus };
}

export interface AttendanceCounts {
  going: number;
  waitlisted: number;
  capacity: number | null;
}

/** What the occurrence page shows. One scan of the view, no second source. */
export async function attendanceCounts(
  db: SqlRunner,
  occurrenceId: string,
): Promise<AttendanceCounts> {
  // Capacity comes from the series, not from `max(capacity)` over the position
  // rows: with nobody signed up yet there are no rows, and the answer would be
  // NULL — indistinguishable from "unlimited".
  const result = await db.execute(sql`
    SELECT
      (SELECT count(*) FILTER (WHERE p.rsvp_status = 'going')
         FROM play_session_rsvp_positions p
        WHERE p.occurrence_id = o.id)::int AS going,
      (SELECT count(*) FILTER (WHERE p.rsvp_status = 'waitlisted')
         FROM play_session_rsvp_positions p
        WHERE p.occurrence_id = o.id)::int AS waitlisted,
      s.capacity::int AS capacity
    FROM play_session_occurrences o
    JOIN play_sessions s ON s.id = o.session_id
    WHERE o.id = ${occurrenceId}::uuid
  `);
  const row = result.rows[0] ?? {};
  return {
    going: Number(row.going ?? 0),
    waitlisted: Number(row.waitlisted ?? 0),
    capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
  };
}
