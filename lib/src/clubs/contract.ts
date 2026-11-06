import { addDaysIso, addMonthsIso, membershipEndsOn, type IsoDate } from './dates.js';

/**
 * The club's contract with the association for the «Клубове» add-on.
 *
 * Operator decision 2026-10-31: the trial (CLUB_TRIAL_DAYS, access.ts) binds
 * nobody; to continue after it the club signs a contract for at least
 * CLUB_CONTRACT_MONTHS, invoiced monthly or yearly as the club chooses, that
 * renews for another CLUB_CONTRACT_MONTHS unless the club gives notice at
 * least CLUB_CONTRACT_NOTICE_MONTHS before the end of the running term. The
 * notice is the CLUB's: the association does not decline a renewal, and its
 * own exits are the suspension grounds of /usloviya-klubove (0061).
 *
 * The contract is signed offline; the operator records three facts on the
 * club (0061): the day it starts, the invoicing choice, and the day notice
 * was received. Everything else — when the club is bound until, the last day
 * to give notice, when a noticed contract ends — is DERIVED here, never
 * stored, like the access state. The contract gates nothing: writes still
 * follow `paid_until` (access.ts); this is what the owner, the operator and
 * the renewal reminder are told.
 *
 * A term is CLUB_CONTRACT_MONTHS of calendar months: a contract that starts
 * on 1 December 2026 renews on 1 December 2027, and its first term's last
 * day is 30 November 2027. Notice is due by the renewal day less
 * CLUB_CONTRACT_NOTICE_MONTHS (1 November 2027), inclusive. A term ends by
 * membershipEndsOn's rule (ЗЗД чл. 72, ал. 2): when the start day does not
 * exist in the target month, the term runs to that month's END — a contract
 * from 29 February 2028 binds until 28 February 2029 and renews on 1 March.
 * There is no SQL twin: db/src/clubs/mail.ts reads the two dates and calls
 * clubContractTerm.
 */

export const CLUB_CONTRACT_MONTHS = 12;
export const CLUB_CONTRACT_NOTICE_MONTHS = 1;
/** How many days before the notice deadline the owners are reminded of the renewal. */
export const CLUB_CONTRACT_REMINDER_DAYS = 30;

export const CLUB_CONTRACT_BILLING = ['monthly', 'yearly'] as const;
export type ClubContractBilling = (typeof CLUB_CONTRACT_BILLING)[number];

export interface ClubContractInput {
  startsOn: IsoDate | null;
  noticeOn: IsoDate | null;
}

export type ClubContractTerm =
  /** No contract recorded: in the trial, or not yet signed. */
  | { state: 'none' }
  /**
   * Running and renewing. Notice given on or before `noticeBy` ends the
   * contract on `boundUntil`; otherwise it renews on `renewsOn` (the day
   * after `boundUntil`) for another term.
   */
  | { state: 'running'; boundUntil: IsoDate; renewsOn: IsoDate; noticeBy: IsoDate }
  /** Notice received: the contract's last day is `endsOn`, today or later. */
  | { state: 'ending'; endsOn: IsoDate }
  /** Notice received and the last day has passed. */
  | { state: 'ended'; endsOn: IsoDate };

/** The day after term `k` (1, 2, …) ends: the next term's first day. */
function renewalDay(startsOn: IsoDate, k: number): IsoDate {
  return addDaysIso(membershipEndsOn(startsOn, { months: CLUB_CONTRACT_MONTHS * k }), 1);
}

/** The last day notice ends the contract before `renewsOn`. */
export function noticeDeadline(renewsOn: IsoDate): IsoDate {
  return addMonthsIso(renewsOn, -CLUB_CONTRACT_NOTICE_MONTHS)[0];
}

/**
 * The first renewal whose notice deadline is on or after `day`: the renewal
 * that notice given on `day` still stops. Never the start itself, so the
 * first term is always a whole CLUB_CONTRACT_MONTHS.
 */
function firstStoppableRenewal(startsOn: IsoDate, day: IsoDate): IsoDate {
  let k = 1;
  while (noticeDeadline(renewalDay(startsOn, k)) < day) k += 1;
  return renewalDay(startsOn, k);
}

export function clubContractTerm(contract: ClubContractInput, today: IsoDate): ClubContractTerm {
  if (contract.startsOn === null) return { state: 'none' };
  if (contract.noticeOn !== null) {
    const endsOn = addDaysIso(firstStoppableRenewal(contract.startsOn, contract.noticeOn), -1);
    return endsOn >= today ? { state: 'ending', endsOn } : { state: 'ended', endsOn };
  }
  const renewsOn = firstStoppableRenewal(contract.startsOn, today);
  return {
    state: 'running',
    boundUntil: addDaysIso(renewsOn, -1),
    renewsOn,
    noticeBy: noticeDeadline(renewsOn),
  };
}
