import { getDb, sql } from '@sportkarta/db';
import type { ClubSport, IsoDate } from '@sportkarta/lib/clubs';

import { memberSelfScope } from './scope';

/**
 * The member's side of a club (/klub/<slug>/az and the /klub hub).
 *
 * WHAT A MEMBER SEES is exactly their own record and the records of children
 * whose guardian is their record — memberSelfScope, embedded in every
 * statement. They never see another member: class lists carry counts, not
 * names. A pending link (a claim the desk has not approved) sees nothing of
 * the record yet — only that the claim is waiting.
 */

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

export interface MemberClubLink {
  clubSlug: string;
  clubName: string;
  memberId: string;
  memberName: string;
  status: 'active' | 'pending';
}

/** Every club where this account holds (or claims) a record — the hub. */
export async function memberClubs(userId: string, locale: string): Promise<MemberClubLink[]> {
  const result = await getDb().execute(sql`
    SELECT l.member_id, l.status, m.display_name, c.slug,
           CASE WHEN ${locale} = 'en' THEN coalesce(c.name_en, c.name_bg) ELSE c.name_bg END AS club_name
      FROM club_member_links l
      JOIN club_members m ON m.club_id = l.club_id AND m.id = l.member_id
      JOIN clubs c ON c.id = l.club_id
     WHERE l.user_id = ${userId} AND l.status IN ('active', 'pending') AND c.status <> 'archived'
     ORDER BY c.name_bg
  `);
  return result.rows.map((row) => ({
    clubSlug: String(row.slug),
    clubName: String(row.club_name),
    memberId: String(row.member_id),
    memberName: String(row.display_name),
    status: row.status === 'pending' ? 'pending' : 'active',
  }));
}

export interface PortalMembership {
  id: string;
  planName: string;
  kind: string;
  state: 'active' | 'paused' | 'upcoming' | 'expired' | 'cancelled';
  startsOn: IsoDate;
  effectiveEndsOn: IsoDate;
  visitsRemaining: number | null;
  /** Renewing chain (0045): renews, and the last day after notice, if given. */
  renews: boolean;
  renewalEndsOn: IsoDate | null;
  noticeDays: number;
  selfPauseAllowed: boolean;
  selfCancelAllowed: boolean;
  /** A pause the member set themselves already exists (one per membership). */
  selfPaused: boolean;
  /** A renewal already followed this period (the chain's tail is the successor). */
  hasSuccessor: boolean;
  /** Billed by a card subscription (0046): no self-pause — Stripe keeps billing. */
  online: boolean;
}

export interface PortalBooking {
  bookingId: string;
  occurrenceId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  locationName: string;
  status: 'going' | 'waitlisted';
  position: number;
  /** The instant after which a cancellation is late. */
  freeCancelUntil: string;
  /** The class's rules AS BOOKED (0047): what a late cancellation or a no-show costs. */
  lateCancelFeeCents: number | null;
  noShowFeeCents: number | null;
  countsStrikes: boolean;
  cancelled: boolean;
  /** Checked in for this class — no longer cancellable. */
  attended: boolean;
}

export interface PortalRecord {
  memberId: string;
  displayName: string;
  isMinor: boolean;
  self: boolean;
  memberships: PortalMembership[];
  owedCents: number;
  /** What is owed, charge by charge — each payable online when the club takes cards. */
  openCharges: PortalCharge[];
  bookings: PortalBooking[];
}

export interface PortalCharge {
  chargeId: string;
  label: string;
  dueCents: number;
  dueOn: string;
}

export interface PortalClass {
  occurrenceId: string;
  title: string;
  sport: ClubSport;
  startsAt: string;
  endsAt: string;
  locationName: string;
  instructorName: string | null;
  capacity: number | null;
  going: number;
  waitlisted: number;
  bookingOpensAt: string;
  trialAllowed: boolean;
  /** The class's rules as a booking made now would snapshot them (0047). */
  cancelDeadlineHours: number;
  lateCancelFeeCents: number | null;
  noShowFeeCents: number | null;
  strikeLimit: number | null;
  strikeDays: number | null;
}

