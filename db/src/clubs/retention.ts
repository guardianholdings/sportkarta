import { sql, type SQL } from 'drizzle-orm';

/**
 * What the club module FORGETS, and when (audit 2026-10-30, retention).
 * Nightly, from the worker's club.integrations_prune job. Three tables grew
 * without end and two of them kept a person's trace past any use:
 *
 *  - club_checkouts that never carried money — `open` sessions Stripe closed
 *    long ago (a session lives a day; a hold 35 minutes) and `expired` ones —
 *    after 90 days. Paid and `unapplied` rows STAY: they are the link between
 *    a payment in the books and the account it went to (the office refund
 *    path reads it), and the office's list of money to give back.
 *  - club_staff_invites that are over — accepted, revoked or expired — after
 *    30 days: an accepted one has done its work (the grant is in club_staff),
 *    and the address on a dead one is kept for nothing.
 *  - club_notifications about a date that has passed — a class reminder, a
 *    cancelled class, a booking's own notices, a day's roster, the desk's
 *    leads list, an event's notices — after a year. Their dedupe keys name a
 *    past occurrence, booking, day or registration and are never reused, so
 *    forgetting them re-sends nothing. Every other kind (an invitation, an
 *    abonnement's notices, a broadcast's, an automation's) keeps its row: the
 *    key may recur, and the row is what stops a second send.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** The ledger kinds whose keys name a day that has passed. */
export const DATED_NOTIFICATION_KINDS = [
  'booking_confirmed',
  'booking_promoted',
  'booking_cancelled',
  'class_cancelled',
  'reminder_24h',
  'roster_daily',
  'leads_due',
  'event_registered',
  'event_promoted',
  'event_cancelled',
] as const;

export interface RetentionPruneReport {
  checkouts: number;
  staffInvites: number;
  notifications: number;
}

export async function pruneClubRetention(db: SqlRunner): Promise<RetentionPruneReport> {
  const checkouts = await db.execute(sql`
    DELETE FROM club_checkouts
     WHERE status IN ('open', 'expired') AND created_at < now() - interval '90 days'
    RETURNING 1
  `);
  const invites = await db.execute(sql`
    DELETE FROM club_staff_invites
     WHERE coalesce(accepted_at, revoked_at, expires_at) < now() - interval '30 days'
    RETURNING 1
  `);
  const notifications = await db.execute(sql`
    DELETE FROM club_notifications
     WHERE kind = ANY(${sql.param([...DATED_NOTIFICATION_KINDS])}::text[])
       AND sent_at < now() - interval '1 year'
    RETURNING 1
  `);
  return {
    checkouts: checkouts.rows.length,
    staffInvites: invites.rows.length,
    notifications: notifications.rows.length,
  };
}
