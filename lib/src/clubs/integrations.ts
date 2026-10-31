import type { ClubPermission } from './permissions.js';

/**
 * The club API, webhooks and door access (wave H1, 0057) — the closed
 * vocabularies and the pure rules. Client-safe: the key, token and signature
 * helpers that need node:crypto live in `./secrets`.
 *
 * A KEY ACTS AS THE MEMBER OF STAFF WHO CREATED IT, narrowed to its scopes.
 * Each scope names the office permission the request needs, and the request
 * runs the office's own scoped statements with the creator's CURRENT role —
 * so a scope never grants anything the creator could not do in the office
 * today. A scope missing from the key is refused before any statement runs;
 * a permission missing from the role makes the statement match nothing.
 */

/** club_api_keys_scopes_known (0057). */
export const CLUB_API_SCOPES = [
  'members:read',
  'members:write',
  'schedule:read',
  'bookings:write',
  'attendance:read',
  'attendance:write',
  'payments:read',
] as const;
export type ClubApiScope = (typeof CLUB_API_SCOPES)[number];

/** The office permission each scope stands for. */
export const CLUB_API_SCOPE_PERMISSION: Readonly<Record<ClubApiScope, ClubPermission>> = {
  'members:read': 'members.view',
  'members:write': 'members.manage',
  'schedule:read': 'schedule.view',
  'bookings:write': 'bookings.manage',
  'attendance:read': 'roster.view',
  'attendance:write': 'attendance.record',
  'payments:read': 'payments.view',
};

export function isClubApiScope(value: unknown): value is ClubApiScope {
  return typeof value === 'string' && (CLUB_API_SCOPES as readonly string[]).includes(value);
}

/** Live keys a club may hold at once. */
export const CLUB_API_KEYS_MAX = 10;
export const CLUB_API_KEY_NAME_MAX = 60;

/** club_webhook_endpoints_events_known and club_webhook_deliveries_event_known (0057). */
export const CLUB_WEBHOOK_EVENTS = [
  'member.created',
  'member.updated',
  'member.deleted',
  'booking.created',
  'booking.cancelled',
  'checkin.created',
  'membership.created',
  'payment.created',
] as const;
export type ClubWebhookEvent = (typeof CLUB_WEBHOOK_EVENTS)[number];

export function isClubWebhookEvent(value: unknown): value is ClubWebhookEvent {
  return typeof value === 'string' && (CLUB_WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** The scope an integrator needs to fetch what an event names. */
export const CLUB_WEBHOOK_EVENT_SCOPE: Readonly<Record<ClubWebhookEvent, ClubApiScope>> = {
  'member.created': 'members:read',
  'member.updated': 'members:read',
  'member.deleted': 'members:read',
  'booking.created': 'attendance:read',
  'booking.cancelled': 'attendance:read',
  'checkin.created': 'attendance:read',
  'membership.created': 'members:read',
  'payment.created': 'payments:read',
};

/** Endpoints a club may hold at once. */
export const CLUB_WEBHOOK_ENDPOINTS_MAX = 5;
export const CLUB_WEBHOOK_DESCRIPTION_MAX = 60;

/** club_webhook_deliveries_state_known (0057). */
export const CLUB_WEBHOOK_DELIVERY_STATES = ['pending', 'delivered', 'failed'] as const;
export type ClubWebhookDeliveryState = (typeof CLUB_WEBHOOK_DELIVERY_STATES)[number];

/** club_webhook_deliveries_error_known (0057). */
export const CLUB_WEBHOOK_DELIVERY_ERRORS = [
  'timeout',
  'dns',
  'address_blocked',
  'connection',
  'tls',
  'http_status',
  'redirect',
  'endpoint_disabled',
  'not_configured',
] as const;
export type ClubWebhookDeliveryError = (typeof CLUB_WEBHOOK_DELIVERY_ERRORS)[number];

/**
 * The wait before each retry, by the number of attempts already made: a
 * minute, five, half an hour, two hours, six, twelve, twelve — eight attempts
 * over about a day and a half, then the delivery is 'failed'.
 */
const BACKOFF_SECONDS = [60, 300, 1800, 7200, 21_600, 43_200, 43_200] as const;
export const WEBHOOK_MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;

/** Seconds until the next attempt after `attempts` failed ones, or null: give up. */
export function webhookRetryAfterSeconds(attempts: number): number | null {
  if (!Number.isInteger(attempts) || attempts < 1) return BACKOFF_SECONDS[0];
  return attempts >= WEBHOOK_MAX_ATTEMPTS ? null : (BACKOFF_SECONDS[attempts - 1] ?? null);
}

/** An endpoint failing for this long without one success is disabled ('failing'). */
export const WEBHOOK_DISABLE_AFTER_DAYS = 3;
/** For this long after a rotation, the previous secret signs too. */
export const WEBHOOK_ROTATION_OVERLAP_HOURS = 24;
/** A receiver should refuse a signature older than this. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * The thin body of a delivery: what happened and the ids — never a name, a
 * contact or an amount. The integrator fetches the rest through the API with
 * the scope `CLUB_WEBHOOK_EVENT_SCOPE` names; a deleted record answers 404,
 * which is the point of member.deleted.
 */
export interface ClubWebhookBody {
  id: string;
  /** The order the database saw the events in — one transaction's share a timestamp. */
  seq: number;
  type: ClubWebhookEvent;
  created: string;
  club_id: string;
  data: { object_id: string; member_id: string | null };
}

export function webhookBody(row: {
  id: string;
  seq: number;
  event: ClubWebhookEvent;
  occurredAt: string;
  clubId: string;
  subjectId: string;
  memberId: string | null;
}): ClubWebhookBody {
  return {
    id: row.id,
    seq: row.seq,
    type: row.event,
    created: row.occurredAt,
    club_id: row.clubId,
    data: { object_id: row.subjectId, member_id: row.memberId },
  };
}

/** club_kiosk_devices_rule_for_doors (0057). */
export const DOOR_ACCESS_RULES = ['member', 'covered'] as const;
export type DoorAccessRule = (typeof DOOR_ACCESS_RULES)[number];

export function isDoorAccessRule(value: unknown): value is DoorAccessRule {
  return typeof value === 'string' && (DOOR_ACCESS_RULES as readonly string[]).includes(value);
}

/** Why a door stayed shut — a closed code the controller can show. */
export const DOOR_DENIALS = [
  'unknown_credential',
  'expired_credential',
  'archived',
  'not_covered',
  'club_closed',
] as const;
export type DoorDenial = (typeof DOOR_DENIALS)[number];
