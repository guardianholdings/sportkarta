import type { ClubChannel, ClubNotificationKind, ClubRole, IsoDate } from '@sportkarta/lib/clubs';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Who a club mail goes to, and what we already told them (0044
 * club_notifications). The worker reads everything here at SEND time — a job
 * carries ids only, never an address, because a job row outlives the person
 * it names.
 *
 * THE RECIPIENT RULES (docs/ROADMAP.md Stage 9, plan §5.6):
 *   - a LINKED member is mailed at their POPS address, unless they switched
 *     club mail off on their link (`notify_email`);
 *   - an UNLINKED record is mailed only when the club told us to
 *     (`clubs.mail_unlinked_members`), only if it has an address, and never
 *     after a one-click opt-out — and that mail carries the opt-out link;
 *   - a MINOR is never addressed: the mail goes to the guardian's record by
 *     the same two rules, or to nobody;
 *   - a club that is not `active` sends no member mail at all.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

const CLUB_NAME = sql`CASE WHEN c.locale = 'en' THEN coalesce(c.name_en, c.name_bg) ELSE c.name_bg END`;
const LOCAL_START = sql`to_char(o.starts_at_local, 'YYYY-MM-DD"T"HH24:MI:SS')`;

export interface ClubMailClub {
  clubId: string;
  clubSlug: string;
  clubName: string;
  locale: 'bg' | 'en';
  status: string;
  /** The club's own public address, for Reply-To. */
  replyTo: string | null;
}

