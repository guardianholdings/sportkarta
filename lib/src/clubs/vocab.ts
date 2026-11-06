import type { IsoDate } from './dates.js';

/**
 * The closed vocabularies of the club module, each of which is ALSO a CHECK
 * constraint in SQL. lib/src/clubs/clubs.test.ts reads the migrations and holds
 * every list here equal to its constraint, so the two copies cannot drift.
 */

/** club_audit_action_known (0039, widened in 0045, 0046, 0048–0057). */
export const CLUB_AUDIT_ACTIONS = [
  'club_applied',
  'settings_changed',
  'location_saved',
  'location_archived',
  'kiosk_created',
  'kiosk_paired',
  'kiosk_revoked',
  'staff_invited',
  'staff_invite_revoked',
  'staff_joined',
  'staff_role_changed',
  'staff_removed',
  'member_created',
  'member_updated',
  'member_archived',
  'member_restored',
  'member_erased',
  'link_invited',
  'link_claimed',
  'link_approved',
  'link_declined',
  'link_removed',
  'erasure_requested',
  'owner_erased',
  'plan_saved',
  'plan_archived',
  'membership_sold',
  'membership_paused',
  'membership_resumed',
  'membership_cancelled',
  'charge_created',
  'charge_voided',
  'payment_recorded',
  'refund_recorded',
  'class_saved',
  'class_cancelled',
  'occurrence_cancelled',
  'booking_created',
  'booking_cancelled',
  'checkin_recorded',
  'import_committed',
  'export_downloaded',
  'ngo_admin_viewed',
  'membership_renewed',
  'renewal_stopped',
  'fee_charged',
  'time_off_saved',
  'time_off_removed',
  'faq_saved',
  'faq_removed',
  'staff_profile_changed',
  'preferences_changed',
  'payment_account_connected',
  'payment_account_disconnected',
  'checkout_started',
  'online_payment_received',
  'online_refund_issued',
  'online_payment_failed',
  'resource_saved',
  'resource_archived',
  'hours_saved',
  'service_saved',
  'service_archived',
  'reservation_created',
  'reservation_cancelled',
  'product_saved',
  'product_archived',
  'stock_moved',
  'sale_recorded',
  'sale_reversed',
  'promotion_saved',
  'promotion_archived',
  'wallet_topped_up',
  'invoice_issued',
  'credit_note_issued',
  'broadcast_saved',
  'broadcast_scheduled',
  'broadcast_cancelled',
  'automation_saved',
  'sms_settings_changed',
  'thread_started',
  'thread_closed',
  'thread_reopened',
  'inquiry_received',
  'lead_opened',
  'lead_updated',
  'lead_lost',
  'lead_reopened',
  'feedback_settings_changed',
  'event_saved',
  'event_published',
  'event_cancelled',
  'event_registered',
  'event_registration_cancelled',
  'tournament_drawn',
  'match_recorded',
  'name_visibility_changed',
  'document_saved',
  'document_versioned',
  'document_archived',
  'document_restored',
  'document_signed',
  'ladder_saved',
  'ladder_archived',
  'ladder_restored',
  'rank_saved',
  'rank_moved',
  'rank_removed',
  'rank_awarded',
  'rank_revoked',
  'api_key_created',
  'api_key_revoked',
  'webhook_saved',
  'webhook_disabled',
  'webhook_enabled',
  'webhook_removed',
  'webhook_secret_rotated',
  'door_device_created',
  'door_device_revoked',
] as const;
export type ClubAuditAction = (typeof CLUB_AUDIT_ACTIONS)[number];

/** club_audit_actor_kind_known (0039, widened in 0057: a key's creator through the key, a door). */
export const CLUB_AUDIT_ACTOR_KINDS = [
  'staff',
  'member',
  'ngo_admin',
  'system',
  'kiosk',
  'api',
  'door',
] as const;
export type ClubAuditActorKind = (typeof CLUB_AUDIT_ACTOR_KINDS)[number];

/** club_checkins_method_known (0043, widened in 0057: a door controller's scan). */
export const CLUB_CHECKIN_METHODS = [
  'qr_kiosk',
  'qr_member',
  'card',
  'desk',
  'api',
  'door',
] as const;
export type ClubCheckinMethod = (typeof CLUB_CHECKIN_METHODS)[number];

/**
 * The methods that may write a member's training log (0043): a QR or card
 * scan at the club — at the desk, or at a door controller (0057). A desk tick
 * never does (only the staff member vouched), and neither does an API call
 * (only an integration did).
 */
export const PASSPORT_CHECKIN_METHODS: readonly ClubCheckinMethod[] = [
  'qr_kiosk',
  'qr_member',
  'card',
  'door',
];

