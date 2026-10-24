import { getDb, sql, type SQL } from '@sportkarta/db';
import type { ClubCheckinMethod, IsoDate } from '@sportkarta/lib/clubs';

import { recordClubAudit } from './audit';
import type { MemberInput } from './input';
import { clubActorMay, clubScope, clubWriteScope, type ClubActor } from './scope';

/**
 * A club's clients (0040). The club is the controller; the office reads and
 * writes these rows through the actor's scope, and EVERY status word on the
 * screen (active, trial, lapsed, owes, overdue, expiring) comes from the
 * views in 0041/0043, never from a stored flag.
 *
 * PROJECTION RULE: contact details (email, phone) and the staff note are
 * selected only for the 'members.view' permission. A trainer never reaches
 * this module — their roster (roster.ts) selects a display name and a minor
 * flag and nothing else (apps/web/tests/club-projections.test.ts).
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export const MEMBER_PAGE_SIZE = 50;

export const MEMBER_STATUSES = ['active', 'trial', 'lapsed', 'lead', 'archived'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** The list's filter chips (GET params, so the screen works without JS). */
export const MEMBER_FILTERS = [
  'all',
  'with_membership',
  'unpaid',
  'overdue',
  'partial',
  'expiring',
  'leads',
  'lapsed',
  'archived',
] as const;
export type MemberFilter = (typeof MEMBER_FILTERS)[number];

/** Derived segments, the 1club-style tags — computed, never stored. */
export const MEMBER_SEGMENTS = ['top', 'regular', 'new', 'trial', 'owes', 'at_risk'] as const;
export type MemberSegment = (typeof MEMBER_SEGMENTS)[number];

/** Days without a visit after which a paying member counts as at risk. */
export const AT_RISK_DAYS = 21;

