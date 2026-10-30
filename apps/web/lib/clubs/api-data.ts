import 'server-only';

import { getDb, sql } from '@sportkarta/db';

import type { ApiOutcome } from './api';
import { bookAtDesk, cancelBooking } from './bookings';
import { clubCheckIn } from './checkin';
import { parseMember } from './input';
import {
  MEMBER_FILTERS,
  MEMBER_PAGE_SIZE,
  createMember,
  listMembers,
  memberSummary,
  type MemberFilter,
  type MemberListRow,
} from './members';
import { enqueueClubNotify } from './notify';
import { weekOccurrences, type WeekOccurrence } from './schedule';
import { clubScope, type ClubActor } from './scope';

/**
 * What the club API reads and writes (0057), as JSON — and nothing the office
 * does not already do. Every function takes the key's ClubActor (the key's
 * creator, role as of now) and calls the office's own scoped function or
 * embeds the same scope fragment, so the API cannot see or change anything
 * its creator could not in the office today.
 *
 * Shapes: snake_case keys, instants as ISO 8601 UTC, civil Sofia days as
 * `YYYY-MM-DD`, money in euro cents. A client record's contact details are
 * the club's data, served to the club's own key.
 */

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function iso(value: unknown): string | null {
  return value === null || value === undefined ? null : new Date(String(value)).toISOString();
}

// ─── Members ─────────────────────────────────────────────────────────────

export function memberJson(row: MemberListRow): Record<string, unknown> {
  return {
    id: row.id,
    display_name: row.displayName,
    email: row.email,
    phone: row.phone,
    is_minor: row.isMinor,
    status: row.status,
    valid_until: row.validUntil,
    visits_remaining: row.visitsRemaining,
    owed_cents: row.owedCents,
    overdue: row.overdue,
    last_visit: row.lastVisit,
    visits_30_days: row.visits30,
    tags: row.tags,
    segments: row.segments,
    linked: row.linkStatus === 'active',
  };
}

export async function apiListMembers(
  actor: ClubActor,
  params: URLSearchParams,
): Promise<Record<string, unknown>> {
  const page = Math.max(0, Math.min(Number.parseInt(params.get('page') ?? '0', 10) || 0, 1000));
  const rawFilter = params.get('filter') ?? 'all';
  const filter = (MEMBER_FILTERS as readonly string[]).includes(rawFilter)
    ? (rawFilter as MemberFilter)
    : 'all';
  const { rows, total } = await listMembers(actor, {
    q: (params.get('q') ?? '').slice(0, 100),
    filter,
    page,
  });
  return {
    data: rows.map(memberJson),
    page,
    page_size: MEMBER_PAGE_SIZE,
    total,
    has_more: (page + 1) * MEMBER_PAGE_SIZE < total,
  };
}

export async function apiMember(
  actor: ClubActor,
  memberId: string,
): Promise<Record<string, unknown> | null> {
  const row = await memberSummary(actor, memberId);
  if (!row) return null;
  const memberships = await getDb().execute(sql`
    SELECT mb.membership_id, mb.plan_name, mb.kind, mb.audience, mb.price_cents,
           to_char(mb.starts_on, 'YYYY-MM-DD') AS starts_on,
           to_char(mb.effective_ends_on, 'YYYY-MM-DD') AS ends_on,
           mb.visits_total, mb.visits_remaining, mb.state
      FROM club_membership_balances mb
     WHERE ${clubScope(actor, 'members.view', 'mb')} AND mb.member_id = ${memberId}::uuid
     ORDER BY mb.starts_on DESC, mb.membership_id
     LIMIT 50
  `);
  return {
    ...memberJson(row),
    memberships: memberships.rows.map((m) => ({
      id: String(m.membership_id),
      plan_name: String(m.plan_name),
      kind: String(m.kind),
      audience: String(m.audience),
      price_cents: Number(m.price_cents),
      starts_on: String(m.starts_on),
      ends_on: String(m.ends_on),
      visits_total: m.visits_total === null ? null : Number(m.visits_total),
      visits_remaining: m.visits_remaining === null ? null : Number(m.visits_remaining),
      state: String(m.state),
    })),
  };
}

