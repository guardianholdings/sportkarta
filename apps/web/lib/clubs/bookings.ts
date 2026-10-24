import { sql, type SQL } from '@sportkarta/db';

import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import { clubWritableGuard } from './access';
import { clubActorMay, memberSelfScope, type ClubActor } from './scope';

/**
 * Bookings on a club class (0042). The ORDER is an arrival ticket; going and
 * waitlisted are derived (club_booking_positions), so booking and cancelling
 * are single-row writes and promotion needs no code — only the MAIL does, so
 * a cancellation diffs who was going on either side of it (the play-session
 * `withdraw` pattern) and returns the newly seated for the worker to tell.
 *
 * Two doors: the desk books anyone (and may book before the window opens; the
 * 0042 trigger reads booked_by); a linked member books themselves or their
 * child from the portal, inside the window.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export type BookingResult =
  | { ok: true; bookingId: string; status: 'going' | 'waitlisted' }
  | { ok: false; error: 'not_allowed' | 'closed' | 'not_open_yet' | 'started' | 'already' };

function bookingErrorCode(error: unknown): BookingResult | null {
  const constraint = violatedConstraint(error);
  if (constraint === 'club_bookings_window_open') return { ok: false, error: 'not_open_yet' };
  if (constraint === 'club_bookings_occurrence_future') return { ok: false, error: 'started' };
  if (constraint === 'club_bookings_occurrence_scheduled') return { ok: false, error: 'closed' };
  return null;
}

/** Book, or re-activate a cancelled booking (the trigger issues a fresh ticket). */
async function upsertBooking(
  tx: SqlRunner,
  clubId: string,
  occurrenceId: string,
  memberId: string,
  bookedBy: string | null,
  isTrial: boolean,
): Promise<string | null> {
  const result = await tx.execute(sql`
    INSERT INTO club_bookings (club_id, occurrence_id, member_id, booked_by, is_trial)
    VALUES (${clubId}::uuid, ${occurrenceId}::uuid, ${memberId}::uuid, ${bookedBy}, ${isTrial})
    ON CONFLICT (occurrence_id, member_id) DO UPDATE
       SET state = 'active', cancelled_at = NULL, booked_by = EXCLUDED.booked_by,
           is_trial = EXCLUDED.is_trial
     WHERE club_bookings.state <> 'active'
    RETURNING id
  `);
  return result.rows[0]?.id ? String(result.rows[0].id) : null;
}

async function statusOf(tx: SqlRunner, bookingId: string): Promise<'going' | 'waitlisted'> {
  const row = await tx.execute(sql`
    SELECT booking_status FROM club_booking_positions WHERE booking_id = ${bookingId}::uuid
  `);
  return row.rows[0]?.booking_status === 'waitlisted' ? 'waitlisted' : 'going';
}

export async function bookAtDesk(
  db: TransactionalDb,
  actor: ClubActor,
  occurrenceId: string,
  memberId: string,
): Promise<BookingResult> {
  try {
    return await db.transaction(async (tx) => {
      const ok = await tx.execute(sql`
        SELECT 1 FROM club_members m
          JOIN club_class_occurrences o ON o.club_id = m.club_id AND o.id = ${occurrenceId}::uuid
         WHERE m.club_id = ${actor.clubId}::uuid AND m.id = ${memberId}::uuid
           AND m.archived_at IS NULL
           AND ${clubActorMay(actor, 'bookings.manage', { write: true })}
      `);
      if (ok.rows.length === 0) return { ok: false, error: 'not_allowed' } as const;
      const bookingId = await upsertBooking(
        tx,
        actor.clubId,
        occurrenceId,
        memberId,
        actor.userId,
        false,
      );
      if (!bookingId) return { ok: false, error: 'already' } as const;
      await recordClubAudit(tx, {
        clubId: actor.clubId,
        by: { kind: 'staff', actor },
        action: 'booking_created',
        subjectMemberId: memberId,
        detail: { occurrenceId },
      });
      return { ok: true, bookingId, status: await statusOf(tx, bookingId) } as const;
    });
  } catch (error: unknown) {
    const mapped = bookingErrorCode(error);
    if (mapped) return mapped;
    throw error;
  }
}

/**
 * A member books from the portal — themselves or a child under their record.
 * memberSelfScope decides which records the account may book for; the class
 * must be public and the club operating.
 */
