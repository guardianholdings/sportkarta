import { addDaysIso, membershipEndsOn, type IsoDate } from './dates.js';

/**
 * A club's membership and booking policies as pure arithmetic (0045).
 *
 * RENEWAL. A renewing abonnement is a chain of memberships; the club.renewals
 * job appends the next period when the current one ends. A member's notice
 * NEVER shortens a period already sold: it fixes the last day the contract
 * runs, and the job keeps renewing every period that STARTS on or before that
 * day. With a 30-day notice given on 25 October on a calendar-month plan, the
 * November period still starts (1 November ≤ 24 November) and December does
 * not — the common gym contract. A minimum term pushes the last day out to the
 * end of the term, counted from the chain's first day.
 *
 * NO-SHOWS. A strike is a no-show or a late cancellation inside the class's
 * strike window. Reaching the limit stops SELF-booking only; attendance is
 * never refused and the desk can always book (CLAUDE.md's rule for check-ins
 * applied to bookings).
 */

/** The longest pause a member may set themselves from the portal. */
export const SELF_PAUSE_MAX_DAYS = 60;

export interface ContractTerms {
  noticeDays: number;
  minTermMonths: number | null;
  /** First day of the renewing chain; null for a one-off sale. */
  termStartedOn: IsoDate | null;
}

/** The last day the contract runs when notice is given on `today`. */
export function contractEndsOn(today: IsoDate, terms: ContractTerms): IsoDate {
  const afterNotice = addDaysIso(today, terms.noticeDays);
  if (terms.minTermMonths === null || terms.termStartedOn === null) return afterNotice;
  const termEnds = membershipEndsOn(terms.termStartedOn, { months: terms.minTermMonths });
  return termEnds > afterNotice ? termEnds : afterNotice;
}

/** Whether a period starting on `nextStart` is still under contract. */
export function renewsInto(nextStart: IsoDate, renewalEndsOn: IsoDate | null): boolean {
  return renewalEndsOn === null || nextStart <= renewalEndsOn;
}

/** Whether `strikes` inside the window have reached the class's limit. */
export function selfBookingBlocked(strikes: number, limit: number | null): boolean {
  return limit !== null && strikes >= limit;
}

export interface PauseRequest {
  startsOn: IsoDate;
  days: number;
}

/**
 * A member's own pause, validated against the portal's limits: it starts
 * today or later and lasts 1..SELF_PAUSE_MAX_DAYS days. The database still
 * decides whether it lies inside the membership (0041's trigger).
 */
export function selfPauseRange(
  request: PauseRequest,
  today: IsoDate,
): { startsOn: IsoDate; endsOn: IsoDate } | null {
  if (request.startsOn < today) return null;
  if (!Number.isInteger(request.days) || request.days < 1 || request.days > SELF_PAUSE_MAX_DAYS) {
    return null;
  }
  return { startsOn: request.startsOn, endsOn: addDaysIso(request.startsOn, request.days - 1) };
}