/** The JSON a client record arrives in, through the office's own parser. */
function memberForm(body: Record<string, unknown>): FormData | string {
  const form = new FormData();
  const strings: [string, string][] = [
    ['display_name', 'displayName'],
    ['email', 'email'],
    ['phone', 'phone'],
    ['guardian_member_id', 'guardianMemberId'],
    ['note', 'staffNote'],
  ];
  for (const [json, field] of strings) {
    const value = body[json];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return `${json} must be a string`;
    form.set(field, value);
  }
  if (body.is_minor !== undefined) {
    if (typeof body.is_minor !== 'boolean') return 'is_minor must be a boolean';
    if (body.is_minor) form.set('isMinor', 'on');
  }
  if (body.tags !== undefined) {
    const tags: unknown = body.tags;
    if (!Array.isArray(tags) || !tags.every((tag): tag is string => typeof tag === 'string')) {
      return 'tags must be an array of strings';
    }
    if (tags.some((tag) => tag.includes(','))) return 'a tag may not contain a comma';
    form.set('tags', tags.join(','));
  }
  return form;
}

export async function apiCreateMember(
  actor: ClubActor,
  body: Record<string, unknown>,
): Promise<ApiOutcome> {
  const form = memberForm(body);
  if (typeof form === 'string') return { status: 400, errorCode: 'invalid_field' };
  const parsed = parseMember(form);
  if (!parsed.ok) return { status: 400, errorCode: parsed.errors[0] ?? 'invalid' };
  const created = await createMember(getDb(), actor, parsed.value, 'api');
  if (!created.ok) {
    return { status: created.error === 'guardian_invalid' ? 400 : 403, errorCode: created.error };
  }
  return { status: 201, resultKind: 'member', resultId: created.memberId };
}

// ─── Classes and bookings ────────────────────────────────────────────────

export function classJson(row: WeekOccurrence): Record<string, unknown> {
  return {
    id: row.id,
    class_id: row.classId,
    title: row.title,
    sport: row.sport,
    starts_at: row.startsAt,
    ends_at: row.endsAt,
    local_start: row.localStart,
    location: { id: row.locationId, name: row.locationName },
    instructor_name: row.instructorName,
    capacity: row.capacity,
    going: row.going,
    waitlisted: row.waitlisted,
    checked_in: row.checkedIn,
    status: row.status,
  };
}

export async function apiClasses(
  actor: ClubActor,
  from: string,
  days: number,
  locationId: string | null,
): Promise<Record<string, unknown>[]> {
  return (await weekOccurrences(actor, from, locationId, days)).map(classJson);
}

