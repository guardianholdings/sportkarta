import { addDaysIso, daysBetween, type IsoDate } from './dates.js';

/**
 * A club's access state — derived, never stored (0039's header).
 *
 * The operator invoices by bank transfer and records the outcome as
 * `paid_until` (operator decision 2026-10-24); a newly approved club gets an
 * automatic trial (`trial_ends_on`). Every tier is paid (operator decision
 * 2026-10-31: no free plan, a one-month trial on each), so everything a club
 * may do follows from those two dates and its status:
 *
 *   pending    applied, awaiting the operator. Office readable, nothing writable.
 *   trial      inside the trial and not yet paid past it. Full use.
 *   active     paid through today.
 *   past_due   coverage ended ≤ CLUB_GRACE_DAYS ago. Full use + a warning.
 *   lapsed     the grace is over. Read-only; the public page is withdrawn.
 *   suspended  the operator stopped it. Read-only; the public page is withdrawn.
 *   archived   closed. The owner can export for 90 days, then it is purged.
 *
 * THE SQL TWIN of `canWrite` is clubWritableSql in apps/web/lib/clubs/access.ts:
 *   status = 'active' AND greatest(paid_until, trial_ends_on) + 14 >= today
 * and apps/web/tests/journeys/clubs-access.test.ts holds the two equal over a
 * grid of tiers, statuses and dates.
 */

export const CLUB_GRACE_DAYS = 14;
export const CLUB_TRIAL_DAYS = 30;
/**
 * How long an ARCHIVED club's data is kept for the owner to export before the
 * nightly purge deletes it (apps/web/lib/clubs/admin.ts) — the figure the
 * clubs terms and the privacy notice print, so it lives beside the other two.
 */
export const CLUB_PURGE_AFTER_DAYS = 90;

export const CLUB_STATUSES = ['pending', 'active', 'suspended', 'archived'] as const;
export type ClubStatus = (typeof CLUB_STATUSES)[number];

export const CLUB_TIERS = ['community', 'standard', 'pro'] as const;
export type ClubTier = (typeof CLUB_TIERS)[number];

export const CLUB_KINDS = ['gym', 'studio', 'club', 'trainer', 'other'] as const;
export type ClubKind = (typeof CLUB_KINDS)[number];

export type ClubAccessState =
  'pending' | 'trial' | 'active' | 'past_due' | 'lapsed' | 'suspended' | 'archived';

export interface ClubAccessInput {
  status: ClubStatus;
  tier: ClubTier;
  trialEndsOn: IsoDate | null;
  paidUntil: IsoDate | null;
}

function later(a: IsoDate | null, b: IsoDate | null): IsoDate | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

export function clubAccessState(club: ClubAccessInput, today: IsoDate): ClubAccessState {
  if (club.status === 'pending') return 'pending';
  if (club.status === 'suspended') return 'suspended';
  if (club.status === 'archived') return 'archived';
  if (club.paidUntil !== null && club.paidUntil >= today) return 'active';
  if (club.trialEndsOn !== null && club.trialEndsOn >= today) return 'trial';
  const coverage = later(club.paidUntil, club.trialEndsOn);
  if (coverage !== null && addDaysIso(coverage, CLUB_GRACE_DAYS) >= today) return 'past_due';
  return 'lapsed';
}

/** Whether the office may change anything. */
export function canWrite(state: ClubAccessState): boolean {
  return state === 'trial' || state === 'active' || state === 'past_due';
}

/** Whether the public page, the facility block and the kiosk are live. */
export function isLive(state: ClubAccessState): boolean {
  return canWrite(state);
}

/**
 * Days until writes stop (trial end, paid-until, or grace end), or null when
 * already read-only.
 */
export function daysUntilReadOnly(club: ClubAccessInput, today: IsoDate): number | null {
  const state = clubAccessState(club, today);
  if (!canWrite(state)) return null;
  const coverage = later(club.paidUntil, club.trialEndsOn);
  if (coverage === null) return null;
  return daysBetween(today, addDaysIso(coverage, CLUB_GRACE_DAYS));
}
