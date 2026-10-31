import {
  CLUB_AT_RISK_DAYS,
  type Audience,
  type AudienceSegment,
  type ClubMemberFilter,
} from '@sportkarta/lib/clubs';
import { sql, type SQL } from 'drizzle-orm';

/**
 * WHO A GROUP IS — written once. The office's members list
 * (apps/web/lib/clubs/members.ts) filters and segments with these fragments,
 * and the worker resolves a broadcast's audience with the same ones (0051), so
 * "the 14 members at risk" on the screen is exactly who the message reaches.
 *
 * Every fragment reads `m` (club_members) and the derived joins below; every
 * status word comes from the 0041/0043 views, never from a stored flag.
 */

/**
 * The per-member derived columns, as LATERAL joins on `m`. Every lookup leads
 * with club_id so it uses the (club_id, member_id) indexes.
 */
export const MEMBER_DERIVED_JOINS = sql`
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

export const MEMBER_DERIVED_COLUMNS = sql`
  st.status, g.display_name AS guardian_name,
  to_char(v.valid_until, 'YYYY-MM-DD') AS valid_until, v.visits_remaining,
  o.owed_cents, o.overdue, o.partial, lv.last_visit, lv.visits30, ln.status AS link_status`;

/** The members list's filter chips. */
export function memberFilterSql(filter: ClubMemberFilter): SQL {
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

/** The derived segments (the 1club-style tags) — computed, never stored. */
export function memberSegmentSql(segment: AudienceSegment): SQL {
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
        AND (lv.last_visit IS NULL OR lv.last_visit < now() - make_interval(days => ${CLUB_AT_RISK_DAYS}::int))`;
  }
}

/**
 * A broadcast's group as a predicate on `m` (with MEMBER_DERIVED_JOINS in the
 * statement). A plan's group is everyone holding a current or coming period
 * of it; a class's group is everyone booked into one of its coming
 * occurrences or who came to one in the last 60 days.
 */
export function audienceSql(audience: Audience): SQL {
  switch (audience.kind) {
    case 'all':
      return sql`m.archived_at IS NULL`;
    case 'segment':
      return sql`m.archived_at IS NULL AND ${memberSegmentSql(audience.segment)}`;
    case 'filter':
      return sql`m.archived_at IS NULL AND ${memberFilterSql(audience.filter)}`;
    case 'tag':
      return sql`m.archived_at IS NULL AND m.tags @> ARRAY[${audience.tag}]::text[]`;
    case 'plan':
      return sql`m.archived_at IS NULL AND EXISTS (
        SELECT 1 FROM club_membership_balances pb
         WHERE pb.club_id = m.club_id AND pb.member_id = m.id
           AND pb.plan_id = ${audience.planId}::uuid
           AND pb.state IN ('active', 'paused', 'upcoming'))`;
    case 'class':
      return sql`m.archived_at IS NULL AND (
        EXISTS (SELECT 1 FROM club_bookings cbk
                  JOIN club_class_occurrences co ON co.club_id = cbk.club_id AND co.id = cbk.occurrence_id
                 WHERE cbk.club_id = m.club_id AND cbk.member_id = m.id AND cbk.state = 'active'
                   AND co.class_id = ${audience.classId}::uuid AND co.cancelled_at IS NULL
                   AND co.starts_at > now())
        OR EXISTS (SELECT 1 FROM club_checkins cci
                     JOIN club_class_occurrences co ON co.club_id = cci.club_id AND co.id = cci.occurrence_id
                    WHERE cci.club_id = m.club_id AND cci.member_id = m.id
                      AND co.class_id = ${audience.classId}::uuid
                      AND cci.checked_in_at > now() - interval '60 days'))`;
  }
}

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * The RECEIVING records of a group: a minor's message goes to their guardian
 * (0044's rule), and a guardian of two children in the group is one
 * recipient, not three. Archived records and minors without a guardian are
 * nobody's.
 */
export async function broadcastTargets(
  db: SqlRunner,
  clubId: string,
  audience: Audience,
): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT t.id
      FROM club_members m
      ${MEMBER_DERIVED_JOINS}
      JOIN club_members t ON t.club_id = m.club_id
                         AND t.id = CASE WHEN m.is_minor THEN m.guardian_member_id ELSE m.id END
                         AND NOT t.is_minor AND t.archived_at IS NULL
     WHERE m.club_id = ${clubId}::uuid AND ${audienceSql(audience)}
     ORDER BY t.id
  `);
  return result.rows.map((row) => String(row.id));
}