export async function clubForMail(db: SqlRunner, clubId: string): Promise<ClubMailClub | null> {
  const result = await db.execute(sql`
    SELECT c.id, c.slug, c.locale, c.status, c.public_email, ${CLUB_NAME} AS club_name
      FROM clubs c WHERE c.id = ${clubId}::uuid
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    clubId: String(row.id),
    clubSlug: String(row.slug),
    clubName: String(row.club_name),
    locale: row.locale === 'en' ? 'en' : 'bg',
    status: String(row.status),
    replyTo: text(row.public_email),
  };
}

export interface ClubMemberRecipient extends ClubMailClub {
  /** The record the mail is ABOUT (perhaps a child). */
  memberId: string;
  aboutName: string;
  /** The record that RECEIVES it (the guardian for a minor). */
  targetMemberId: string;
  recipientName: string;
  email: string;
  linked: boolean;
  /** Unlinked recipients only: the one-click opt-out token. */
  unsubscribeToken: string | null;
}

/** Resolve who, if anyone, is mailed about one club record. */
export async function memberRecipient(
  db: SqlRunner,
  clubId: string,
  memberId: string,
): Promise<ClubMemberRecipient | null> {
  const result = await db.execute(sql`
    SELECT m.id AS member_id, m.display_name AS about_name,
           t.id AS target_id, t.display_name AS target_name, t.email AS target_email,
           (t.email_opt_out_at IS NOT NULL) AS opted_out, t.unsubscribe_token,
           c.id AS club_id, c.slug, c.locale, c.status, c.public_email, c.mail_unlinked_members,
           ${CLUB_NAME} AS club_name,
           l.user_id, l.notify_email, u.email AS user_email, u.display_name AS user_name
      FROM club_members m
      JOIN clubs c ON c.id = m.club_id AND c.status = 'active'
      JOIN club_members t ON t.club_id = m.club_id
                         AND t.id = CASE WHEN m.is_minor THEN m.guardian_member_id ELSE m.id END
                         AND NOT t.is_minor AND t.archived_at IS NULL
      LEFT JOIN club_member_links l ON l.club_id = t.club_id AND l.member_id = t.id
                                   AND l.status = 'active'
      LEFT JOIN users u ON u.id = l.user_id
     WHERE m.club_id = ${clubId}::uuid AND m.id = ${memberId}::uuid
  `);
  const row = result.rows[0];
  if (!row) return null;
  const club: ClubMailClub = {
    clubId: String(row.club_id),
    clubSlug: String(row.slug),
    clubName: String(row.club_name),
    locale: row.locale === 'en' ? 'en' : 'bg',
    status: String(row.status),
    replyTo: text(row.public_email),
  };
  const base = {
    ...club,
    memberId: String(row.member_id),
    aboutName: String(row.about_name),
    targetMemberId: String(row.target_id),
  };
  if (row.user_id) {
    const email = text(row.user_email);
    if (row.notify_email !== true || !email) return null;
    return {
      ...base,
      recipientName: text(row.user_name) || String(row.target_name),
      email,
      linked: true,
      unsubscribeToken: null,
    };
  }
  const email = text(row.target_email);
  if (row.mail_unlinked_members !== true || row.opted_out === true || !email) return null;
  return {
    ...base,
    recipientName: String(row.target_name),
    email,
    linked: false,
    unsubscribeToken: text(row.unsubscribe_token),
  };
}

export interface StaffRecipient {
  userId: string;
  email: string;
  name: string;
}

/** Staff of a club holding one of `roles`, with a verified address. */
export async function staffRecipients(
  db: SqlRunner,
  clubId: string,
  roles: readonly ClubRole[],
): Promise<StaffRecipient[]> {
  const result = await db.execute(sql`
    SELECT s.user_id, u.email, coalesce(s.display_name, u.display_name, '') AS name
      FROM club_staff s JOIN users u ON u.id = s.user_id
     WHERE s.club_id = ${clubId}::uuid AND s.role = ANY(${sql.param([...roles])}::text[])
       AND u.email_verified
     ORDER BY s.user_id
  `);
  return result.rows.map((row) => ({
    userId: String(row.user_id),
    email: String(row.email),
    name: String(row.name),
  }));
}

/** The NGO's operators (users.role = admin): new applications reach them. */
export async function operatorRecipients(db: SqlRunner): Promise<StaffRecipient[]> {
  const result = await db.execute(sql`
    SELECT u.id, u.email, coalesce(u.display_name, '') AS name FROM users u
     WHERE u.role = 'admin' AND u.email_verified ORDER BY u.id
  `);
  return result.rows.map((row) => ({
    userId: String(row.id),
    email: String(row.email),
    name: String(row.name),
  }));
}

/**
 * Claim a ledger row; true when THIS run may send. Run it in the same
 * transaction as the send, before it: a failed send rolls the claim back.
 *
 * One row per channel (0051): the same key may be claimed once by e-mail,
 * once by SMS and once by push. An SMS claim carries its parts, and the
 * club_notifications_sms_cap trigger refuses it (23514) when the club's
 * monthly allowance would be exceeded — `isSmsCapRefusal` tells the caller.
 */
export async function claimClubNotification(
  db: SqlRunner,
  input: {
    clubId: string;
    memberId?: string | null;
    userId?: string | null;
    kind: ClubNotificationKind;
    key: string;
    channel?: ClubChannel;
    smsParts?: number;
  },
): Promise<boolean> {
  const channel = input.channel ?? 'email';
  const result = await db.execute(sql`
    INSERT INTO club_notifications (club_id, member_id, user_id, kind, dedupe_key, channel, sms_parts)
    VALUES (${input.clubId}::uuid, ${input.memberId ?? null}::uuid, ${input.userId ?? null},
            ${input.kind}, ${input.key}, ${channel},
            ${channel === 'sms' ? (input.smsParts ?? 1) : null}::smallint)
    ON CONFLICT (club_id, channel, dedupe_key) DO NOTHING
    RETURNING id
  `);
  return result.rows.length > 0;
}

/** The SMS allowance refused a claim (club_notifications_sms_cap). */
export function isSmsCapRefusal(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const fields = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (fields.code === '23514' && fields.constraint === 'club_notifications_sms_cap') return true;
    current = fields.cause;
  }
  return false;
}

// ─── Invitations ────────────────────────────────────────────────────────────

export interface InviteForMail {
  inviteId: string;
  clubId: string;
  email: string;
  createdBy: string | null;
  /** Staff invites: the role offered. Member invites: the record's name. */
  role: ClubRole | null;
  memberId: string | null;
  memberName: string | null;
}

/**
 * A still-usable invitation, locked for this transaction so two runs cannot
 * mint two tokens for it at once.
 */
export async function inviteForMail(
  db: SqlRunner,
  table: 'club_staff_invites' | 'club_member_invites',
  inviteId: string,
): Promise<InviteForMail | null> {
  const staff = table === 'club_staff_invites';
  const result = await db.execute(sql`
    SELECT i.id, i.club_id, i.email, i.created_by,
           ${staff ? sql`i.role` : sql`NULL::text`} AS role,
           ${staff ? sql`NULL::uuid` : sql`i.member_id`} AS member_id,
           ${staff ? sql`NULL::text` : sql`(SELECT m.display_name FROM club_members m WHERE m.club_id = i.club_id AND m.id = i.member_id)`} AS member_name
      FROM ${sql.raw(staff ? 'club_staff_invites' : 'club_member_invites')} i
      JOIN clubs c ON c.id = i.club_id AND c.status IN ('pending', 'active')
     WHERE i.id = ${inviteId}::uuid
       AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
     FOR UPDATE OF i
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    inviteId: String(row.id),
    clubId: String(row.club_id),
    email: String(row.email),
    createdBy: text(row.created_by),
    role: row.role === null ? null : (String(row.role) as ClubRole),
    memberId: text(row.member_id),
    memberName: text(row.member_name),
  };
}

