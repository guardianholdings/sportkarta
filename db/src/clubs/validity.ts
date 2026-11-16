import { sql, type SQL } from 'drizzle-orm';

/**
 * WHEN A MEMBERSHIP WAS VALID — for every figure that looks back in time: the
 * reports page (apps/web/lib/clubs/reports.ts), the owner's monthly mail and
 * the frozen monthly activity (mail.ts). `mb` is a club_membership_balances
 * row in the calling statement.
 *
 * A membership cancelled on the 20th WAS valid until the 20th: it counts for
 * that month, and its holder is someone the club then lost. Filtering on
 * "not cancelled" instead removed it from every past month the moment it was
 * cancelled — so the members who told the club they were leaving never showed
 * as churn, and retention read better than it was. Only a sale cancelled as a
 * MISTAKE never happened; and one cancelled before it began was never valid.
 *
 * One definition, here, so the page, the mail and the frozen month cannot
 * drift apart (found 2026-11-14: each had its own copy of the wrong one).
 */

/** The last day the membership was actually valid: its end, or the day it was cancelled. */
export const MEMBERSHIP_LAST_VALID_DAY: SQL = sql`least(mb.effective_ends_on,
  coalesce((mb.cancelled_at AT TIME ZONE 'Europe/Sofia')::date, mb.effective_ends_on))`;

/** The membership was valid on at least one day — whatever became of it later. */
export const MEMBERSHIP_WAS_EVER_VALID: SQL = sql`(mb.cancelled_at IS NULL
  OR (mb.cancel_reason IS DISTINCT FROM 'mistake' AND ${MEMBERSHIP_LAST_VALID_DAY} >= mb.starts_on))`;
