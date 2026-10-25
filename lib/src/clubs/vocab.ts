import type { IsoDate } from './dates.js';

/**
 * The closed vocabularies of the club module, each of which is ALSO a CHECK
 * constraint in SQL. lib/src/clubs/vocab.test.ts reads the migrations and holds
 * every list here equal to its constraint, so the two copies cannot drift.
 */

/** club_audit_action_known (0039, widened in 0045, 0046, 0048 and 0049). */
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
] as const;
export type ClubAuditAction = (typeof CLUB_AUDIT_ACTIONS)[number];

/** club_audit_actor_kind_known (0039). */
export const CLUB_AUDIT_ACTOR_KINDS = ['staff', 'member', 'ngo_admin', 'system', 'kiosk'] as const;
export type ClubAuditActorKind = (typeof CLUB_AUDIT_ACTOR_KINDS)[number];

/** club_checkins_method_known (0043). */
export const CLUB_CHECKIN_METHODS = ['qr_kiosk', 'qr_member', 'card', 'desk', 'api'] as const;
export type ClubCheckinMethod = (typeof CLUB_CHECKIN_METHODS)[number];

/**
 * The methods that may write a member's training log (0043): a QR or card
 * scan at the club. A desk tick never does — only the staff member vouched.
 */
export const PASSPORT_CHECKIN_METHODS: readonly ClubCheckinMethod[] = [
  'qr_kiosk',
  'qr_member',
  'card',
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

/** club_charges_kind_known (0041). */
export const CLUB_CHARGE_KINDS = [
  'membership',
  'drop_in',
  'product',
  'fee',
  'reservation',
  'wallet',
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

/** club_notifications_kind_known (0044, widened in 0045 and 0046). */
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
] as const;
export type ClubNotificationKind = (typeof CLUB_NOTIFICATION_KINDS)[number];

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
      kind: 'application_received' | 'application_approved' | 'operator_new_application';
      clubId: string;
      userId: string;
    }
  | { kind: 'claim_pending'; memberId: string; userId: string }
  | { kind: 'erasure_requested'; memberId: string; userId: string }
  | { kind: 'roster_daily'; userId: string; day: IsoDate }
  | { kind: 'owner_weekly'; userId: string; week: string }
  | { kind: 'owner_monthly'; userId: string; month: string };

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
    case 'operator_new_application':
      return `${input.kind}:${input.clubId}:${input.userId}`;
    case 'claim_pending':
    case 'erasure_requested':
      return `${input.kind}:${input.memberId}:${input.userId}`;
    case 'roster_daily':
      return `${input.kind}:${input.userId}:${input.day}`;
    case 'owner_weekly':
      return `${input.kind}:${input.userId}:${input.week}`;
    case 'owner_monthly':
      return `${input.kind}:${input.userId}:${input.month}`;
  }
}
