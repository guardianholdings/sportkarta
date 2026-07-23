import { sql, type SQL } from '@sportkarta/db';
import { zonedToInstant } from '@sportkarta/lib/recurrence';

import { SessionError } from './errors';
import { normalizeSession, type NormalizedSession, type SessionInput } from './session-input';

/**
 * Creating, editing and cancelling a session series (docs/ROADMAP.md §6).
 *
 * No UI here — Stage 4.1 is schema and logic. These are the functions the
 * organiser screens in 4.2 will call, and the ones the tests exercise.
 *
 * Occurrences are NEVER written from this file. They are produced only by the
 * `session.materialize` job, which is what keeps one implementation of the
 * recurrence rules in the system. Create and edit enqueue that job so the
 * organiser does not wait for the hourly schedule.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/** Enqueue hook, injected so the logic is testable without a running pg-boss. */
export type Enqueue = (queue: string, data: Record<string, unknown>) => Promise<void>;

export const MATERIALIZE_QUEUE = 'session.materialize';
export const NOTIFY_QUEUE = 'session.notify';

const noopEnqueue: Enqueue = async () => undefined;

function count(result: { rows: Record<string, unknown>[] }): number {
  const value = result.rows[0]?.n;
  return typeof value === 'number' ? value : Number(value ?? 0);
}

async function assertFacilityUsable(db: SqlRunner, facilityId: string): Promise<void> {
  const result = await db.execute(
    sql`SELECT status FROM facilities WHERE id = ${facilityId}::uuid`,
  );
  const status = result.rows[0]?.status;
  if (status === undefined) throw new SessionError('facility_not_found');
  // A facility somebody reported as gone must not collect new sessions.
  if (status === 'gone') throw new SessionError('facility_gone');
}

export interface CreateSessionResult {
  sessionId: string;
}

export async function createSession(
  db: TransactionalDb,
  organizerId: string,
  input: SessionInput,
  enqueue: Enqueue = noopEnqueue,
): Promise<CreateSessionResult> {
  const normalized = normalizeSession(input);
  // A series whose first occurrence is already behind us would materialize
  // nothing and confuse everyone who saw the form accept it.
  if (firstInstantOf(normalized).getTime() <= Date.now()) {
    throw new SessionError('start_in_past');
  }
  const sessionId = await db.transaction(async (tx) => {
    await assertFacilityUsable(tx, normalized.facilityId);
    const inserted = await tx.execute(sql`
      INSERT INTO play_sessions (
        facility_id, sport, organizer_id, title, description,
        starts_at_local, timezone, rrule, duration_minutes, capacity,
        skill_level, visibility
      ) VALUES (
        ${normalized.facilityId}::uuid, ${normalized.sport}, ${organizerId},
        ${normalized.title}, ${normalized.description},
        ${normalized.startsAtLocal}::timestamp, ${normalized.timezone},
        ${normalized.rrule}, ${normalized.durationMinutes}, ${normalized.capacity},
        ${normalized.skillLevel}::play_session_skill,
        ${normalized.visibility}::play_session_visibility
      )
      RETURNING id
    `);
    return String(inserted.rows[0]?.id);
  });

  await enqueue(MATERIALIZE_QUEUE, { sessionId });
  return { sessionId };
}

/**
 * Edit a series. `materialized_through` is cleared so the next run re-expands
 * from scratch and reconciles: occurrences the new rule no longer produces are
 * removed if nobody signed up, and cancelled if anyone did.
 */
export async function updateSession(
  db: TransactionalDb,
  actorId: string,
  sessionId: string,
  input: SessionInput,
  enqueue: Enqueue = noopEnqueue,
): Promise<void> {
  const normalized = normalizeSession(input);
  await db.transaction(async (tx) => {
    await requireOrganizerOrAdmin(tx, actorId, sessionId);
    await assertFacilityUsable(tx, normalized.facilityId);
    await tx.execute(sql`
      UPDATE play_sessions SET
        facility_id = ${normalized.facilityId}::uuid,
        sport = ${normalized.sport},
        title = ${normalized.title},
        description = ${normalized.description},
        starts_at_local = ${normalized.startsAtLocal}::timestamp,
        rrule = ${normalized.rrule},
        duration_minutes = ${normalized.durationMinutes},
        capacity = ${normalized.capacity},
        skill_level = ${normalized.skillLevel}::play_session_skill,
        visibility = ${normalized.visibility}::play_session_visibility,
        materialized_through = NULL,
        updated_at = now()
      WHERE id = ${sessionId}::uuid
    `);
  });
  await enqueue(MATERIALIZE_QUEUE, { sessionId });
}

/**
 * The organiser, or an admin.
 *
 * The role is read FROM THE DATABASE in the same statement, never taken from
 * the caller or a session cookie (CLAUDE.md). An earlier shape of this function
 * accepted an `actorIsAdmin` boolean, which was a trap: the obvious call site
 * would have passed `requireAdmin()`, and `requireAdmin()` means "ambassador or
 * admin" — handing every ambassador the power to cancel any session in the
 * country.
 *
 * Ambassadors are deliberately NOT included. Their authority is the
 * municipalities in `ambassador_municipalities` and it is about moderating
 * facility data; a pickup session is not a moderation object, and there is no
 * municipality on a session to scope against. Giving them a national power here
 * would quietly break the scope model that lib/moderation.ts enforces in SQL.
 * If session moderation is wanted later, it needs the same scoped join, not
 * this function.
 */
