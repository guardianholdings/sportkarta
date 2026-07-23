import { goingUserIds, sql, type SQL } from '@sportkarta/db';

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
 *
 * STAGE 4.2 ADDS THE ONE THING THAT DESIGN COSTS: because promotion happens by
 * arithmetic, there is no event to hook, so `withdraw` has to work out who was
 * promoted by comparing who was going either side of the update. Two concurrent
 * withdrawals can compute overlapping sets; that is deliberately not locked
 * away, because the notification ledger dedupes the send
 * (play_session_notifications), so the race costs a wasted query and never a
 * duplicate email. Sending itself never happens here — these functions return
 * who to tell, and the caller enqueues.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export type RsvpStatus = 'going' | 'waitlisted';

export interface RsvpResult {
  rsvpId: string;
  position: number;
  status: RsvpStatus;
  /** The arrival ticket, which the notification ledger is keyed by. */
  seq: number;
  /**
   * True when this call actually joined, rather than repeating a join that was
   * already active. A double-submitted form must not send a second
   * confirmation email — the ledger would refuse it anyway, since an idempotent
   * repeat keeps the same arrival ticket, but not enqueuing is cheaper and says
   * what is meant.
   */
  joined: boolean;
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
  db: TransactionalDb,
  userId: string,
  occurrenceId: string,
): Promise<RsvpResult> {
  await assertOccurrenceOpen(db, occurrenceId);

  return db.transaction(async (tx) => {
    // Read the prior state under a row lock, rather than trying to infer it
    // from the upsert. `xmax = 0` would separate INSERT from UPDATE but not a
    // re-join from an idempotent repeat, and `updated_at > created_at` is true
    // for both — the repeat moves updated_at too. FOR UPDATE also serialises a
    // double-submitted form, so the second request sees `active` and reports
    // joined:false instead of racing to the same conclusion.
    const existing = await tx.execute(sql`
      SELECT state FROM play_session_rsvps
       WHERE occurrence_id = ${occurrenceId}::uuid AND user_id = ${userId}
       FOR UPDATE
    `);
    const wasActive = existing.rows[0]?.state === 'active';

    const inserted = await tx.execute(sql`
      INSERT INTO play_session_rsvps (occurrence_id, user_id)
      VALUES (${occurrenceId}::uuid, ${userId})
      ON CONFLICT (occurrence_id, user_id) DO UPDATE
        SET state = 'active',
            withdrawn_at = NULL,
            updated_at = now(),
            -- Only a re-join redraws the ticket. An idempotent repeat of the
            -- same request must not push the person to the back of their own
            -- queue.
            seq = CASE WHEN play_session_rsvps.state = 'withdrawn'
                       THEN nextval('play_session_rsvp_seq')
                       ELSE play_session_rsvps.seq END
      RETURNING id
    `);
    const rsvpId = String(inserted.rows[0]?.id);
    const position = await positionOf(tx, occurrenceId, userId);
    return { rsvpId, ...position, joined: !wasActive };
  });
}

export interface WithdrawResult {
  /**
   * Members who moved from waitlisted to going as a result. Usually zero or
   * one; more only if capacity moved at the same time. The caller enqueues a
   * `promoted` notification for each — nobody finds out they are in by
   * refreshing the page.
   */
  promoted: string[];
}

/**
 * Leave. The next person on the waitlist is promoted by arithmetic, not code —
 * so the only honest way to learn who that was is to read `going` before and
 * after, inside one transaction.
 */
export async function withdraw(
  db: TransactionalDb,
  userId: string,
  occurrenceId: string,
): Promise<WithdrawResult> {
  return db.transaction(async (tx) => {
    const before = new Set(await goingUserIds(tx, occurrenceId));
    const result = await tx.execute(sql`
      UPDATE play_session_rsvps
         SET state = 'withdrawn', withdrawn_at = now(), updated_at = now()
       WHERE occurrence_id = ${occurrenceId}::uuid AND user_id = ${userId} AND state = 'active'
      RETURNING id
    `);
    if (result.rows.length === 0) throw new SessionError('not_attending');

    const after = await goingUserIds(tx, occurrenceId);
    // The withdrawer is in `before` and not in `after`, so they cannot appear
    // here; everyone else who is newly going was promoted by the shift.
    return { promoted: after.filter((id) => !before.has(id)) };
  });
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
): Promise<{ position: number; status: RsvpStatus; seq: number }> {
  const result = await db.execute(sql`
    SELECT position, rsvp_status, seq FROM play_session_rsvp_positions
     WHERE occurrence_id = ${occurrenceId}::uuid AND user_id = ${userId}
  `);
  const row = result.rows[0];
  if (!row) throw new SessionError('not_attending');
  return {
    position: Number(row.position),
    status: row.rsvp_status as RsvpStatus,
    // The arrival ticket, carried out so the caller can key the notification
    // ledger by it — that is what lets a re-join be confirmed again.
    seq: Number(row.seq),
  };
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