export interface PortalView {
  club: {
    id: string;
    slug: string;
    name: string;
    publicEmail: string | null;
    publicPhone: string | null;
    /** The club's own terms of sale, linked before an online payment (0046). */
    termsUrl: string | null;
    /** The club can take bookings and check-ins right now. */
    live: boolean;
  };
  link: {
    memberId: string;
    status: 'active' | 'pending';
    passportConsent: boolean;
    notifyEmail: boolean;
    /** This club's push notifications on the member's devices (0051). */
    notifyPush: boolean;
    erasureRequested: boolean;
  } | null;
  records: PortalRecord[];
  classes: PortalClass[];
}

export async function portalView(
  userId: string,
  slug: string,
  locale: string,
): Promise<PortalView | null> {
  const db = getDb();
  const clubRow = (
    await db.execute(sql`
      SELECT c.id, c.slug, c.public_email, c.public_phone, c.terms_url,
             CASE WHEN ${locale} = 'en' THEN coalesce(c.name_en, c.name_bg) ELSE c.name_bg END AS name,
             (c.status = 'active' AND (c.tier = 'community'
               OR greatest(c.paid_until, c.trial_ends_on) + 14 >= (now() AT TIME ZONE 'Europe/Sofia')::date))
               AS live
        FROM clubs c
       WHERE c.slug = ${slug} AND c.status <> 'archived'
    `)
  ).rows[0];
  if (!clubRow) return null;
  const clubId = String(clubRow.id);
  const club = {
    id: clubId,
    slug: String(clubRow.slug),
    name: String(clubRow.name),
    publicEmail: text(clubRow.public_email),
    publicPhone: text(clubRow.public_phone),
    termsUrl: text(clubRow.terms_url),
    live: clubRow.live === true,
  };

  const linkRow = (
    await db.execute(sql`
      SELECT l.member_id, l.status, (l.passport_consent_at IS NOT NULL) AS consent, l.notify_email,
             l.notify_push,
             (m.erasure_requested_at IS NOT NULL) AS erasure
        FROM club_member_links l
        JOIN club_members m ON m.club_id = l.club_id AND m.id = l.member_id
       WHERE l.club_id = ${clubId}::uuid AND l.user_id = ${userId}
         AND l.status IN ('active', 'pending')
    `)
  ).rows[0];
  const link = linkRow
    ? {
        memberId: String(linkRow.member_id),
        status: linkRow.status === 'pending' ? ('pending' as const) : ('active' as const),
        passportConsent: linkRow.consent === true,
        notifyEmail: linkRow.notify_email === true,
        notifyPush: linkRow.notify_push === true,
        erasureRequested: linkRow.erasure === true,
      }
    : null;

  const classes = await portalClasses(clubId);
  if (!link || link.status !== 'active') return { club, link, records: [], classes };

  const recordRows = (
    await db.execute(sql`
      SELECT m.id, m.display_name, m.is_minor, (m.id = ${link.memberId}::uuid) AS self
        FROM club_members m
       WHERE ${memberSelfScope(userId, clubId, 'm')} AND m.archived_at IS NULL
       ORDER BY (m.id = ${link.memberId}::uuid) DESC, lower(m.display_name)
    `)
  ).rows;
  const ids = recordRows.map((row) => String(row.id));
  if (ids.length === 0) return { club, link, records: [], classes };

  const [memberships, owed, bookings] = await Promise.all([
    db.execute(sql`
      SELECT mb.member_id, mb.membership_id, mb.plan_name, mb.kind, mb.state,
             to_char(mb.starts_on, 'YYYY-MM-DD') AS starts_on,
             to_char(mb.effective_ends_on, 'YYYY-MM-DD') AS ends_on, mb.visits_remaining,
             ms.renews, to_char(ms.renewal_ends_on, 'YYYY-MM-DD') AS renewal_ends_on,
             ms.notice_days, ms.self_pause_allowed, ms.self_cancel_allowed,
             EXISTS (SELECT 1 FROM club_membership_pauses ps
                      WHERE ps.membership_id = ms.id AND ps.by_member) AS self_paused,
             EXISTS (SELECT 1 FROM club_memberships nx WHERE nx.renewal_of = ms.id) AS has_successor,
             (ms.provider_subscription_ref IS NOT NULL) AS online
        FROM club_membership_balances mb
        JOIN club_memberships ms ON ms.id = mb.membership_id
       WHERE mb.club_id = ${clubId}::uuid AND mb.member_id = ANY(${sql.param(ids)}::uuid[])
         AND mb.state <> 'cancelled'
         AND mb.effective_ends_on >= (now() AT TIME ZONE 'Europe/Sofia')::date - 60
       ORDER BY mb.effective_ends_on DESC
    `),
    db.execute(sql`
      SELECT cb.member_id, cb.charge_id, cb.label, cb.due_cents,
             to_char(cb.due_on, 'YYYY-MM-DD') AS due_on
        FROM club_charge_balances cb
       WHERE cb.club_id = ${clubId}::uuid AND cb.member_id = ANY(${sql.param(ids)}::uuid[])
         AND cb.status IN ('open', 'partial', 'overdue') AND cb.due_cents > 0
       ORDER BY cb.due_on, cb.charge_id
    `),
    db.execute(sql`
      SELECT bp.booking_id, bp.member_id, bp.occurrence_id, bp.booking_status, bp.position::int AS position,
             o.starts_at, o.ends_at, o.status, k.title, l.name AS location_name,
             o.starts_at - make_interval(hours => k.cancel_deadline_hours) AS free_cancel_until,
             bk.late_cancel_fee_cents, bk.no_show_fee_cents, bk.counts_strikes,
             EXISTS (SELECT 1 FROM club_checkins ci
                      WHERE ci.club_id = bp.club_id AND ci.occurrence_id = bp.occurrence_id
                        AND ci.member_id = bp.member_id) AS attended
        FROM club_booking_positions bp
        JOIN club_bookings bk ON bk.club_id = bp.club_id AND bk.id = bp.booking_id
        JOIN club_class_occurrences o ON o.club_id = bp.club_id AND o.id = bp.occurrence_id
        JOIN club_classes k ON k.id = o.class_id
        JOIN club_locations l ON l.id = k.location_id
       WHERE bp.club_id = ${clubId}::uuid AND bp.member_id = ANY(${sql.param(ids)}::uuid[])
         AND o.ends_at > now()
       ORDER BY o.starts_at
       LIMIT 60
    `),
  ]);

  const records: PortalRecord[] = recordRows.map((row) => {
    const memberId = String(row.id);
    return {
      memberId,
      displayName: String(row.display_name),
      isMinor: row.is_minor === true,
      self: row.self === true,
      memberships: memberships.rows
        .filter((m) => String(m.member_id) === memberId)
        .map((m) => ({
          id: String(m.membership_id),
          planName: String(m.plan_name),
          kind: String(m.kind),
          state: String(m.state) as PortalMembership['state'],
          startsOn: String(m.starts_on),
          effectiveEndsOn: String(m.ends_on),
          visitsRemaining: m.visits_remaining === null ? null : Number(m.visits_remaining),
          renews: m.renews === true,
          renewalEndsOn: text(m.renewal_ends_on),
          noticeDays: Number(m.notice_days ?? 0),
          selfPauseAllowed: m.self_pause_allowed === true,
          selfCancelAllowed: m.self_cancel_allowed === true,
          selfPaused: m.self_paused === true,
          hasSuccessor: m.has_successor === true,
          online: m.online === true,
        })),
      owedCents: owed.rows
        .filter((o) => String(o.member_id) === memberId)
        .reduce((sum, o) => sum + Number(o.due_cents), 0),
      openCharges: owed.rows
        .filter((o) => String(o.member_id) === memberId)
        .map((o) => ({
          chargeId: String(o.charge_id),
          label: String(o.label),
          dueCents: Number(o.due_cents),
          dueOn: String(o.due_on),
        })),
      bookings: bookings.rows
        .filter((b) => String(b.member_id) === memberId)
        .map((b) => ({
          bookingId: String(b.booking_id),
          occurrenceId: String(b.occurrence_id),
          title: String(b.title),
          startsAt: iso(b.starts_at),
          endsAt: iso(b.ends_at),
          locationName: String(b.location_name),
          status: b.booking_status === 'waitlisted' ? 'waitlisted' : 'going',
          position: Number(b.position),
          freeCancelUntil: iso(b.free_cancel_until),
          lateCancelFeeCents:
            b.late_cancel_fee_cents === null ? null : Number(b.late_cancel_fee_cents),
          noShowFeeCents: b.no_show_fee_cents === null ? null : Number(b.no_show_fee_cents),
          countsStrikes: b.counts_strikes === true,
          cancelled: b.status === 'cancelled',
          attended: b.attended === true,
        })),
    };
  });
  return { club, link, records, classes };
}