/** Store the digest of the token about to be mailed (the token never is). */
export async function setInviteTokenHash(
  db: SqlRunner,
  table: 'club_staff_invites' | 'club_member_invites',
  inviteId: string,
  tokenHash: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE ${sql.raw(table === 'club_staff_invites' ? 'club_staff_invites' : 'club_member_invites')}
       SET token_hash = ${tokenHash}
     WHERE id = ${inviteId}::uuid
  `);
}

// ─── Bookings ───────────────────────────────────────────────────────────────

export interface ClubBookingMail {
  bookingId: string;
  clubId: string;
  memberId: string;
  occurrenceId: string;
  seq: number;
  /** going / waitlisted while active; null once the booking is not active. */
  status: 'going' | 'waitlisted' | null;
  occurrenceCancelled: boolean;
  title: string;
  startsAtLocal: string;
  locationName: string;
}

const BOOKING_SELECT = sql`
  SELECT b.id, b.club_id, b.member_id, b.occurrence_id, b.seq, b.state, bp.booking_status,
         o.status AS occurrence_status, ${LOCAL_START} AS starts_local, k.title, l.name AS location_name
    FROM club_bookings b
    JOIN club_class_occurrences o ON o.club_id = b.club_id AND o.id = b.occurrence_id
    JOIN club_classes k ON k.id = o.class_id
    JOIN club_locations l ON l.id = k.location_id
    LEFT JOIN club_booking_positions bp ON bp.club_id = b.club_id
                                       AND bp.occurrence_id = b.occurrence_id
                                       AND bp.booking_id = b.id`;

function toBooking(row: Record<string, unknown>): ClubBookingMail {
  return {
    bookingId: String(row.id),
    clubId: String(row.club_id),
    memberId: String(row.member_id),
    occurrenceId: String(row.occurrence_id),
    seq: Number(row.seq),
    status:
      row.state !== 'active'
        ? null
        : row.booking_status === 'waitlisted'
          ? 'waitlisted'
          : row.booking_status === 'going'
            ? 'going'
            : null,
    occurrenceCancelled: row.occurrence_status === 'cancelled',
    title: String(row.title),
    startsAtLocal: String(row.starts_local),
    locationName: String(row.location_name),
  };
}

export async function bookingsForMail(
  db: SqlRunner,
  bookingIds: string[],
): Promise<ClubBookingMail[]> {
  if (bookingIds.length === 0) return [];
  const result = await db.execute(sql`
    ${BOOKING_SELECT}
     WHERE b.id = ANY(${sql.param(bookingIds)}::uuid[])
     ORDER BY o.starts_at
  `);
  return result.rows.map(toBooking);
}

/** Everyone booked on occurrences that are now cancelled and still ahead. */
export async function cancelledOccurrenceBookings(
  db: SqlRunner,
  occurrenceIds: string[],
): Promise<ClubBookingMail[]> {
  if (occurrenceIds.length === 0) return [];
  const result = await db.execute(sql`
    ${BOOKING_SELECT}
     WHERE b.occurrence_id = ANY(${sql.param(occurrenceIds)}::uuid[])
       AND b.state = 'active' AND o.status = 'cancelled'
       AND o.starts_at > now() - interval '1 hour'
     ORDER BY o.starts_at
  `);
  return result.rows.map(toBooking);
}

/**
 * Bookings due a 24-hour reminder and not yet told: going, the class starts
 * within a day, and the booking was made well before (a booking made two
 * hours ahead has just had its confirmation; a reminder would be noise).
 */
export async function dueClubReminders(db: SqlRunner, limit = 500): Promise<ClubBookingMail[]> {
  const result = await db.execute(sql`
    ${BOOKING_SELECT}
      JOIN clubs c ON c.id = b.club_id AND c.status = 'active'
     WHERE b.state = 'active' AND bp.booking_status = 'going' AND o.status = 'scheduled'
       AND o.starts_at > now() AND o.starts_at <= now() + interval '24 hours'
       AND b.created_at < o.starts_at - interval '12 hours'
       AND NOT EXISTS (SELECT 1 FROM club_notifications n
                        WHERE n.club_id = b.club_id
                          AND n.dedupe_key = 'reminder_24h:' || b.occurrence_id::text || ':' || b.member_id::text)
     ORDER BY o.starts_at
     LIMIT ${limit}
  `);
  return result.rows.map(toBooking);
}

// ─── Memberships ────────────────────────────────────────────────────────────

export interface ExpiryCandidate {
  clubId: string;
  memberId: string;
  membershipId: string;
  planName: string;
  endsOn: IsoDate;
}

/**
 * Abonnements ending within a week (`expiring`) or that ended in the last
 * three days (`expired`, the catch-up window for a worker that was down) —
 * unless the member already holds a later one, and unless already told.
 */
export async function expiryCandidates(
  db: SqlRunner,
  kind: 'membership_expiring' | 'membership_expired',
  today: IsoDate,
): Promise<ExpiryCandidate[]> {
  const window =
    kind === 'membership_expiring'
      ? sql`mb.state = 'active' AND mb.effective_ends_on BETWEEN ${today}::date AND ${today}::date + 7`
      : sql`mb.state = 'expired' AND mb.effective_ends_on BETWEEN ${today}::date - 3 AND ${today}::date - 1`;
  const result = await db.execute(sql`
    SELECT mb.club_id, mb.member_id, mb.membership_id, mb.plan_name,
           to_char(mb.effective_ends_on, 'YYYY-MM-DD') AS ends_on
      FROM club_membership_balances mb
      JOIN clubs c ON c.id = mb.club_id AND c.status = 'active'
     WHERE ${window}
       AND NOT EXISTS (SELECT 1 FROM club_memberships nx
                        WHERE nx.club_id = mb.club_id AND nx.member_id = mb.member_id
                          AND nx.id <> mb.membership_id AND nx.cancelled_at IS NULL
                          AND nx.starts_on > mb.starts_on)
       AND NOT EXISTS (SELECT 1 FROM club_notifications n
                        WHERE n.club_id = mb.club_id
                          AND n.dedupe_key = ${kind} || ':' || mb.membership_id::text)
     ORDER BY mb.club_id, mb.effective_ends_on
     LIMIT 1000
  `);
  return result.rows.map((row) => ({
    clubId: String(row.club_id),
    memberId: String(row.member_id),
    membershipId: String(row.membership_id),
    planName: String(row.plan_name),
    endsOn: String(row.ends_on),
  }));
}

// ─── Digests (staff) ────────────────────────────────────────────────────────

export interface TrainerClass {
  userId: string;
  email: string;
  name: string;
  clubId: string;
  time: string;
  title: string;
  going: number;
  capacity: number | null;
}

/** Every class a trainer teaches on a Sofia day, with counts — never names. */
export async function trainerClassesOn(db: SqlRunner, day: IsoDate): Promise<TrainerClass[]> {
  const result = await db.execute(sql`
    SELECT s.user_id, u.email, coalesce(s.display_name, u.display_name, '') AS name, o.club_id,
           to_char(o.starts_at_local, 'HH24:MI') AS time, k.title, coalesce(o.capacity, k.capacity) AS capacity,
           (SELECT count(*) FILTER (WHERE bp.booking_status = 'going')::int FROM club_booking_positions bp
             WHERE bp.club_id = o.club_id AND bp.occurrence_id = o.id) AS going
      FROM club_class_occurrences o
      JOIN club_classes k ON k.id = o.class_id
      JOIN clubs c ON c.id = o.club_id AND c.status = 'active'
      JOIN club_staff s ON s.club_id = o.club_id
                       AND s.user_id = coalesce(o.instructor_user_id, k.instructor_user_id)
      JOIN users u ON u.id = s.user_id AND u.email_verified
     WHERE o.status = 'scheduled' AND o.starts_at_local::date = ${day}::date
     ORDER BY s.user_id, o.club_id, o.starts_at
  `);
  return result.rows.map((row) => ({
    userId: String(row.user_id),
    email: String(row.email),
    name: String(row.name),
    clubId: String(row.club_id),
    time: String(row.time),
    title: String(row.title),
    going: Number(row.going ?? 0),
    capacity: row.capacity === null ? null : Number(row.capacity),
  }));
}

export interface ClubWeekFigures {
  clubId: string;
  checkins: number;
  newMembers: number;
  bookings: number;
  revenueCents: number;
  expiringNextWeek: number;
  overdueCharges: number;
  pendingClaims: number;
  erasureRequests: number;
}

/** The owner's Monday numbers for the civil week [monday, monday + 7). */
export async function clubWeekFigures(db: SqlRunner, monday: IsoDate): Promise<ClubWeekFigures[]> {
  const result = await db.execute(sql`
    SELECT c.id,
      (SELECT count(*)::int FROM club_checkins ci WHERE ci.club_id = c.id
          AND ci.sofia_day >= ${monday}::date AND ci.sofia_day < ${monday}::date + 7) AS checkins,
      (SELECT count(*)::int FROM club_members m WHERE m.club_id = c.id
          AND (m.created_at AT TIME ZONE 'Europe/Sofia')::date >= ${monday}::date
          AND (m.created_at AT TIME ZONE 'Europe/Sofia')::date < ${monday}::date + 7) AS new_members,
      (SELECT count(*)::int FROM club_bookings b WHERE b.club_id = c.id
          AND (b.created_at AT TIME ZONE 'Europe/Sofia')::date >= ${monday}::date
          AND (b.created_at AT TIME ZONE 'Europe/Sofia')::date < ${monday}::date + 7) AS bookings,
      (SELECT coalesce(sum(p.amount_cents), 0)::bigint FROM club_payments p WHERE p.club_id = c.id
          AND p.method <> 'wallet'
          AND p.received_on >= ${monday}::date AND p.received_on < ${monday}::date + 7) AS revenue,
      (SELECT count(*)::int FROM club_membership_balances mb WHERE mb.club_id = c.id
          AND mb.state = 'active'
          AND mb.effective_ends_on BETWEEN ${monday}::date + 7 AND ${monday}::date + 14) AS expiring,
      (SELECT count(*)::int FROM club_charge_balances cb WHERE cb.club_id = c.id
          AND cb.status = 'overdue') AS overdue,
      (SELECT count(*)::int FROM club_member_links l WHERE l.club_id = c.id
          AND l.status = 'pending') AS claims,
      (SELECT count(*)::int FROM club_members m WHERE m.club_id = c.id
          AND m.erasure_requested_at IS NOT NULL) AS erasures
      FROM clubs c
     WHERE c.status = 'active'
     ORDER BY c.id
  `);
  return result.rows.map((row) => ({
    clubId: String(row.id),
    checkins: Number(row.checkins ?? 0),
    newMembers: Number(row.new_members ?? 0),
    bookings: Number(row.bookings ?? 0),
    revenueCents: Number(row.revenue ?? 0),
    expiringNextWeek: Number(row.expiring ?? 0),
    overdueCharges: Number(row.overdue ?? 0),
    pendingClaims: Number(row.claims ?? 0),
    erasureRequests: Number(row.erasures ?? 0),
  }));
}

export interface ClubMonthFigures {
  clubId: string;
  /** Held a valid abonnement on any day of the month (this, previous). */
  members: [number, number];
  revenueCents: [number, number];
  checkins: [number, number];
  newMembers: number;
  /** Valid in the previous month, not in this one. */
  churned: number;
  /** Today: a live abonnement and no visit for 21 days. */
  atRisk: number;
  /** The best-filled class of the month (≥ 2 occurrences), if any. */
  topClass: { title: string; fill: number } | null;
}

/**
 * The owner's monthly business-health figures for [month, month + 1 month) —
 * the club.health mail (0045), the deterministic answer to an "AI report":
 * every number is one SQL definition, the same ones the reports page prints.
 */
export async function clubMonthFigures(db: SqlRunner, month: IsoDate): Promise<ClubMonthFigures[]> {
  const result = await db.execute(sql`
    WITH span AS (
      SELECT ${month}::date AS first, (${month}::date + interval '1 month')::date AS next,
             (${month}::date - interval '1 month')::date AS prev
    )
    SELECT c.id,
      (SELECT count(DISTINCT mb.member_id)::int FROM club_membership_balances mb
        WHERE mb.club_id = c.id AND mb.cancelled_at IS NULL
          AND mb.starts_on < span.next AND mb.effective_ends_on >= span.first) AS members_now,
      (SELECT count(DISTINCT mb.member_id)::int FROM club_membership_balances mb
        WHERE mb.club_id = c.id AND mb.cancelled_at IS NULL
          AND mb.starts_on < span.first AND mb.effective_ends_on >= span.prev) AS members_then,
      (SELECT coalesce(sum(p.amount_cents), 0)::bigint FROM club_payments p
        WHERE p.club_id = c.id AND p.method <> 'wallet'
          AND p.received_on >= span.first AND p.received_on < span.next) AS rev_now,
      (SELECT coalesce(sum(p.amount_cents), 0)::bigint FROM club_payments p
        WHERE p.club_id = c.id AND p.method <> 'wallet'
          AND p.received_on >= span.prev AND p.received_on < span.first) AS rev_then,
      (SELECT count(*)::int FROM club_checkins ci
        WHERE ci.club_id = c.id AND ci.sofia_day >= span.first AND ci.sofia_day < span.next) AS ci_now,
      (SELECT count(*)::int FROM club_checkins ci
        WHERE ci.club_id = c.id AND ci.sofia_day >= span.prev AND ci.sofia_day < span.first) AS ci_then,
      (SELECT count(*)::int FROM club_members m
        WHERE m.club_id = c.id AND (m.created_at AT TIME ZONE 'Europe/Sofia')::date >= span.first
          AND (m.created_at AT TIME ZONE 'Europe/Sofia')::date < span.next) AS new_members,
      (SELECT count(*)::int FROM (
         SELECT mb.member_id FROM club_membership_balances mb
          WHERE mb.club_id = c.id AND mb.cancelled_at IS NULL
            AND mb.starts_on < span.first AND mb.effective_ends_on >= span.prev
         EXCEPT
         SELECT mb.member_id FROM club_membership_balances mb
          WHERE mb.club_id = c.id AND mb.cancelled_at IS NULL
            AND mb.starts_on < span.next AND mb.effective_ends_on >= span.first) gone) AS churned,
      -- Distinct MEMBERS: a member holding two live abonnements is one person
      -- at risk, not two.
      (SELECT count(DISTINCT mb.member_id)::int FROM club_membership_balances mb
        WHERE mb.club_id = c.id AND mb.state = 'active'
          AND mb.starts_on <= (now() AT TIME ZONE 'Europe/Sofia')::date - 21
          AND NOT EXISTS (SELECT 1 FROM club_checkins ci
                           WHERE ci.club_id = mb.club_id AND ci.member_id = mb.member_id
                             AND ci.sofia_day > (now() AT TIME ZONE 'Europe/Sofia')::date - 21))
        AS at_risk,
      (SELECT k.title || '|' || (sum(g.going)::float / nullif(sum(g.capacity), 0))::text
         FROM (SELECT o.class_id, coalesce(o.capacity, kk.capacity) AS capacity,
                      (SELECT count(*) FILTER (WHERE bp.booking_status = 'going')
                         FROM club_booking_positions bp WHERE bp.occurrence_id = o.id) AS going
                 FROM club_class_occurrences o JOIN club_classes kk ON kk.id = o.class_id
                WHERE o.club_id = c.id AND o.status = 'scheduled'
                  AND (o.starts_at AT TIME ZONE 'Europe/Sofia')::date >= span.first
                  AND (o.starts_at AT TIME ZONE 'Europe/Sofia')::date < span.next) g
         JOIN club_classes k ON k.id = g.class_id
        GROUP BY k.id, k.title
       HAVING count(*) >= 2 AND bool_and(g.capacity IS NOT NULL) AND sum(g.capacity) > 0
        ORDER BY sum(g.going)::float / sum(g.capacity) DESC
        LIMIT 1) AS top_class
      FROM clubs c, span
     WHERE c.status = 'active'
     ORDER BY c.id
  `);
  return result.rows.map((row) => {
    const top = row.top_class === null ? null : String(row.top_class);
    const cut = top === null ? -1 : top.lastIndexOf('|');
    return {
      clubId: String(row.id),
      members: [Number(row.members_now ?? 0), Number(row.members_then ?? 0)],
      revenueCents: [Number(row.rev_now ?? 0), Number(row.rev_then ?? 0)],
      checkins: [Number(row.ci_now ?? 0), Number(row.ci_then ?? 0)],
      newMembers: Number(row.new_members ?? 0),
      churned: Number(row.churned ?? 0),
      atRisk: Number(row.at_risk ?? 0),
      topClass:
        top === null || cut < 0
          ? null
          : { title: top.slice(0, cut), fill: Number(top.slice(cut + 1)) },
    };
  });
}

// ─── Monthly activity (the invoicing basis) ─────────────────────────────────

/**
 * Freeze one closed calendar month for every club that is not archived
 * (club_monthly_activity, append-only). "Active member" = held a membership
 * valid on any day of the month OR checked in at least three times in it —
 * the definition the paid tiers are invoiced on. ON CONFLICT DO NOTHING: a
 * month is computed once, and a re-run changes nothing.
 */
export async function recordClubMonthlyActivity(
  db: SqlRunner,
  monthStart: IsoDate,
): Promise<number> {
  const result = await db.execute(sql`
    WITH bounds AS (
      SELECT ${monthStart}::date AS first, (${monthStart}::date + interval '1 month')::date AS next
    ),
    held AS (
      SELECT mb.club_id, mb.member_id FROM club_membership_balances mb, bounds
       WHERE mb.cancelled_at IS NULL AND mb.starts_on < bounds.next
         AND mb.effective_ends_on >= bounds.first
       GROUP BY mb.club_id, mb.member_id
    ),
    visited AS (
      SELECT ci.club_id, ci.member_id FROM club_checkins ci, bounds
       WHERE ci.sofia_day >= bounds.first AND ci.sofia_day < bounds.next
       GROUP BY ci.club_id, ci.member_id HAVING count(*) >= 3
    )
    INSERT INTO club_monthly_activity (club_id, month, members_with_membership, members_with_visits,
                                       members_active, checkins, bookings, revenue_cents, sms_parts)
    SELECT c.id, bounds.first,
      (SELECT count(*)::int FROM held h WHERE h.club_id = c.id),
      (SELECT count(*)::int FROM visited v WHERE v.club_id = c.id),
      (SELECT count(*)::int FROM (SELECT member_id FROM held WHERE club_id = c.id
                                  UNION SELECT member_id FROM visited WHERE club_id = c.id) a),
      (SELECT count(*)::int FROM club_checkins ci WHERE ci.club_id = c.id
          AND ci.sofia_day >= bounds.first AND ci.sofia_day < bounds.next),
      (SELECT count(*)::int FROM club_bookings b WHERE b.club_id = c.id
          AND (b.created_at AT TIME ZONE 'Europe/Sofia')::date >= bounds.first
          AND (b.created_at AT TIME ZONE 'Europe/Sofia')::date < bounds.next),
      (SELECT coalesce(sum(p.amount_cents), 0)::bigint FROM club_payments p WHERE p.club_id = c.id
          AND p.method <> 'wallet'
          AND p.received_on >= bounds.first AND p.received_on < bounds.next),
      -- The SMS parts sent in the month (0051), what the operator re-invoices:
      -- the counter, which erasing a client does not lower.
      (SELECT coalesce(sum(u.parts), 0)::int FROM club_sms_usage u
        WHERE u.club_id = c.id AND u.month = bounds.first)
      FROM clubs c, bounds
     WHERE c.status <> 'archived' AND c.applied_at < bounds.next
    ON CONFLICT (club_id, month) DO NOTHING
    RETURNING id
  `);
  return result.rows.length;
}

/** The club a record belongs to and its name — for staff mail about a member. */
export async function memberForStaffMail(
  db: SqlRunner,
  memberId: string,
): Promise<{ clubId: string; memberName: string } | null> {
  const result = await db.execute(sql`
    SELECT m.club_id, m.display_name FROM club_members m
      JOIN clubs c ON c.id = m.club_id AND c.status = 'active'
     WHERE m.id = ${memberId}::uuid
  `);
  const row = result.rows[0];
  return row ? { clubId: String(row.club_id), memberName: String(row.display_name) } : null;
}
