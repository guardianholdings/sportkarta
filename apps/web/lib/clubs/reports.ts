import { getDb, sql } from '@sportkarta/db';

import { clubScope, type ClubActor } from './scope';

/**
 * The club's four reports (Отчети) — deterministic SQL, no model, no
 * sub-processor (plan §2.4 "honest analytics"). Each figure's definition is
 * written here once and shown in the page's caption, so the number and its
 * meaning cannot drift apart.
 *
 *   activeByMonth  ACTIVE MEMBER = held a membership valid on any day of the
 *                  month OR checked in at least three times in it — the same
 *                  definition club.activity freezes for invoicing.
 *   revenueByMonth payments received in the month, refunds subtracted.
 *   atRisk         a live abonnement and no visit for 21 days or more.
 *   fillRate       the last four weeks of each class: booked ÷ places, and
 *                  arrived ÷ booked.
 */

export const AT_RISK_DAYS = 21;
const MONTHS = 12;
const FILL_WEEKS = 4;

export interface MonthFigure {
  /** `YYYY-MM` */
  month: string;
  value: number;
}

export async function activeByMonth(actor: ClubActor): Promise<MonthFigure[]> {
  const result = await getDb().execute(sql`
    WITH months AS (
      SELECT generate_series(
               date_trunc('month', (now() AT TIME ZONE 'Europe/Sofia')::date) - make_interval(months => ${MONTHS - 1}::int),
               date_trunc('month', (now() AT TIME ZONE 'Europe/Sofia')::date),
               interval '1 month')::date AS first
    )
    SELECT to_char(mo.first, 'YYYY-MM') AS month,
      (SELECT count(*)::int FROM (
         SELECT mb.member_id FROM club_membership_balances mb
          WHERE ${clubScope(actor, 'reports.view', 'mb')}
            AND mb.cancelled_at IS NULL AND mb.starts_on < (mo.first + interval '1 month')::date
            AND mb.effective_ends_on >= mo.first
         UNION
         SELECT ci.member_id FROM club_checkins ci
          WHERE ${clubScope(actor, 'reports.view', 'ci')}
            AND ci.sofia_day >= mo.first AND ci.sofia_day < (mo.first + interval '1 month')::date
          GROUP BY ci.member_id HAVING count(*) >= 3) a) AS value
      FROM months mo
     ORDER BY mo.first
  `);
  return result.rows.map((row) => ({ month: String(row.month), value: Number(row.value ?? 0) }));
}

export async function revenueByMonth(actor: ClubActor): Promise<MonthFigure[]> {
  const result = await getDb().execute(sql`
    WITH months AS (
      SELECT generate_series(
               date_trunc('month', (now() AT TIME ZONE 'Europe/Sofia')::date) - make_interval(months => ${MONTHS - 1}::int),
               date_trunc('month', (now() AT TIME ZONE 'Europe/Sofia')::date),
               interval '1 month')::date AS first
    )
    SELECT to_char(mo.first, 'YYYY-MM') AS month,
           (SELECT coalesce(sum(p.amount_cents), 0)::bigint FROM club_payments p
             WHERE ${clubScope(actor, 'reports.view', 'p')}
               AND p.received_on >= mo.first
               AND p.received_on < (mo.first + interval '1 month')::date) AS value
      FROM months mo
     ORDER BY mo.first
  `);
  return result.rows.map((row) => ({ month: String(row.month), value: Number(row.value ?? 0) }));
}

export interface AtRiskMember {
  memberId: string;
  displayName: string;
  planName: string;
  lastVisit: string | null;
  endsOn: string;
}

export async function atRiskMembers(actor: ClubActor): Promise<AtRiskMember[]> {
  const result = await getDb().execute(sql`
    SELECT m.id, m.display_name, mb.plan_name, to_char(mb.effective_ends_on, 'YYYY-MM-DD') AS ends_on,
           to_char(last.day, 'YYYY-MM-DD') AS last_visit
      FROM club_membership_balances mb
      JOIN club_members m ON m.club_id = mb.club_id AND m.id = mb.member_id AND m.archived_at IS NULL
      LEFT JOIN LATERAL (
        SELECT max(ci.sofia_day) AS day FROM club_checkins ci
         WHERE ci.club_id = mb.club_id AND ci.member_id = mb.member_id
      ) last ON true
     WHERE ${clubScope(actor, 'reports.view', 'mb')} AND mb.state = 'active'
       AND mb.starts_on <= (now() AT TIME ZONE 'Europe/Sofia')::date - ${AT_RISK_DAYS}::int
       AND (last.day IS NULL
            OR last.day <= (now() AT TIME ZONE 'Europe/Sofia')::date - ${AT_RISK_DAYS}::int)
     ORDER BY last.day NULLS FIRST, lower(m.display_name)
     LIMIT 100
  `);
  return result.rows.map((row) => ({
    memberId: String(row.id),
    displayName: String(row.display_name),
    planName: String(row.plan_name),
    lastVisit: row.last_visit === null ? null : String(row.last_visit),
    endsOn: String(row.ends_on),
  }));
}

export interface ClassFill {
  classId: string;
  title: string;
  occurrences: number;
  /** Booked ÷ places, 0–1; null for a class without a limit. */
  fill: number | null;
  /** Arrived ÷ booked, 0–1; null when nobody booked. */
  attendance: number | null;
  avgBooked: number;
}

export async function classFillRates(actor: ClubActor): Promise<ClassFill[]> {
  const result = await getDb().execute(sql`
    WITH occ AS (
      SELECT o.id, o.class_id, coalesce(o.capacity, k.capacity) AS capacity,
             (SELECT count(*) FILTER (WHERE bp.booking_status = 'going')::int FROM club_booking_positions bp
               WHERE bp.club_id = o.club_id AND bp.occurrence_id = o.id) AS going,
             (SELECT count(*)::int FROM club_checkins ci
               WHERE ci.club_id = o.club_id AND ci.occurrence_id = o.id) AS arrived
        FROM club_class_occurrences o
        JOIN club_classes k ON k.id = o.class_id
       WHERE ${clubScope(actor, 'reports.view', 'o')} AND o.status = 'scheduled'
         AND o.starts_at < now() AND o.starts_at >= now() - make_interval(weeks => ${FILL_WEEKS}::int)
    )
    SELECT k.id, k.title, count(occ.id)::int AS occurrences,
           avg(occ.going)::float AS avg_booked,
           CASE WHEN bool_and(occ.capacity IS NOT NULL) AND sum(occ.capacity) > 0
                THEN sum(occ.going)::float / sum(occ.capacity) END AS fill,
           CASE WHEN sum(occ.going) > 0 THEN sum(least(occ.arrived, occ.going))::float / sum(occ.going) END
             AS attendance
      FROM occ JOIN club_classes k ON k.id = occ.class_id
     GROUP BY k.id, k.title
     ORDER BY fill DESC NULLS LAST, k.title
  `);
  return result.rows.map((row) => ({
    classId: String(row.id),
    title: String(row.title),
    occurrences: Number(row.occurrences ?? 0),
    fill: row.fill === null ? null : Number(row.fill),
    attendance: row.attendance === null ? null : Number(row.attendance),
    avgBooked: Number(row.avg_booked ?? 0),
  }));
}