export interface MemberListRow {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  isMinor: boolean;
  guardianName: string | null;
  status: MemberStatus;
  validUntil: IsoDate | null;
  visitsRemaining: number | null;
  owedCents: number;
  overdue: boolean;
  lastVisit: string | null;
  visits30: number;
  tags: string[];
  segments: MemberSegment[];
  linkStatus: 'active' | 'pending' | null;
  erasureRequested: boolean;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * The per-member derived columns, as LATERAL joins on `m` (club_members).
 * Every lookup leads with club_id so it uses the (club_id, member_id) indexes.
 */
const DERIVED = sql`
  JOIN club_member_status st ON st.member_id = m.id
  LEFT JOIN club_members g ON g.club_id = m.club_id AND g.id = m.guardian_member_id
  LEFT JOIN LATERAL (
    SELECT max(b.effective_ends_on) FILTER (WHERE b.state IN ('active', 'paused', 'upcoming')) AS valid_until,
           sum(b.visits_remaining) FILTER (WHERE b.state IN ('active', 'paused')
                                             AND b.visits_total IS NOT NULL)::int AS visits_remaining
      FROM club_membership_balances b
     WHERE b.club_id = m.club_id AND b.member_id = m.id
  ) v ON true
  LEFT JOIN LATERAL (
    SELECT coalesce(sum(cb.due_cents) FILTER (WHERE cb.status IN ('open', 'overdue', 'partial')), 0)::int AS owed_cents,
           coalesce(bool_or(cb.status = 'overdue'), false) AS overdue,
           coalesce(bool_or(cb.status = 'partial'), false) AS partial
      FROM club_charge_balances cb
     WHERE cb.club_id = m.club_id AND cb.member_id = m.id
  ) o ON true
  LEFT JOIN LATERAL (
    SELECT max(ci.checked_in_at) AS last_visit,
           count(*) FILTER (WHERE ci.sofia_day > (now() AT TIME ZONE 'Europe/Sofia')::date - 30)::int AS visits30
      FROM club_checkins ci
     WHERE ci.club_id = m.club_id AND ci.member_id = m.id
  ) lv ON true
  LEFT JOIN club_member_links ln ON ln.member_id = m.id AND ln.status <> 'declined'`;

const DERIVED_COLUMNS = sql`
  st.status, g.display_name AS guardian_name,
  to_char(v.valid_until, 'YYYY-MM-DD') AS valid_until, v.visits_remaining,
  o.owed_cents, o.overdue, o.partial, lv.last_visit, lv.visits30, ln.status AS link_status`;

function filterSql(filter: MemberFilter): SQL {
  switch (filter) {
    case 'all':
      return sql`m.archived_at IS NULL`;
    case 'with_membership':
      return sql`st.status IN ('active', 'trial')`;
    case 'unpaid':
      return sql`m.archived_at IS NULL AND o.owed_cents > 0`;
    case 'overdue':
      return sql`m.archived_at IS NULL AND o.overdue`;
    case 'partial':
      return sql`m.archived_at IS NULL AND o.partial`;
    case 'expiring':
      return sql`m.archived_at IS NULL
        AND v.valid_until BETWEEN (now() AT TIME ZONE 'Europe/Sofia')::date
                              AND (now() AT TIME ZONE 'Europe/Sofia')::date + 7`;
    case 'leads':
      return sql`st.status = 'lead'`;
    case 'lapsed':
      return sql`st.status = 'lapsed'`;
    case 'archived':
      return sql`st.status = 'archived'`;
  }
}

function segmentSql(segment: MemberSegment): SQL {
  switch (segment) {
    case 'top':
      return sql`lv.visits30 >= 8`;
    case 'regular':
      return sql`lv.visits30 BETWEEN 4 AND 7`;
    case 'new':
      return sql`m.created_at > now() - interval '30 days'`;
    case 'trial':
      return sql`st.status = 'trial'`;
    case 'owes':
      return sql`o.owed_cents > 0`;
    case 'at_risk':
      return sql`st.status = 'active'
        AND (lv.last_visit IS NULL OR lv.last_visit < now() - make_interval(days => ${AT_RISK_DAYS}::int))`;
  }
}

/** Pure: which derived segments a row belongs to (unit-tested with the SQL above). */
export function segmentsFor(row: {
  visits30: number;
  createdDaysAgo: number;
  status: MemberStatus;
  owedCents: number;
  daysSinceVisit: number | null;
}): MemberSegment[] {
  const out: MemberSegment[] = [];
  if (row.visits30 >= 8) out.push('top');
  else if (row.visits30 >= 4) out.push('regular');
  if (row.createdDaysAgo < 30) out.push('new');
  if (row.status === 'trial') out.push('trial');
  if (row.owedCents > 0) out.push('owes');
  if (
    row.status === 'active' &&
    (row.daysSinceVisit === null || row.daysSinceVisit > AT_RISK_DAYS)
  ) {
    out.push('at_risk');
  }
  return out;
}

function toListRow(row: Record<string, unknown>, now: number): MemberListRow {
  const lastVisit = row.last_visit ? new Date(String(row.last_visit)).toISOString() : null;
  const status = String(row.status) as MemberStatus;
  const owedCents = Number(row.owed_cents ?? 0);
  const visits30 = Number(row.visits30 ?? 0);
  const createdDaysAgo = (now - new Date(String(row.created_at)).getTime()) / 86_400_000;
  const daysSinceVisit = lastVisit ? (now - new Date(lastVisit).getTime()) / 86_400_000 : null;
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    email: text(row.email),
    phone: text(row.phone),
    isMinor: row.is_minor === true,
    guardianName: text(row.guardian_name),
    status,
    validUntil: text(row.valid_until),
    visitsRemaining: row.visits_remaining === null ? null : Number(row.visits_remaining),
    owedCents,
    overdue: row.overdue === true,
    lastVisit,
    visits30,
    tags: Array.isArray(row.tags) ? row.tags.map(String) : [],
    segments: segmentsFor({ visits30, createdDaysAgo, status, owedCents, daysSinceVisit }),
    linkStatus:
      row.link_status === 'active' || row.link_status === 'pending' ? row.link_status : null,
    erasureRequested: row.erasure_requested_at !== null && row.erasure_requested_at !== undefined,
  };
}

export interface MemberListQuery {
  q?: string;
  filter?: MemberFilter;
  segment?: MemberSegment | null;
  tag?: string | null;
  page?: number;
}

