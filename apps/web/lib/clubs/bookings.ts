import { clubStrikesSql, sql, type SQL } from '@sportkarta/db';
import { selfBookingBlocked } from '@sportkarta/lib/clubs';

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
  | {
      ok: false;
      error: 'not_allowed' | 'closed' | 'not_open_yet' | 'started' | 'already' | 'strikes_reached';
    };

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
      // Strikes (0045): no-shows and late cancellations inside the class's
      // window. Reaching the limit stops SELF-booking only; the desk can
      // always book, and attendance is never refused.
      // The strike count is THE definition the fee job uses (clubStrikesSql):
      // only bookings made under a strike rule, only a member's own late
      // cancellation of a place, only no-shows of a place.
      const ok = await tx.execute(sql`
        SELECT k.strike_limit,
               CASE WHEN k.strike_limit IS NULL THEN 0
                    ELSE ${clubStrikesSql(sql`m.club_id`, sql`m.id`, sql`k.strike_days`)} END AS strikes
          FROM club_members m
          JOIN club_class_occurrences o ON o.club_id = m.club_id AND o.id = ${occurrenceId}::uuid
          JOIN club_classes k ON k.id = o.class_id
         WHERE m.id = ${memberId}::uuid AND ${memberSelfScope(userId, clubId, 'm')}
           AND m.archived_at IS NULL AND k.public
           ${options.trial ? sql`AND k.trial_allowed` : sql``}
           AND ${clubWritableGuard(clubId)}
      `);
      const allowed = ok.rows[0];
      if (!allowed) return { ok: false, error: 'not_allowed' } as const;
      if (
        selfBookingBlocked(
          Number(allowed.strikes),
          allowed.strike_limit === null ? null : Number(allowed.strike_limit),
        )
      ) {
        return { ok: false, error: 'strikes_reached' } as const;
      }
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
 * recorded as a fact (state 'late_cancelled'), with WHO cancelled and whether
 * the booking held a place (0047): only a member's own late cancellation of a
 * place can become a fee or a strike (db/src/clubs/policies.ts). Who may
 * cancel: the desk (bookings.manage) for anyone, or the member for a record
 * memberSelfScope admits. `by` says which. Never once the class has started:
 * the places held at the start are what a no-show is judged by, and a
 * cancellation afterwards would move someone else onto a class that is over.
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
        JOIN club_class_occurrences so ON so.id = b.occurrence_id AND so.starts_at > now()
       WHERE b.id = ${bookingId}::uuid AND b.club_id = ${clubId}::uuid AND b.state = 'active'
         AND ${
           by.kind === 'staff'
             ? clubActorMay(by.actor, 'bookings.manage', { write: false })
             : memberSelfScope(by.userId, clubId, 'm')
         }
         -- A booking the person has already attended is a fact, not a plan:
         -- it cannot be cancelled after the check-in.
         AND NOT EXISTS (SELECT 1 FROM club_checkins ci
                          WHERE ci.club_id = b.club_id AND ci.occurrence_id = b.occurrence_id
                            AND ci.member_id = b.member_id)
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
    const wasGoing = goingBefore.rows.some((r) => String(r.booking_id) === bookingId);
    const updated = await tx.execute(sql`
      UPDATE club_bookings b
         SET state = CASE WHEN o.starts_at - make_interval(hours => k.cancel_deadline_hours) < now()
                          THEN 'late_cancelled' ELSE 'cancelled' END,
             cancelled_at = now(), cancel_kind = ${by.kind === 'staff' ? 'staff' : 'member'},
             was_going = ${wasGoing}
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

export type TrialResult =
  BookingResult | { ok: false; error: 'already_trialed' | 'claim_first' | 'link_pending' };

export type SelfRecordResult =
  | { ok: true; memberId: string; created: boolean }
  | { ok: false; error: 'not_allowed' | 'claim_first' | 'link_pending' };

/**
 * The signed-in person's OWN record at a club — their active link's record,
 * or a new one (source 'self', link method 'self'). Never a duplicate: when
 * the club already keeps an unclaimed record with this verified address, the
 * person is sent to claim it instead. Locks the user row, so two tabs cannot
 * both create a record. Used by a trial booking and an online purchase.
 */
export async function ensureSelfRecord(
  tx: SqlRunner,
  userId: string,
  clubId: string,
): Promise<SelfRecordResult> {
  const person = await tx.execute(sql`
    SELECT coalesce(nullif(btrim(u.display_name), ''), split_part(u.email, '@', 1)) AS name,
           CASE WHEN u.email_verified THEN lower(u.email) END AS email
      FROM users u WHERE u.id = ${userId} FOR NO KEY UPDATE
  `);
  const me = person.rows[0];
  if (!me) return { ok: false, error: 'not_allowed' };
  const link = await tx.execute(sql`
    SELECT member_id, status FROM club_member_links
     WHERE club_id = ${clubId}::uuid AND user_id = ${userId} AND status <> 'declined'
  `);
  const existing = link.rows[0];
  if (existing) {
    if (existing.status === 'pending') return { ok: false, error: 'link_pending' };
    if (existing.status !== 'active') return { ok: false, error: 'not_allowed' };
    return { ok: true, memberId: String(existing.member_id), created: false };
  }
  const email = me.email === null || me.email === undefined ? null : String(me.email);
  if (email) {
    const unclaimed = await tx.execute(sql`
      SELECT 1 FROM club_members m
       WHERE m.club_id = ${clubId}::uuid AND m.email = ${email} AND m.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM club_member_links l WHERE l.member_id = m.id)
    `);
    if (unclaimed.rows.length > 0) return { ok: false, error: 'claim_first' };
  }
  const created = await tx.execute(sql`
    INSERT INTO club_members (club_id, display_name, email, source)
    SELECT ${clubId}::uuid, ${String(me.name).slice(0, 120)}, ${email}, 'self'
     WHERE ${clubWritableGuard(clubId)}
    RETURNING id
  `);
  const memberId = created.rows[0] ? String(created.rows[0].id) : null;
  if (!memberId) return { ok: false, error: 'not_allowed' };
  await tx.execute(sql`
    INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
    VALUES (${memberId}::uuid, ${clubId}::uuid, ${userId}, 'active', 'self')
  `);
  await recordClubAudit(tx, {
    clubId,
    by: { kind: 'member', userId },
    action: 'member_created',
    subjectMemberId: memberId,
    detail: { source: 'self' },
  });
  return { ok: true, memberId, created: true };
}

/**
 * A trial class booked from the public class page. The signed-in person books
 * for THEMSELVES only: their linked record if they have one here, otherwise a
 * new record of their own (source 'self', link method 'self') — the lead the
 * desk follows up. Never a duplicate: when the club already keeps an
 * unclaimed record with this verified address, the person is sent to claim
 * it instead. One trial per person per club.
 */
export async function bookTrial(
  db: TransactionalDb,
  userId: string,
  clubId: string,
  occurrenceId: string,
): Promise<TrialResult> {
  try {
    return await db.transaction(async (tx) => {
      const open = await tx.execute(sql`
        SELECT 1 FROM club_class_occurrences o JOIN club_classes k ON k.id = o.class_id
         WHERE o.id = ${occurrenceId}::uuid AND o.club_id = ${clubId}::uuid
           AND k.public AND k.trial_allowed AND ${clubWritableGuard(clubId)}
      `);
      if (open.rows.length === 0) return { ok: false, error: 'not_allowed' } as const;
      // One person's trial in one club at a time: ensureSelfRecord locks the
      // user row, so two tabs cannot both pass the "no trial yet" check below.
      const self = await ensureSelfRecord(tx, userId, clubId);
      if (!self.ok) return self;
      const memberId = self.memberId;

      const tried = await tx.execute(sql`
        SELECT 1 FROM club_bookings
         WHERE club_id = ${clubId}::uuid AND member_id = ${memberId}::uuid AND is_trial
      `);
      if (tried.rows.length > 0) return { ok: false, error: 'already_trialed' } as const;
      const bookingId = await upsertBooking(tx, clubId, occurrenceId, memberId, null, true);
      if (!bookingId) return { ok: false, error: 'already' } as const;
      await recordClubAudit(tx, {
        clubId,
        by: { kind: 'member', userId },
        action: 'booking_created',
        subjectMemberId: memberId,
        detail: { occurrenceId, trial: true },
      });
      return { ok: true, bookingId, status: await statusOf(tx, bookingId) } as const;
    });
  } catch (error: unknown) {
    const mapped = bookingErrorCode(error);
    if (mapped) return mapped;
    throw error;
  }
}