/**
 * club_payments_method_known (0041, 0050), minus the online method, which
 * only the provider records. 'wallet' is the client's prepaid credit (0050):
 * offered only where the club's tier has the wallet.
 */
export const CLUB_PAYMENT_METHODS = ['cash', 'card_desk', 'bank', 'wallet', 'other'] as const;
export type ClubPaymentMethod = (typeof CLUB_PAYMENT_METHODS)[number];

/** Every value of club_payments_method_known, the provider's included. */
export const CLUB_PAYMENT_METHODS_ALL = [...CLUB_PAYMENT_METHODS, 'card_online'] as const;

/** club_charges_kind_known (0041, widened in 0048, 0050 and 0053). */
export const CLUB_CHARGE_KINDS = [
  'membership',
  'drop_in',
  'product',
  'fee',
  'reservation',
  'wallet',
  'event',
  'other',
] as const;
export type ClubChargeKind = (typeof CLUB_CHARGE_KINDS)[number];

/** club_plans_kind_known (0041). */
export const CLUB_PLAN_KINDS = ['unlimited', 'visits', 'trial'] as const;
export type ClubPlanKind = (typeof CLUB_PLAN_KINDS)[number];

/** club_plans_audience_known (0041). */
export const CLUB_PLAN_AUDIENCES = ['all', 'adults', 'minors'] as const;
export type ClubPlanAudience = (typeof CLUB_PLAN_AUDIENCES)[number];

/** club_memberships_cancel_reason_known (0041). */
export const CLUB_CANCEL_REASONS = ['member_request', 'non_payment', 'mistake', 'other'] as const;
export type ClubCancelReason = (typeof CLUB_CANCEL_REASONS)[number];

/** club_notifications_kind_known (0044, widened in 0045, 0046, 0051, 0052, 0053, 0059 and 0061). */
export const CLUB_NOTIFICATION_KINDS = [
  'member_invite',
  'staff_invite',
  'booking_confirmed',
  'booking_promoted',
  'booking_cancelled',
  'class_cancelled',
  'reminder_24h',
  'membership_expiring',
  'membership_expired',
  'application_received',
  'application_approved',
  'operator_new_application',
  'claim_pending',
  'erasure_requested',
  'roster_daily',
  'owner_weekly',
  'membership_renewed',
  'fee_charged',
  'owner_monthly',
  'payment_received',
  'broadcast',
  'automation',
  'inbox_message',
  'inbox_reply',
  'leads_due',
  'event_registered',
  'event_promoted',
  'event_cancelled',
  'application_rejected',
  'club_trial_ending',
  'club_past_due',
  'club_lapsed',
  'club_suspended',
  'club_contract_renewing',
  'club_payments_revoked',
  'renewal_payment_failed',
] as const;
export type ClubNotificationKind = (typeof CLUB_NOTIFICATION_KINDS)[number];

/** club_notifications_channel_known (0051): how one send went out. */
export const CLUB_CHANNELS = ['email', 'sms', 'push'] as const;
export type ClubChannel = (typeof CLUB_CHANNELS)[number];

/**
 * The one builder of club_notifications.dedupe_key — "we already sent THIS".
 *
 *  * booking mail is keyed by the arrival ticket (seq), so a member who
 *    re-books after cancelling is confirmed again (0013's rsvp_seq lesson);
 *  * a reminder by occurrence and member — once per class;
 *  * an expiry or renewal notice by membership — once per sale or period;
 *  * a fee notice by charge;
 *  * digests by recipient and civil day / ISO week.
 * The shape matches club_notifications_dedupe_key_shape.
 */
