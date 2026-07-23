import { APP_TIME_ZONE } from './age.js';

/**
 * Points model for the contribution layer (docs/ROADMAP.md §5: "idempotent
 * points_ledger"). No spending mechanics — the ledger only records what was
 * earned, and every row is append-only.
 *
 * The award is keyed, not counted: each key may exist at most once in the
 * ledger (UNIQUE index), so a retried server action, a double-submitted form or
 * two concurrent tabs converge on exactly one award. That property is what
 * lib/src/points.test.ts and db/src/points-ledger.test.ts pin down.
 */

export const POINTS_EVENTS = [
  'facility_added',
  'facility_verified',
  'condition_reported',
  'session_attended',
] as const;

export type PointsEvent = (typeof POINTS_EVENTS)[number];

export function isPointsEvent(value: unknown): value is PointsEvent {
  return typeof value === 'string' && (POINTS_EVENTS as readonly string[]).includes(value);
}

/**
 * Adding a facility is the scarcest and most valuable contribution, so it is
 * worth the most; condition reports are the cheapest and most repeatable.
 *
 * Attendance (Stage 5.4) is priced like a condition report — repeatable, weekly,
 * and worth encouraging without making the leaderboard a measure of free time.
 * It is only ever awarded for a QR-verified check-in, which the database
 * enforces (play_session_checkins_only_qr_scores).
 */
export const POINTS_BY_EVENT: Record<PointsEvent, number> = {
  facility_added: 10,
  facility_verified: 3,
  condition_reported: 2,
  session_attended: 2,
};

/**
 * How many attendance awards one member may earn in a Sofia day (Stage 5.4).
 *
 * Proportionate, in both directions: three sessions a day is more than almost
 * anybody plays and well within reach of somebody who genuinely does, so the
 * cap costs an honest member nothing while bounding what a compromised QR is
 * worth. Going over it does NOT refuse the check-in — attendance is a fact and
 * is always recorded — it only stops paying, exactly as repeat condition
 * reports do.
 */
export const ATTENDANCE_AWARDS_PER_DAY = 3;

export interface AwardKeyInput {
  event: PointsEvent;
  facilityId: string;
  userId: string;
  /** Only condition reports need a day bucket; ignored for the other events. */
  now?: Date;
  /** Required for `session_attended`, which is keyed by occurrence. */
  occurrenceId?: string;
}

/** Civil date in Europe/Sofia — the same day boundary the rest of the product uses. */
function sofiaDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * The uniqueness rule per event, expressed as a key:
 *
 *  - `facility_added`    once per facility, ever — a facility can only be new once.
 *  - `facility_verified` once per person per facility — re-verifying later is
 *                        welcome and useful, but it is not a second award.
 *  - `condition_reported` once per person per facility per day — this is also
 *                        the anti-farming rule: repeat reports still record the
 *                        condition, they just stop paying.
 *  - `session_attended`  once per person per OCCURRENCE, ever. Not per day and
 *                        not per facility: the occurrence is the natural bound,
 *                        and it is one nobody can widen, because occurrences
 *                        are written only by the materialize job from a
 *                        validated recurrence rule (migration 0008). A member
 *                        cannot invent a session to be paid for attending.
 */
export function awardKey({
  event,
  facilityId,
  userId,
  now = new Date(),
  occurrenceId,
}: AwardKeyInput): string {
  switch (event) {
    case 'facility_added':
      return `facility_added:${facilityId}`;
    case 'facility_verified':
      return `facility_verified:${facilityId}:${userId}`;
    case 'condition_reported':
      return `condition_reported:${facilityId}:${userId}:${sofiaDay(now)}`;
    case 'session_attended':
      if (!occurrenceId) {
        // Falling back to the facility would key one award per person per
        // FACILITY for ever, silently paying only for somebody's first
        // Tuesday and never again.
        throw new Error('session_attended requires an occurrenceId');
      }
      return `session_attended:${occurrenceId}:${userId}`;
  }
}