export async function listMembers(
  actor: ClubActor,
  query: MemberListQuery,
): Promise<{ rows: MemberListRow[]; total: number }> {
  const conditions: SQL[] = [
    clubScope(actor, 'members.view', 'm'),
    filterSql(query.filter ?? 'all'),
  ];
  const q = query.q?.trim() ?? '';
  if (q.length > 0) {
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(
      sql`(m.display_name ILIKE ${pattern} OR m.email ILIKE ${pattern} OR m.phone ILIKE ${pattern})`,
    );
  }
  if (query.segment) conditions.push(segmentSql(query.segment));
  if (query.tag) conditions.push(sql`m.tags @> ARRAY[${query.tag}]::text[]`);
  const page = Math.max(0, Math.min(query.page ?? 0, 1000));
  const where = sql.join(conditions, sql` AND `);
  const result = await getDb().execute(sql`
    SELECT m.id, m.display_name, m.email, m.phone, m.is_minor, m.tags, m.created_at,
           m.erasure_requested_at, ${DERIVED_COLUMNS},
           count(*) OVER ()::int AS total
      FROM club_members m
      ${DERIVED}
     WHERE ${where}
     ORDER BY lower(m.display_name), m.id
     LIMIT ${MEMBER_PAGE_SIZE} OFFSET ${page * MEMBER_PAGE_SIZE}
  `);
  const now = Date.now();
  return {
    rows: result.rows.map((row) => toListRow(row, now)),
    total: Number(result.rows[0]?.total ?? 0),
  };
}

/** Name search for the desk, the sale form and the guardian picker. */
export async function searchMembers(
  actor: ClubActor,
  q: string,
  options: { adultsOnly?: boolean; limit?: number } = {},
): Promise<MemberListRow[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const result = await getDb().execute(sql`
    SELECT m.id, m.display_name, m.email, m.phone, m.is_minor, m.tags, m.created_at,
           m.erasure_requested_at, ${DERIVED_COLUMNS}
      FROM club_members m
      ${DERIVED}
     WHERE ${clubScope(actor, 'members.view', 'm')} AND m.archived_at IS NULL
       AND (m.display_name ILIKE ${pattern} OR m.email ILIKE ${pattern} OR m.phone ILIKE ${pattern})
       ${options.adultsOnly ? sql`AND NOT m.is_minor` : sql``}
     ORDER BY lower(m.display_name)
     LIMIT ${options.limit ?? 20}
  `);
  const now = Date.now();
  return result.rows.map((row) => toListRow(row, now));
}

export interface MemberMembership {
  id: string;
  planName: string;
  kind: string;
  startsOn: IsoDate;
  endsOn: IsoDate;
  effectiveEndsOn: IsoDate;
  visitsTotal: number | null;
  visitsRemaining: number | null;
  state: string;
  priceCents: number;
  pausedToday: boolean;
}

export interface MemberCharge {
  id: string;
  label: string;
  kind: string;
  amountCents: number;
  paidCents: number;
  dueCents: number;
  dueOn: IsoDate;
  status: string;
}

export interface MemberPayment {
  id: number;
  chargeLabel: string;
  amountCents: number;
  method: string;
  kind: string;
  receivedOn: IsoDate;
}

export interface MemberVisit {
  id: string;
  at: string;
  method: ClubCheckinMethod;
  covered: boolean;
  classTitle: string | null;
  location: string;
}

export interface MemberCard extends MemberListRow {
  staffNote: string | null;
  source: string;
  createdAt: string;
  archivedAt: string | null;
  guardianId: string | null;
  children: { id: string; displayName: string }[];
  link: { status: string; method: string; passportConsent: boolean } | null;
  pendingInvite: boolean;
  hasCard: boolean;
  memberships: MemberMembership[];
  charges: MemberCharge[];
  payments: MemberPayment[];
  visits: MemberVisit[];
}