/**
 * The club's public classes in the next seven days, with counts only. Shared
 * by the portal and (later) the public club page; it names nobody.
 */
export async function portalClasses(clubId: string, days = 7): Promise<PortalClass[]> {
  const result = await getDb().execute(sql`
    SELECT o.id, k.title, k.sport, o.starts_at, o.ends_at, l.name AS location_name,
           coalesce(nullif(btrim(sto.display_name), ''), nullif(btrim(uo.display_name), ''), nullif(btrim(stk.display_name), ''), nullif(btrim(uk.display_name), '')) AS instructor_name,
           coalesce(o.capacity, k.capacity) AS capacity, k.trial_allowed,
           o.starts_at - make_interval(hours => k.booking_opens_hours) AS opens_at,
           k.cancel_deadline_hours, k.late_cancel_fee_cents, k.no_show_fee_cents,
           k.strike_limit, k.strike_days,
           (SELECT count(*) FILTER (WHERE bp.booking_status = 'going')::int FROM club_booking_positions bp
             WHERE bp.club_id = o.club_id AND bp.occurrence_id = o.id) AS going,
           (SELECT count(*) FILTER (WHERE bp.booking_status = 'waitlisted')::int FROM club_booking_positions bp
             WHERE bp.club_id = o.club_id AND bp.occurrence_id = o.id) AS waitlisted
      FROM club_class_occurrences o
      JOIN club_classes k ON k.id = o.class_id
      JOIN club_locations l ON l.id = k.location_id
      LEFT JOIN club_staff sto ON sto.club_id = o.club_id AND sto.user_id = o.instructor_user_id
      LEFT JOIN users uo ON uo.id = o.instructor_user_id
      LEFT JOIN club_staff stk ON stk.club_id = k.club_id AND stk.user_id = k.instructor_user_id
      LEFT JOIN users uk ON uk.id = k.instructor_user_id
     WHERE o.club_id = ${clubId}::uuid AND o.status = 'scheduled' AND k.public
       AND o.starts_at > now() AND o.starts_at < now() + make_interval(days => ${days}::int)
     ORDER BY o.starts_at
     LIMIT 80
  `);
  return result.rows.map((row) => ({
    occurrenceId: String(row.id),
    title: String(row.title),
    sport: String(row.sport) as ClubSport,
    startsAt: iso(row.starts_at),
    endsAt: iso(row.ends_at),
    locationName: String(row.location_name),
    instructorName: text(row.instructor_name),
    capacity: row.capacity === null ? null : Number(row.capacity),
    going: Number(row.going ?? 0),
    waitlisted: Number(row.waitlisted ?? 0),
    bookingOpensAt: iso(row.opens_at),
    trialAllowed: row.trial_allowed === true,
    cancelDeadlineHours: Number(row.cancel_deadline_hours),
    lateCancelFeeCents:
      row.late_cancel_fee_cents === null ? null : Number(row.late_cancel_fee_cents),
    noShowFeeCents: row.no_show_fee_cents === null ? null : Number(row.no_show_fee_cents),
    strikeLimit: row.strike_limit === null ? null : Number(row.strike_limit),
    strikeDays: row.strike_days === null ? null : Number(row.strike_days),
  }));
}

/** A club's id from its slug, for the member actions (not archived). */
export async function clubIdForSlug(slug: string): Promise<string | null> {
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) return null;
  const result = await getDb().execute(
    sql`SELECT id FROM clubs WHERE slug = ${slug} AND status <> 'archived'`,
  );
  return text(result.rows[0]?.id);
}
