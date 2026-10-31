/**
 * A club's events, camps, workshops and tournaments (wave D1, 0053): the
 * closed lists that are ALSO CHECK constraints (clubs.test.ts holds them
 * equal) and the pure rules around a place. Client-safe.
 *
 * A person registers for a TICKET of a published event. A seat is taken only
 * while the event and the ticket have room — the database counts, under a
 * lock on the event — and a person who finds it full joins the waitlist in
 * arrival order. When a seat frees, the first in line gets it: outright when
 * nothing is owed online, or as an OFFER held for EVENT_OFFER_HOURS while
 * they pay, when the event takes payment online only.
 */

/** club_events_kind_known (0053). */
export const EVENT_KINDS = ['event', 'camp', 'workshop', 'tournament'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** club_events_status_known (0053). */
export const EVENT_STATUSES = ['draft', 'published', 'cancelled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** club_events_payment_known (0053) — the services' vocabulary (0048). */
export const EVENT_PAYMENTS = ['desk', 'online_optional', 'online_required'] as const;
export type EventPayment = (typeof EVENT_PAYMENTS)[number];

/** club_event_registrations_state_known (0053). */
export const REGISTRATION_STATES = [
  'held',
  'confirmed',
  'waitlisted',
  'cancelled',
  'late_cancelled',
  'expired',
] as const;
export type RegistrationState = (typeof REGISTRATION_STATES)[number];

/** The states that hold a seat — what the seat trigger counts. */
export const SEAT_STATES: readonly RegistrationState[] = ['held', 'confirmed'];
/** The states of a place still alive — one per person per event. */
export const LIVE_STATES: readonly RegistrationState[] = ['held', 'confirmed', 'waitlisted'];

export const EVENT_TITLE_MAX = 120;
export const EVENT_DESCRIPTION_MAX = 4000;
/** An event spans at most this many days (club_events_span_sane). */
export const EVENT_SPAN_DAYS_MAX = 60;
/** How far ahead an event may be planned. */
export const EVENT_HORIZON_DAYS = 400;
export const EVENT_CAPACITY_MAX = 10000;
export const EVENT_CANCEL_HOURS_MAX = 720;
export const EVENT_TICKET_NAME_MAX = 80;
export const EVENT_TICKETS_MAX = 12;
export const EVENT_TEAM_NAME_MAX = 60;
/**
 * How long a seat waits for an online payment when a person registers: the
 * court bookings' hold (0048), long enough over the provider's 30-minute
 * session floor.
 */
export const EVENT_HOLD_MINUTES = 35;
/**
 * How long a seat offered from the waitlist waits for its payment. Under the
 * provider's 24-hour session ceiling, so the payment page can die with it.
 */
export const EVENT_OFFER_HOURS = 23;
/**
 * No offer is made with less than this left before the start — a person
 * needs time to see the notice and pay (and the provider's shortest session
 * is 30 minutes) — so the place is given outright and owed at the desk.
 */
export const EVENT_OFFER_MIN_MINUTES = 120;

export interface TicketPrice {
  priceCents: number;
  memberPriceCents: number | null;
}

/** What a place costs: the member price for a client with a live abonnement, else the price. */
export function ticketPrice(ticket: TicketPrice, holdsMembership: boolean): number {
  return holdsMembership && ticket.memberPriceCents !== null
    ? ticket.memberPriceCents
    : ticket.priceCents;
}

export interface RegistrationWindow {
  status: EventStatus;
  startsAt: Date;
  registrationOpensAt: Date | null;
  registrationClosesAt: Date | null;
}

/**
 * Whether a person may register themselves now: published, and inside the
 * window — from its opening (or publication) until it closes (by default,
 * when the event starts). The desk is not bound by the window.
 */
export function registrationOpen(event: RegistrationWindow, now: Date): boolean {
  if (event.status !== 'published') return false;
  if (event.registrationOpensAt && now < event.registrationOpensAt) return false;
  const closes = event.registrationClosesAt ?? event.startsAt;
  return now < closes;
}

/**
 * Whether a member giving up a CONFIRMED place now is late: past the deadline
 * snapshotted when they registered. A late place keeps its charge; an early
 * one is voided or refunded. Never late for the desk or a held place.
 */
export function lateCancellation(startsAt: Date, deadlineHours: number, now: Date): boolean {
  return now.getTime() > startsAt.getTime() - deadlineHours * 3600_000;
}

/** A place's audience check: an adults' ticket for adults, a children's for minors. */
export function audienceFits(audience: 'all' | 'adults' | 'minors', isMinor: boolean): boolean {
  return audience === 'all' || (audience === 'minors') === isMinor;
}