export async function memberCard(actor: ClubActor, memberId: string): Promise<MemberCard | null> {
  const db = getDb();
  const base = await db.execute(sql`
    SELECT m.id, m.display_name, m.email, m.phone, m.is_minor, m.tags, m.created_at,
           m.erasure_requested_at, m.staff_note, m.source, m.archived_at, m.guardian_member_id,
           (m.card_token_hash IS NOT NULL) AS has_card, ${DERIVED_COLUMNS},
           ln.method AS link_method, (ln.passport_consent_at IS NOT NULL) AS consent
      FROM club_members m
      ${DERIVED}
     WHERE ${clubScope(actor, 'members.view', 'm')} AND m.id = ${memberId}::uuid
  `);
  const row = base.rows[0];
  if (!row) return null;
  const clubId = actor.clubId;
  const [children, memberships, charges, payments, visits, invite] = await Promise.all([
    db.execute(sql`
      SELECT id, display_name FROM club_members
       WHERE club_id = ${clubId}::uuid AND guardian_member_id = ${memberId}::uuid
       ORDER BY display_name`),
    db.execute(sql`
      SELECT membership_id, plan_name, kind, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
             to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
             to_char(effective_ends_on, 'YYYY-MM-DD') AS effective_ends_on,
             visits_total, visits_remaining, state, price_cents, paused_today
        FROM club_membership_balances
       WHERE club_id = ${clubId}::uuid AND member_id = ${memberId}::uuid
       ORDER BY starts_on DESC, created_at DESC LIMIT 50`),
    db.execute(sql`
      SELECT charge_id, label, kind, amount_cents, paid_cents, due_cents,
             to_char(due_on, 'YYYY-MM-DD') AS due_on, status
        FROM club_charge_balances
       WHERE club_id = ${clubId}::uuid AND member_id = ${memberId}::uuid
       ORDER BY issued_on DESC, created_at DESC LIMIT 50`),
    db.execute(sql`
      SELECT p.id, ch.label, p.amount_cents, p.method, p.kind,
             to_char(p.received_on, 'YYYY-MM-DD') AS received_on
        FROM club_payments p JOIN club_charges ch ON ch.id = p.charge_id
       WHERE p.club_id = ${clubId}::uuid AND p.member_id = ${memberId}::uuid
       ORDER BY p.received_on DESC, p.id DESC LIMIT 50`),
    db.execute(sql`
      SELECT ci.id, ci.checked_in_at, ci.method, ci.covered, k.title, l.name AS location
        FROM club_checkins ci
        JOIN club_locations l ON l.id = ci.location_id
        LEFT JOIN club_class_occurrences o ON o.id = ci.occurrence_id
        LEFT JOIN club_classes k ON k.id = o.class_id
       WHERE ci.club_id = ${clubId}::uuid AND ci.member_id = ${memberId}::uuid
       ORDER BY ci.checked_in_at DESC LIMIT 30`),
    db.execute(sql`
      SELECT 1 FROM club_member_invites
       WHERE club_id = ${clubId}::uuid AND member_id = ${memberId}::uuid
         AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       LIMIT 1`),
  ]);
  const list = toListRow(row, Date.now());
  return {
    ...list,
    staffNote: text(row.staff_note),
    source: String(row.source),
    createdAt: new Date(String(row.created_at)).toISOString(),
    archivedAt: row.archived_at ? new Date(String(row.archived_at)).toISOString() : null,
    guardianId: text(row.guardian_member_id),
    children: children.rows.map((c) => ({ id: String(c.id), displayName: String(c.display_name) })),
    link: row.link_status
      ? {
          status: String(row.link_status),
          method: String(row.link_method),
          passportConsent: row.consent === true,
        }
      : null,
    pendingInvite: invite.rows.length > 0,
    hasCard: row.has_card === true,
    memberships: memberships.rows.map((m) => ({
      id: String(m.membership_id),
      planName: String(m.plan_name),
      kind: String(m.kind),
      startsOn: String(m.starts_on),
      endsOn: String(m.ends_on),
      effectiveEndsOn: String(m.effective_ends_on),
      visitsTotal: m.visits_total === null ? null : Number(m.visits_total),
      visitsRemaining: m.visits_remaining === null ? null : Number(m.visits_remaining),
      state: String(m.state),
      priceCents: Number(m.price_cents),
      pausedToday: m.paused_today === true,
    })),
    charges: charges.rows.map((c) => ({
      id: String(c.charge_id),
      label: String(c.label),
      kind: String(c.kind),
      amountCents: Number(c.amount_cents),
      paidCents: Number(c.paid_cents),
      dueCents: Number(c.due_cents),
      dueOn: String(c.due_on),
      status: String(c.status),
    })),
    payments: payments.rows.map((p) => ({
      id: Number(p.id),
      chargeLabel: String(p.label),
      amountCents: Number(p.amount_cents),
      method: String(p.method),
      kind: String(p.kind),
      receivedOn: String(p.received_on),
    })),
    visits: visits.rows.map((v) => ({
      id: String(v.id),
      at: new Date(String(v.checked_in_at)).toISOString(),
      method: String(v.method) as ClubCheckinMethod,
      covered: v.covered === true,
      classTitle: text(v.title),
      location: String(v.location),
    })),
  };
}