async function requireOrganizerOrAdmin(
  db: SqlRunner,
  actorId: string,
  sessionId: string,
): Promise<void> {
  const result = await db.execute(sql`
    SELECT s.status,
           (s.organizer_id = ${actorId}) AS is_organizer,
           EXISTS (SELECT 1 FROM users u WHERE u.id = ${actorId} AND u.role = 'admin') AS is_admin
      FROM play_sessions s WHERE s.id = ${sessionId}::uuid
  `);
  const row = result.rows[0];
  if (!row) throw new SessionError('session_not_found');
  if (row.is_organizer !== true && row.is_admin !== true) {
    throw new SessionError('not_organizer');
  }
  if (row.status === 'cancelled') throw new SessionError('already_cancelled');
}

export interface CancellationResult {
  /** People holding an active RSVP who need telling. Counts only, never names. */
  recipientCount: number;
  occurrencesCancelled: number;
}

/**
 * Cancel the WHOLE series. The database does the cascade
 * (play_sessions_cancel_cascade): future occurrences are cancelled with
 * scope='series' and past ones are left alone, because they happened.
 *
 * A cancelled series is never un-cancelled — create a new one. That keeps the
 * cascade one-directional and means nobody is ever re-invited to something they
 * were told was off.
 */
export async function cancelSeries(
  db: TransactionalDb,
  actorId: string,
  sessionId: string,
  options: { enqueue?: Enqueue } = {},
): Promise<CancellationResult> {
  const enqueue = options.enqueue ?? noopEnqueue;
  const result = await db.transaction(async (tx) => {
    await requireOrganizerOrAdmin(tx, actorId, sessionId);

    // Counted BEFORE the cascade runs, while the occurrences are still
    // scheduled — afterwards there is nothing left to identify them by.
    const recipients = count(
      await tx.execute(sql`
        SELECT count(DISTINCT r.user_id)::int AS n
          FROM play_session_rsvps r
          JOIN play_session_occurrences o ON o.id = r.occurrence_id
         WHERE o.session_id = ${sessionId}::uuid
           AND o.status = 'scheduled'
           AND o.starts_at > now()
           AND r.state = 'active'
      `),
    );
    const affected = count(
      await tx.execute(sql`
        SELECT count(*)::int AS n FROM play_session_occurrences
         WHERE session_id = ${sessionId}::uuid AND status = 'scheduled' AND starts_at > now()
      `),
    );

    // The authorization is repeated as a predicate, so the decision and the
    // write cannot be separated by a concurrent change of organiser.
    await tx.execute(sql`
      UPDATE play_sessions SET status = 'cancelled', updated_at = now()
       WHERE id = ${sessionId}::uuid
         AND status = 'scheduled'
         AND (organizer_id = ${actorId}
              OR EXISTS (SELECT 1 FROM users u WHERE u.id = ${actorId} AND u.role = 'admin'))
    `);

    return { recipientCount: recipients, occurrencesCancelled: affected };
  });

  await enqueue(NOTIFY_QUEUE, {
    sessionId,
    reason: 'series_cancelled',
    recipientCount: result.recipientCount,
  });
  return result;
}

/**
 * Cancel ONE occurrence — this week is off, the series continues. The
 * materializer will not put it back: the row stays, and the UNIQUE on
 * (session_id, starts_at) makes every re-run a no-op for it.
 */
export async function cancelOccurrence(
  db: TransactionalDb,
  actorId: string,
  occurrenceId: string,
  options: { enqueue?: Enqueue } = {},
): Promise<CancellationResult> {
  const enqueue = options.enqueue ?? noopEnqueue;
  const result = await db.transaction(async (tx) => {
    const owner = await tx.execute(sql`
      SELECT o.session_id, o.status, (o.starts_at <= now()) AS started,
             (s.organizer_id = ${actorId}) AS is_organizer,
             EXISTS (SELECT 1 FROM users u WHERE u.id = ${actorId} AND u.role = 'admin') AS is_admin
        FROM play_session_occurrences o
        JOIN play_sessions s ON s.id = o.session_id
       WHERE o.id = ${occurrenceId}::uuid
    `);
    const row = owner.rows[0];
    if (!row) throw new SessionError('occurrence_not_found');
    if (row.is_organizer !== true && row.is_admin !== true) {
      throw new SessionError('not_organizer');
    }
    if (row.status === 'cancelled') throw new SessionError('already_cancelled');
    // A session that already happened cannot be un-happened. Cancelling it
    // would rewrite the attendance record the series cascade deliberately
    // leaves alone, and would void those check-ins for the Stage 5 passport.
    if (row.started === true) throw new SessionError('occurrence_started');

    const recipients = count(
      await tx.execute(sql`
        SELECT count(*)::int AS n FROM play_session_rsvps
         WHERE occurrence_id = ${occurrenceId}::uuid AND state = 'active'
      `),
    );

    await tx.execute(sql`
      UPDATE play_session_occurrences o
         SET status = 'cancelled', cancelled_at = now(), cancellation_scope = 'occurrence'
       WHERE o.id = ${occurrenceId}::uuid
         AND o.status = 'scheduled'
         AND o.starts_at > now()
         AND EXISTS (
           SELECT 1 FROM play_sessions s
            WHERE s.id = o.session_id
              AND (s.organizer_id = ${actorId}
                   OR EXISTS (SELECT 1 FROM users u WHERE u.id = ${actorId} AND u.role = 'admin')))
    `);

    return { recipientCount: recipients, occurrencesCancelled: 1 };
  });

  await enqueue(NOTIFY_QUEUE, {
    occurrenceId,
    reason: 'occurrence_cancelled',
    recipientCount: result.recipientCount,
  });
  return result;
}

/**
 * The first instant a series produces, for "starts in the past" checks at the
 * form layer. Uses the same conversion the materializer does, so the answer
 * cannot disagree with the occurrences that get written.
 */
export function firstInstantOf(normalized: NormalizedSession): Date {
  return new Date(zonedToInstant(normalized.dtstart, normalized.timezone).instantMs);
}
