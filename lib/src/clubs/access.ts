import { addDaysIso, daysBetween, type IsoDate } from './dates.js';

/**
 * A club's access state — derived, never stored (0039's header).
 *
 * The operator invoices by bank transfer and records the outcome as
 * `paid_until` (operator decision 2026-10-24); a new paid-tier club gets an
 * automatic trial (`trial_ends_on`). Everything a club may do follows from
 * those two dates, its tier and its status:
 *
 *   pending    applied, awaiting the operator. Office readable, nothing writable.
 *   trial      inside the trial and not yet paid past it. Full use.
 *   active     community tier (free, never lapses), or paid through today.
 *   past_due   coverage ended ≤ CLUB_GRACE_DAYS ago. Full use + a warning.
 *   lapsed     the grace is over. Read-only; the public page is withdrawn.
 *   suspended  the operator stopped it. Read-only; the public page is withdrawn.
 *   archived   closed. The owner can export for 90 days, then it is purged.
 *
 * THE SQL TWIN of `canWrite` is CLUB_WRITABLE in apps/web/lib/clubs/access.ts:
 *   status = 'active' AND (tier = 'community'
 *                          OR greatest(paid_until, trial_ends_on) + 14 >= today)
 * and a DB-backed test holds the two equal over a grid of dates.
 */

export const CLUB_GRACE_DAYS = 14;
export const CLUB_TRIAL_DAYS = 30;

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
  if (club.tier === 'community') return 'active';
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
 * nothing ends (community tier, or already read-only).
 */
export function daysUntilReadOnly(club: ClubAccessInput, today: IsoDate): number | null {
  const state = clubAccessState(club, today);
  if (!canWrite(state) || club.tier === 'community') return null;
  const coverage = later(club.paidUntil, club.trialEndsOn);
  if (coverage === null) return null;
  return daysBetween(today, addDaysIso(coverage, CLUB_GRACE_DAYS));
}