export type MemberWriteResult =
  { ok: true; memberId: string } | { ok: false; error: 'guardian_invalid' | 'not_allowed' };

/** The guardian must be an adult record of the same club. */
function guardianOk(clubId: string, guardianId: string | null): SQL {
  if (guardianId === null) return sql`TRUE`;
  return sql`EXISTS (SELECT 1 FROM club_members gm
                      WHERE gm.club_id = ${clubId}::uuid AND gm.id = ${guardianId}::uuid
                        AND NOT gm.is_minor AND gm.archived_at IS NULL)`;
}

export async function createMember(
  db: TransactionalDb,
  actor: ClubActor,
  input: MemberInput,
  source: 'staff' | 'import' = 'staff',
): Promise<MemberWriteResult> {
  return db.transaction(async (tx) => {
    const created = await tx.execute(sql`
      INSERT INTO club_members (club_id, display_name, email, phone, is_minor, guardian_member_id,
                                tags, staff_note, source)
      SELECT ${actor.clubId}::uuid, ${input.displayName}, ${input.email}, ${input.phone},
             ${input.isMinor}, ${input.guardianMemberId}::uuid, ${sql.param(input.tags)}::text[],
             ${input.staffNote}, ${source}
       WHERE ${clubActorMay(actor, 'members.manage', { write: true })}
         AND ${guardianOk(actor.clubId, input.guardianMemberId)}
      RETURNING id
    `);
    const memberId = text(created.rows[0]?.id);
    if (!memberId) {
      return {
        ok: false,
        error: input.guardianMemberId ? 'guardian_invalid' : 'not_allowed',
      } as const;
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'member_created',
      subjectMemberId: memberId,
      detail: { source },
    });
    return { ok: true, memberId } as const;
  });
}

export async function updateMember(
  db: TransactionalDb,
  actor: ClubActor,
  memberId: string,
  input: MemberInput,
): Promise<MemberWriteResult> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_members m
         SET display_name = ${input.displayName}, email = ${input.email}, phone = ${input.phone},
             is_minor = ${input.isMinor}, guardian_member_id = ${input.guardianMemberId}::uuid,
             tags = ${sql.param(input.tags)}::text[], staff_note = ${input.staffNote}
       WHERE m.id = ${memberId}::uuid AND ${clubWriteScope(actor, 'members.manage', 'm')}
         AND ${guardianOk(actor.clubId, input.guardianMemberId)}
         AND (${input.guardianMemberId}::uuid IS NULL OR ${input.guardianMemberId}::uuid <> m.id)
      RETURNING m.id
    `);
    if (updated.rows.length === 0) {
      return {
        ok: false,
        error: input.guardianMemberId ? 'guardian_invalid' : 'not_allowed',
      } as const;
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'member_updated',
      subjectMemberId: memberId,
    });
    return { ok: true, memberId } as const;
  });
}

export async function setMemberArchived(
  db: TransactionalDb,
  actor: ClubActor,
  memberId: string,
  archived: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_members m SET archived_at = ${archived ? sql`now()` : sql`NULL`}
       WHERE m.id = ${memberId}::uuid AND (m.archived_at IS NULL) = ${archived}
         AND ${clubWriteScope(actor, 'members.manage', 'm')}
      RETURNING m.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: archived ? 'member_archived' : 'member_restored',
      subjectMemberId: memberId,
    });
    return true;
  });
}

/**
 * The club erasing its client (Art. 17 at the gym): one scoped DELETE that
 * cascades bookings, check-ins, memberships, links and invites, and leaves the
 * books whole with member_id cleared (0040, 0041). The audit row is written
 * first and names the record only by its id, which then resolves to nothing.
 * Owner only ('members.erase'); allowed even when the club is read-only,
 * because an erasure obligation does not lapse with an invoice.
 */
export async function eraseMember(
  db: TransactionalDb,
  actor: ClubActor,
  memberId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const target = await tx.execute(sql`
      SELECT m.id FROM club_members m
       WHERE m.id = ${memberId}::uuid AND ${clubScope(actor, 'members.erase', 'm')}
       FOR UPDATE
    `);
    if (target.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'member_erased',
      subjectMemberId: memberId,
    });
    await tx.execute(sql`
      DELETE FROM club_members m
       WHERE m.id = ${memberId}::uuid AND m.club_id = ${actor.clubId}::uuid
    `);
    return true;
  });
}
