import { sql, type SQL } from '@sportkarta/db';

import { SessionError } from './errors';

/**
 * Attendance check-in (docs/ROADMAP.md §6, Stage 4.1 — schema and logic only).
 *
 * Two methods work today: `self` (the member taps "I am here") and `organizer`
 * (the organiser marks someone present). `qr` is reserved in the schema for
 * Stage 4.3's signed expiring token and is refused here until there is
 * something to verify the token against — accepting it now would be an
 * unauthenticated way to claim attendance.
 *
 * AUTHORIZATION IS THE POINT OF THIS FILE. A check-in row is a claim that a
 * named person was at a place at a time, and Stage 5's passport will score off
 * it, so writing one for somebody else must not be possible:
 *
 *  - `self` may only ever be written by the person themselves.
 *  - `organizer` may only be written by the organiser of THAT series, checked
 *    against the database in the same statement — not by any organiser, and not
 *    on a claim from the caller.
 *
 * The time window is evaluated in SQL against `now()` rather than against the
 * application's clock, so skew between the web container and the database
 * cannot open check-in early or hold it open late.
 *
 * NO POINTS ARE AWARDED. points_ledger is contribution-scoped (it requires a
 * facility_id and prices facility work); attendance scoring belongs to the
 * Stage 5 passport. Writing an award here would put an append-only, unfixable
 * row behind a pricing decision nobody has made.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export type CheckinMethod = 'self' | 'organizer';

/** Doors open half an hour early… */
export const CHECKIN_OPENS_BEFORE_MINUTES = 30;
/** …and close two hours after the end, so a late arrival is still recorded. */
export const CHECKIN_CLOSES_AFTER_MINUTES = 120;

export interface CheckinInput {
  occurrenceId: string;
  /** Who is being recorded as present. */
  userId: string;
  /** Who is making the request. */
  actorId: string;
  method?: CheckinMethod;
}

export interface CheckinResult {
  checkinId: string;
  /** False when the person was already checked in — the call is idempotent. */
  created: boolean;
}

export async function checkIn(db: SqlRunner, input: CheckinInput): Promise<CheckinResult> {
  const method = input.method ?? 'self';
  if (method !== 'self' && method !== 'organizer') {
    // Includes 'qr', which is reserved but not yet verifiable.
    throw new SessionError('invalid_checkin_method');
  }
  // Checking someone else in is an organiser action, by definition.
  if (method === 'self' && input.actorId !== input.userId) {
    throw new SessionError('not_organizer');
  }

  const context = await db.execute(sql`
    SELECT o.status,
           (o.starts_at - make_interval(mins => ${CHECKIN_OPENS_BEFORE_MINUTES}) <= now()
            AND o.ends_at + make_interval(mins => ${CHECKIN_CLOSES_AFTER_MINUTES}) >= now())
             AS within_window,
           (s.organizer_id = ${input.actorId}) AS actor_is_organizer
      FROM play_session_occurrences o
      JOIN play_sessions s ON s.id = o.session_id
     WHERE o.id = ${input.occurrenceId}::uuid
  `);
  const row = context.rows[0];
  if (!row) throw new SessionError('occurrence_not_found');
  if (row.status === 'cancelled') throw new SessionError('occurrence_cancelled');
  // Only the organiser of THIS series, read from the database.
  if (method === 'organizer' && row.actor_is_organizer !== true) {
    throw new SessionError('not_organizer');
  }
  if (row.within_window !== true) throw new SessionError('checkin_window_closed');

  // Idempotent by (occurrence_id, user_id): a double tap, a retried request or
  // two people marking the same person converge on one attendance.
  const inserted = await db.execute(sql`
    INSERT INTO play_session_checkins (occurrence_id, user_id, method, recorded_by)
    VALUES (${input.occurrenceId}::uuid, ${input.userId},
            ${method}::play_session_checkin_method,
            ${method === 'organizer' ? input.actorId : null})
    ON CONFLICT (occurrence_id, user_id) DO NOTHING
    RETURNING id
  `);
  if (inserted.rows.length > 0) {
    return { checkinId: String(inserted.rows[0]?.id), created: true };
  }

  const existing = await db.execute(sql`
    SELECT id FROM play_session_checkins
     WHERE occurrence_id = ${input.occurrenceId}::uuid AND user_id = ${input.userId}
  `);
  return { checkinId: String(existing.rows[0]?.id), created: false };
}
