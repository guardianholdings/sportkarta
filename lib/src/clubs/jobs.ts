/**
 * The contract between the web app (which ENQUEUES) and the worker (which
 * mails and materializes) for the club module.
 *
 * IDS ONLY. A job row outlives what it names (pg-boss keeps finished jobs until
 * archival), so a payload never carries an address, a name or a credential —
 * the worker resolves everything at run time, and a row whose subject has been
 * erased resolves to nothing.
 *
 * INVITE TOKENS ARE MINTED BY THE WORKER. The web app stores an invite with an
 * unusable placeholder hash; the worker generates the real token at send time,
 * stores its hash on the invite row and puts the token in the mail. So the
 * only copy of an invite credential is the email itself — never a queue row,
 * never a log. A retried job rotates the token, which only invalidates an
 * earlier copy of the same mail.
 */

export const CLUB_NOTIFY_QUEUE = 'club.notify';
export const CLUB_MATERIALIZE_QUEUE = 'club.materialize';
export const CLUB_REMINDERS_QUEUE = 'club.reminders';
export const CLUB_EXPIRY_QUEUE = 'club.expiry';
export const CLUB_DIGEST_QUEUE = 'club.digest';
/**
 * The owner's Monday summary. Its own queue, not a second schedule on
 * club.digest: pg-boss keys a schedule by queue name, so a second
 * `schedule()` call on one queue silently replaces the first.
 */
export const CLUB_WEEKLY_QUEUE = 'club.weekly';
export const CLUB_ACTIVITY_QUEUE = 'club.activity';
/** Daily: renew abonnements, raise no-show and late-cancel fees, mail both (0045). */
export const CLUB_POLICIES_QUEUE = 'club.policies';
/** Monthly: the owner's business-health mail for the month that closed. */
export const CLUB_HEALTH_QUEUE = 'club.health';
/**
 * A verified Stripe webhook event to apply (0046): `{ eventId }` is the
 * club_payment_events row id — the worker re-fetches the object from Stripe.
 * Also swept every 10 minutes for events whose enqueue failed.
 */
export const CLUB_PAYMENT_EVENT_QUEUE = 'club.payment_event';
/**
 * Club broadcasts whose time has come (0051), swept every five minutes; the
 * office enqueues an empty job on «Изпрати сега» so a message does not wait
 * for the sweep. The payload is always empty — the sweep reads the table.
 */
export const CLUB_BROADCASTS_QUEUE = 'club.broadcasts';
/** Daily: the clubs' automations (welcome, follow-ups, win-back), 0051. */
export const CLUB_AUTOMATIONS_QUEUE = 'club.automations';
/** Daily: each member of staff's prospects to call today (0052). */
export const CLUB_LEADS_QUEUE = 'club.leads';

export interface ClubPaymentEventJob {
  eventId?: number;
}

export type ClubNotifyJob =
  | { kind: 'application_received'; clubId: string }
  | { kind: 'application_approved'; clubId: string }
  | { kind: 'staff_invite'; inviteId: string }
  | { kind: 'member_invite'; inviteId: string }
  | { kind: 'booking_confirmed'; bookingId: string }
  | { kind: 'booking_promoted'; bookingIds: string[] }
  | { kind: 'booking_cancelled'; bookingId: string }
  | { kind: 'class_cancelled'; occurrenceIds: string[] }
  | { kind: 'claim_pending'; memberId: string }
  | { kind: 'erasure_requested'; memberId: string }
  /**
   * A message in a club thread (0052): the member's tells the staff who
   * answer, the club's tells the member. Enqueued only when the thread was
   * read up to then, so a burst of messages is one notice.
   */
  | { kind: 'inbox_message'; messageId: string };

export type ClubNotifyKind = ClubNotifyJob['kind'];

export interface ClubMaterializeJob {
  /** One class right after it was created or edited; omit for the hourly sweep. */
  classId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function uuids(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 500 && value.every(uuid);
}

/**
 * The worker's guard on what it pulls off the queue: a malformed payload is
 * dropped (and logged by kind), never half-processed.
 */
export function parseClubNotifyJob(data: unknown): ClubNotifyJob | null {
  if (!data || typeof data !== 'object') return null;
  const job = data as Record<string, unknown>;
  switch (job.kind) {
    case 'application_received':
    case 'application_approved':
      return uuid(job.clubId) ? { kind: job.kind, clubId: job.clubId } : null;
    case 'staff_invite':
    case 'member_invite':
      return uuid(job.inviteId) ? { kind: job.kind, inviteId: job.inviteId } : null;
    case 'booking_confirmed':
    case 'booking_cancelled':
      return uuid(job.bookingId) ? { kind: job.kind, bookingId: job.bookingId } : null;
    case 'booking_promoted':
      return uuids(job.bookingIds) ? { kind: job.kind, bookingIds: job.bookingIds } : null;
    case 'class_cancelled':
      return uuids(job.occurrenceIds) ? { kind: job.kind, occurrenceIds: job.occurrenceIds } : null;
    case 'claim_pending':
    case 'erasure_requested':
      return uuid(job.memberId) ? { kind: job.kind, memberId: job.memberId } : null;
    case 'inbox_message':
      return uuid(job.messageId) ? { kind: job.kind, messageId: job.messageId } : null;
    default:
      return null;
  }
}