export async function bookSelf(
  db: TransactionalDb,
  userId: string,
  clubId: string,
  occurrenceId: string,
  memberId: string,
  options: { trial?: boolean } = {},
): Promise<BookingResult> {
  try {
    return await db.transaction(async (tx) => {
      const ok = await tx.execute(sql`
        SELECT 1 FROM club_members m
          JOIN club_class_occurrences o ON o.club_id = m.club_id AND o.id = ${occurrenceId}::uuid
          JOIN club_classes k ON k.id = o.class_id
         WHERE m.id = ${memberId}::uuid AND ${memberSelfScope(userId, clubId, 'm')}
           AND m.archived_at IS NULL AND k.public
           ${options.trial ? sql`AND k.trial_allowed` : sql``}
           AND ${clubWritableGuard(clubId)}
      `);
      if (ok.rows.length === 0) return { ok: false, error: 'not_allowed' } as const;
      const bookingId = await upsertBooking(
        tx,
        clubId,
        occurrenceId,
        memberId,
        null,
        options.trial ?? false,
      );
      if (!bookingId) return { ok: false, error: 'already' } as const;
      await recordClubAudit(tx, {
        clubId,
        by: { kind: 'member', userId },
        action: 'booking_created',
        subjectMemberId: memberId,
        detail: { occurrenceId, trial: options.trial ?? false },
      });
      return { ok: true, bookingId, status: await statusOf(tx, bookingId) } as const;
    });
  } catch (error: unknown) {
    const mapped = bookingErrorCode(error);
    if (mapped) return mapped;
    throw error;
  }
}

export interface CancelResult {
  cancelled: boolean;
  late: boolean;
  /** Bookings that moved from waitlisted to going — the worker mails them. */
  promoted: string[];
}

/**
 * Cancel a booking. LATE if it is inside the class's cancellation deadline —
 * recorded as a fact (state 'late_cancelled'), charged nothing in v1. Who may
 * cancel: the desk (bookings.manage) for anyone, or the member for a record
 * memberSelfScope admits. `by` says which.
 */
export async function cancelBooking(
  db: TransactionalDb,
  by: { kind: 'staff'; actor: ClubActor } | { kind: 'member'; userId: string; clubId: string },
  bookingId: string,
): Promise<CancelResult> {
  const clubId = by.kind === 'staff' ? by.actor.clubId : by.clubId;
  return db.transaction(async (tx) => {
    const target = await tx.execute(sql`
      SELECT b.occurrence_id, b.member_id FROM club_bookings b
        JOIN club_members m ON m.club_id = b.club_id AND m.id = b.member_id
       WHERE b.id = ${bookingId}::uuid AND b.club_id = ${clubId}::uuid AND b.state = 'active'
         AND ${
           by.kind === 'staff'
             ? clubActorMay(by.actor, 'bookings.manage', { write: false })
             : memberSelfScope(by.userId, clubId, 'm')
         }
       FOR UPDATE OF b
    `);
    const row = target.rows[0];
    if (!row) return { cancelled: false, late: false, promoted: [] };
    const occurrenceId = String(row.occurrence_id);
    const goingBefore = await tx.execute(sql`
      SELECT booking_id FROM club_booking_positions
       WHERE club_id = ${clubId}::uuid AND occurrence_id = ${occurrenceId}::uuid
         AND booking_status = 'going'
    `);
    const updated = await tx.execute(sql`
      UPDATE club_bookings b
         SET state = CASE WHEN o.starts_at - make_interval(hours => k.cancel_deadline_hours) < now()
                          THEN 'late_cancelled' ELSE 'cancelled' END,
             cancelled_at = now()
        FROM club_class_occurrences o JOIN club_classes k ON k.id = o.class_id
       WHERE b.id = ${bookingId}::uuid AND o.id = b.occurrence_id
       RETURNING b.state
    `);
    const late = updated.rows[0]?.state === 'late_cancelled';
    const goingAfter = await tx.execute(sql`
      SELECT booking_id FROM club_booking_positions
       WHERE club_id = ${clubId}::uuid AND occurrence_id = ${occurrenceId}::uuid
         AND booking_status = 'going'
    `);
    const before = new Set(goingBefore.rows.map((r) => String(r.booking_id)));
    const promoted = goingAfter.rows
      .map((r) => String(r.booking_id))
      .filter((id) => !before.has(id));
    await recordClubAudit(tx, {
      clubId,
      by:
        by.kind === 'staff'
          ? { kind: 'staff', actor: by.actor }
          : { kind: 'member', userId: by.userId },
      action: 'booking_cancelled',
      subjectMemberId: String(row.member_id),
      detail: { occurrenceId, late },
    });
    return { cancelled: true, late, promoted };
  });
}