export async function apiBooking(
  actor: ClubActor,
  bookingId: string,
): Promise<Record<string, unknown> | null> {
  const result = await getDb().execute(sql`
    SELECT b.id, b.occurrence_id, b.member_id, b.state, b.is_trial, b.created_at, b.cancelled_at,
           bp.booking_status
      FROM club_bookings b
      LEFT JOIN club_booking_positions bp ON bp.booking_id = b.id
     WHERE ${clubScope(actor, 'roster.view', 'b')} AND b.id = ${bookingId}::uuid
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    class_occurrence_id: String(row.occurrence_id),
    member_id: String(row.member_id),
    state: String(row.state),
    place: row.state === 'active' ? (text(row.booking_status) ?? 'going') : null,
    is_trial: row.is_trial === true,
    created_at: iso(row.created_at),
    cancelled_at: iso(row.cancelled_at),
  };
}

export async function apiBook(
  actor: ClubActor,
  occurrenceId: string,
  memberId: string,
): Promise<ApiOutcome> {
  const result = await bookAtDesk(getDb(), actor, occurrenceId, memberId);
  if (!result.ok) {
    return { status: result.error === 'not_allowed' ? 403 : 409, errorCode: result.error };
  }
  if (result.status === 'going') {
    await enqueueClubNotify({ kind: 'booking_confirmed', bookingId: result.bookingId });
  }
  return { status: 201, resultKind: 'booking', resultId: result.bookingId };
}

export async function apiCancelBooking(actor: ClubActor, bookingId: string): Promise<ApiOutcome> {
  const result = await cancelBooking(getDb(), { kind: 'staff', actor }, bookingId);
  if (!result.cancelled) return { status: 409, errorCode: 'not_cancellable' };
  if (result.promoted.length > 0) {
    await enqueueClubNotify({ kind: 'booking_promoted', bookingIds: result.promoted });
  }
  return { status: 200, resultKind: 'booking', resultId: bookingId };
}

// ─── Attendance ──────────────────────────────────────────────────────────

/** At most this many check-ins in one answer; a sync job pages by day. */
export const CHECKINS_MAX = 1000;

const CHECKIN_COLUMNS = sql`ci.id, ci.member_id, ci.occurrence_id, ci.location_id, ci.method,
  ci.covered, to_char(ci.sofia_day, 'YYYY-MM-DD') AS day, ci.checked_in_at`;

function checkinJson(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    member_id: String(row.member_id),
    class_occurrence_id: text(row.occurrence_id),
    location_id: String(row.location_id),
    method: String(row.method),
    covered: row.covered === true,
    day: String(row.day),
    checked_in_at: iso(row.checked_in_at),
  };
}

export async function apiCheckins(
  actor: ClubActor,
  from: string,
  to: string,
): Promise<{ data: Record<string, unknown>[]; truncated: boolean }> {
  const result = await getDb().execute(sql`
    SELECT ${CHECKIN_COLUMNS}
      FROM club_checkins ci
     WHERE ${clubScope(actor, 'roster.view', 'ci')}
       AND ci.sofia_day BETWEEN ${from}::date AND ${to}::date
     ORDER BY ci.checked_in_at, ci.id
     LIMIT ${CHECKINS_MAX + 1}
  `);
  return {
    data: result.rows.slice(0, CHECKINS_MAX).map(checkinJson),
    truncated: result.rows.length > CHECKINS_MAX,
  };
}

export async function apiCheckin(
  actor: ClubActor,
  checkinId: string,
): Promise<Record<string, unknown> | null> {
  const result = await getDb().execute(sql`
    SELECT ${CHECKIN_COLUMNS}
      FROM club_checkins ci
     WHERE ${clubScope(actor, 'roster.view', 'ci')} AND ci.id = ${checkinId}::uuid
  `);
  const row = result.rows[0];
  return row ? checkinJson(row) : null;
}

/**
 * Record attendance (method 'api'). Never a refusal for money: an uncovered
 * visit is recorded with covered = false, as at the desk. A second call for
 * the same class or day answers 200 with the visit already recorded.
 */
export async function apiRecordCheckin(
  actor: ClubActor,
  input: { memberId: string; occurrenceId: string | null; locationId: string | null },
): Promise<ApiOutcome> {
  const outcome = await clubCheckIn(getDb(), {
    method: 'api',
    actor,
    memberId: input.memberId,
    occurrenceId: input.occurrenceId,
    locationId: input.locationId,
  });
  switch (outcome.status) {
    case 'recorded':
    case 'already':
      return outcome.checkinId
        ? {
            status: outcome.status === 'recorded' ? 201 : 200,
            resultKind: 'checkin',
            resultId: outcome.checkinId,
          }
        : { status: 409, errorCode: 'already' };
    case 'not_found':
      return { status: 404, errorCode: 'not_found' };
    case 'too_early':
      return { status: 409, errorCode: 'too_early' };
    case 'club_closed':
      return { status: 409, errorCode: 'club_closed' };
    default:
      return { status: 403, errorCode: 'not_allowed' };
  }
}

// ─── Payments ────────────────────────────────────────────────────────────

export const PAYMENTS_MAX = 1000;

const PAYMENT_COLUMNS = sql`pay.id, pay.charge_id, pay.member_id, pay.kind, pay.amount_cents,
  pay.method, pay.provider, to_char(pay.received_on, 'YYYY-MM-DD') AS received_on, pay.recorded_at`;

function paymentJson(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(row.id),
    charge_id: String(row.charge_id),
    member_id: text(row.member_id),
    kind: String(row.kind),
    amount_cents: Number(row.amount_cents),
    method: String(row.method),
    provider: String(row.provider),
    received_on: String(row.received_on),
    recorded_at: iso(row.recorded_at),
  };
}

export async function apiPayments(
  actor: ClubActor,
  from: string,
  to: string,
): Promise<{ data: Record<string, unknown>[]; truncated: boolean }> {
  const result = await getDb().execute(sql`
    SELECT ${PAYMENT_COLUMNS}
      FROM club_payments pay
     WHERE ${clubScope(actor, 'payments.view', 'pay')}
       AND pay.received_on BETWEEN ${from}::date AND ${to}::date
     ORDER BY pay.received_on, pay.id
     LIMIT ${PAYMENTS_MAX + 1}
  `);
  return {
    data: result.rows.slice(0, PAYMENTS_MAX).map(paymentJson),
    truncated: result.rows.length > PAYMENTS_MAX,
  };
}

export async function apiPayment(
  actor: ClubActor,
  paymentId: string,
): Promise<Record<string, unknown> | null> {
  if (!/^[1-9][0-9]{0,18}$/.test(paymentId)) return null;
  const result = await getDb().execute(sql`
    SELECT ${PAYMENT_COLUMNS}
      FROM club_payments pay
     WHERE ${clubScope(actor, 'payments.view', 'pay')} AND pay.id = ${paymentId}::bigint
  `);
  const row = result.rows[0];
  return row ? paymentJson(row) : null;
}