export type DedupeInput =
  | {
      kind: 'booking_confirmed' | 'booking_promoted' | 'booking_cancelled';
      occurrenceId: string;
      memberId: string;
      seq: number;
    }
  | { kind: 'class_cancelled' | 'reminder_24h'; occurrenceId: string; memberId: string }
  | {
      kind: 'membership_expiring' | 'membership_expired' | 'membership_renewed';
      membershipId: string;
    }
  | { kind: 'fee_charged'; chargeId: string }
  | { kind: 'payment_received'; checkoutId: string }
  | { kind: 'member_invite'; inviteId: string }
  | { kind: 'staff_invite'; inviteId: string }
  | {
      kind:
        | 'application_received'
        | 'application_approved'
        | 'application_rejected'
        | 'operator_new_application';
      clubId: string;
      userId: string;
    }
  /**
   * The club's own standing (0059), to each owner once per milestone — the
   * day a trial ends, the day coverage ran out, the day the grace was over,
   * the day it was suspended — so a club that pays and lapses again a year
   * later is told again. The contract's renewal (0061) is anchored on the
   * renewal day, so each renewal is announced once.
   */
  | {
      kind:
        | 'club_trial_ending'
        | 'club_past_due'
        | 'club_lapsed'
        | 'club_suspended'
        | 'club_contract_renewing';
      clubId: string;
      userId: string;
      anchor: string;
    }
  | { kind: 'claim_pending'; memberId: string; userId: string }
  | { kind: 'erasure_requested'; memberId: string; userId: string }
  | { kind: 'roster_daily'; userId: string; day: IsoDate }
  | { kind: 'owner_weekly'; userId: string; week: string }
  | { kind: 'owner_monthly'; userId: string; month: string }
  /** Keyed by the RECEIVING record: a guardian of two children gets it once. */
  | { kind: 'broadcast'; broadcastId: string; recipientMemberId: string }
  /**
   * By trigger, not by automation row, and by the event answered (a
   * membership, a first visit's day, a last visit's day) — editing or
   * re-creating an automation never re-sends it.
   */
  | { kind: 'automation'; trigger: string; memberId: string; anchor: string }
  /** A member's message, to each member of staff told about it (0052). */
  | { kind: 'inbox_message'; messageId: string; userId: string }
  /** The club's answer, to the member (0052). */
  | { kind: 'inbox_reply'; messageId: string }
  /** The prospects to call today, per member of staff and Sofia day (0052). */
  | { kind: 'leads_due'; userId: string; day: IsoDate }
  /**
   * An event place (0053), by registration: a place given up and taken again
   * is a NEW registration, so it is told again.
   */
  | {
      kind: 'event_registered' | 'event_promoted' | 'event_cancelled';
      registrationId: string;
    }
  /**
   * The club revoked POPS's access in its Stripe dashboard (0062): each owner
   * once per revocation, anchored on the Sofia day it was learnt.
   */
  | { kind: 'club_payments_revoked'; clubId: string; userId: string; anchor: string }
  /**
   * Stripe could not collect a renewal (0062): the member once per invoice,
   * and each owner once per invoice (userId set) — Stripe's own retries of
   * the same invoice raise the same event again and are told once.
   */
  | { kind: 'renewal_payment_failed'; membershipId: string; invoiceRef: string; userId?: string };

export function dedupeKey(input: DedupeInput): string {
  switch (input.kind) {
    case 'booking_confirmed':
    case 'booking_promoted':
    case 'booking_cancelled':
      return `${input.kind}:${input.occurrenceId}:${input.memberId}:${String(input.seq)}`;
    case 'class_cancelled':
    case 'reminder_24h':
      return `${input.kind}:${input.occurrenceId}:${input.memberId}`;
    case 'membership_expiring':
    case 'membership_expired':
    case 'membership_renewed':
      return `${input.kind}:${input.membershipId}`;
    case 'fee_charged':
      return `${input.kind}:${input.chargeId}`;
    case 'payment_received':
      return `${input.kind}:${input.checkoutId}`;
    case 'member_invite':
    case 'staff_invite':
      return `${input.kind}:${input.inviteId}`;
    case 'application_received':
    case 'application_approved':
    case 'application_rejected':
    case 'operator_new_application':
      return `${input.kind}:${input.clubId}:${input.userId}`;
    case 'club_trial_ending':
    case 'club_past_due':
    case 'club_lapsed':
    case 'club_suspended':
    case 'club_contract_renewing':
      return `${input.kind}:${input.clubId}:${input.userId}:${input.anchor}`;
    case 'claim_pending':
    case 'erasure_requested':
      return `${input.kind}:${input.memberId}:${input.userId}`;
    case 'roster_daily':
      return `${input.kind}:${input.userId}:${input.day}`;
    case 'owner_weekly':
      return `${input.kind}:${input.userId}:${input.week}`;
    case 'owner_monthly':
      return `${input.kind}:${input.userId}:${input.month}`;
    case 'broadcast':
      return `${input.kind}:${input.broadcastId}:${input.recipientMemberId}`;
    case 'automation':
      return `${input.kind}:${input.trigger}:${input.memberId}:${input.anchor}`;
    case 'inbox_message':
      return `${input.kind}:${input.messageId}:${input.userId}`;
    case 'inbox_reply':
      return `${input.kind}:${input.messageId}`;
    case 'leads_due':
      return `${input.kind}:${input.userId}:${input.day}`;
    case 'event_registered':
    case 'event_promoted':
    case 'event_cancelled':
      return `${input.kind}:${input.registrationId}`;
    case 'club_payments_revoked':
      return `${input.kind}:${input.clubId}:${input.userId}:${input.anchor}`;
    case 'renewal_payment_failed':
      return `${input.kind}:${input.membershipId}:${input.invoiceRef}${
        input.userId ? `:${input.userId}` : ''
      }`;
  }
}
