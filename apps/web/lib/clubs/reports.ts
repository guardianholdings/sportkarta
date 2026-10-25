import { getDb, sql } from '@sportkarta/db';
import { engagementBand, engagementScore } from '@sportkarta/lib/clubs';

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

// ─── Advanced reports (0045; tier feature `reports_advanced`) ──────────────
//
//   peakHours        check-ins of the last 8 weeks by Sofia weekday × hour.
//   retention        members whose FIRST abonnement began in a month (a
//                    cohort), and the share of them still holding a valid one
//                    1..5 months later.
//   churnByMonth     members with a valid abonnement in the previous month and
//                    none in this one, as a share of the previous month's.
//   revenueByPlan    payments of the last 90 days by what they paid for — the
//                    plan's name for an abonnement, else the charge's kind.
//   monthToDate      this month so far against the same days of last month.
//   topClients       most visits in 90 days, and most paid in 12 months.
//   staffPay         per member of staff for a month: classes taught (the
//                    occurrence's effective instructor), check-ins at them,
//                    abonnement payments on sales they made, and the pay their
//                    terms give — computed, never stored (0039: no payroll).
//   engagementBands  members holding a live abonnement by engagement band
//                    (lib/src/clubs/engagement.ts).

const PEAK_WEEKS = 8;

export interface PeakCell {
  /** ISO weekday 1 = Monday. */
  weekday: number;
  hour: number;
  count: number;
}

export async function peakHours(actor: ClubActor): Promise<PeakCell[]> {
  const result = await getDb().execute(sql`
    SELECT extract(isodow FROM ci.checked_in_at AT TIME ZONE 'Europe/Sofia')::int AS weekday,
           extract(hour FROM ci.checked_in_at AT TIME ZONE 'Europe/Sofia')::int AS hour,
           count(*)::int AS count
      FROM club_checkins ci
     WHERE ${clubScope(actor, 'reports.view', 'ci')}
       AND ci.checked_in_at >= now() - make_interval(weeks => ${PEAK_WEEKS}::int)
     GROUP BY 1, 2
  `);
  return result.rows.map((row) => ({
    weekday: Number(row.weekday),
    hour: Number(row.hour),
    count: Number(row.count),
  }));
}

export interface Cohort {
  /** `YYYY-MM` of the first abonnement. */
  month: string;
  size: number;
  /** Share still valid after 1..5 months; null where that month is in the future. */
  kept: (number | null)[];
}

export async function retentionCohorts(actor: ClubActor): Promise<Cohort[]> {
  const result = await getDb().execute(sql`
    WITH firsts AS (
      SELECT mb.member_id, date_trunc('month', min(mb.starts_on))::date AS cohort
        FROM club_membership_balances mb
       WHERE ${clubScope(actor, 'reports.view', 'mb')} AND mb.cancelled_at IS NULL
         AND mb.kind <> 'trial'
       GROUP BY mb.member_id
    ), cohorts AS (
      SELECT cohort, array_agg(member_id) AS members FROM firsts
       WHERE cohort >= date_trunc('month', (now() AT TIME ZONE 'Europe/Sofia')::date) - interval '6 months'
       GROUP BY cohort
    )
    SELECT to_char(c.cohort, 'YYYY-MM') AS month, cardinality(c.members) AS size,
           array(SELECT CASE WHEN (c.cohort + make_interval(months => k))::date
                                  > (now() AT TIME ZONE 'Europe/Sofia')::date THEN NULL
                        ELSE (SELECT count(DISTINCT mb.member_id)::float FROM club_membership_balances mb
                               WHERE mb.club_id = ${actor.clubId}::uuid
                                 AND mb.member_id = ANY(c.members) AND mb.cancelled_at IS NULL
                                 AND mb.starts_on <= (c.cohort + make_interval(months => k))::date
                                 AND mb.effective_ends_on >= (c.cohort + make_interval(months => k))::date)
                             / cardinality(c.members) END
                   FROM generate_series(1, 5) AS k ORDER BY k) AS kept
      FROM cohorts c
     ORDER BY c.cohort
  `);
  return result.rows.map((row) => ({
    month: String(row.month),
    size: Number(row.size),
    kept: (Array.isArray(row.kept) ? row.kept : []).map((v) => (v === null ? null : Number(v))),
  }));
}

export async function churnByMonth(actor: ClubActor): Promise<MonthFigure[]> {
  const result = await getDb().execute(sql`
    WITH months AS (
      SELECT generate_series(
               date_trunc('month', (now() AT TIME ZONE 'Europe/Sofia')::date) - make_interval(months => ${MONTHS - 1}::int),
               date_trunc('month', (now() AT TIME ZONE 'Europe/Sofia')::date) - interval '1 month',
               interval '1 month')::date AS first
    ), valid AS (
      SELECT mo.first, mb.member_id
        FROM months mo
        JOIN club_membership_balances mb
          ON ${clubScope(actor, 'reports.view', 'mb')} AND mb.cancelled_at IS NULL
         AND mb.starts_on < (mo.first + interval '1 month')::date AND mb.effective_ends_on >= mo.first
       GROUP BY mo.first, mb.member_id
    )
    SELECT to_char(mo.first, 'YYYY-MM') AS month,
           CASE WHEN count(prev.member_id) = 0 THEN 0
                ELSE count(prev.member_id) FILTER (WHERE now_.member_id IS NULL)::float
                     / count(prev.member_id) END AS value
      FROM months mo
      LEFT JOIN valid prev ON prev.first = (mo.first - interval '1 month')::date
      LEFT JOIN valid now_ ON now_.first = mo.first AND now_.member_id = prev.member_id
     GROUP BY mo.first
     ORDER BY mo.first
  `);
  return result.rows.map((row) => ({ month: String(row.month), value: Number(row.value ?? 0) }));
}

export interface RevenueLine {
  label: string;
  /** 'plan' when `label` is a plan name, else the charge kind. */
  kind: string;
  cents: number;
}

export async function revenueByPlan(actor: ClubActor): Promise<RevenueLine[]> {
  const result = await getDb().execute(sql`
    SELECT CASE WHEN ms.id IS NOT NULL THEN ms.plan_name ELSE ch.kind END AS label,
           CASE WHEN ms.id IS NOT NULL THEN 'plan' ELSE ch.kind END AS kind,
           sum(p.amount_cents)::bigint AS cents
      FROM club_payments p
      JOIN club_charges ch ON ch.id = p.charge_id
      LEFT JOIN club_memberships ms ON ms.id = ch.membership_id
     WHERE ${clubScope(actor, 'reports.view', 'p')}
       AND p.received_on >= (now() AT TIME ZONE 'Europe/Sofia')::date - 90
     GROUP BY 1, 2
     ORDER BY cents DESC
     LIMIT 20
  `);
  return result.rows.map((row) => ({
    label: String(row.label),
    kind: String(row.kind),
    cents: Number(row.cents ?? 0),
  }));
}

export interface MonthToDate {
  /** Days elapsed this month, compared with the same days last month. */
  days: number;
  revenue: [number, number];
  checkins: [number, number];
  newMembers: [number, number];
  sales: [number, number];
}

export async function monthToDate(actor: ClubActor): Promise<MonthToDate> {
  const result = await getDb().execute(sql`
    WITH d AS (
      SELECT (now() AT TIME ZONE 'Europe/Sofia')::date AS today,
             date_trunc('month', (now() AT TIME ZONE 'Europe/Sofia')::date)::date AS this_first,
             (date_trunc('month', (now() AT TIME ZONE 'Europe/Sofia')::date) - interval '1 month')::date
               AS last_first
    ), w AS (
      SELECT d.*, (d.today - d.this_first) AS elapsed,
             least((d.last_first + (d.today - d.this_first)), (d.this_first - 1)) AS last_until
        FROM d
    )
    SELECT w.elapsed + 1 AS days,
      (SELECT coalesce(sum(p.amount_cents), 0)::bigint FROM club_payments p
        WHERE ${clubScope(actor, 'reports.view', 'p')} AND p.received_on BETWEEN w.this_first AND w.today) AS rev_now,
      (SELECT coalesce(sum(p.amount_cents), 0)::bigint FROM club_payments p
        WHERE ${clubScope(actor, 'reports.view', 'p')} AND p.received_on BETWEEN w.last_first AND w.last_until) AS rev_then,
      (SELECT count(*)::int FROM club_checkins ci
        WHERE ${clubScope(actor, 'reports.view', 'ci')} AND ci.sofia_day BETWEEN w.this_first AND w.today) AS ci_now,
      (SELECT count(*)::int FROM club_checkins ci
        WHERE ${clubScope(actor, 'reports.view', 'ci')} AND ci.sofia_day BETWEEN w.last_first AND w.last_until) AS ci_then,
      (SELECT count(*)::int FROM club_members m
        WHERE ${clubScope(actor, 'reports.view', 'm')}
          AND (m.created_at AT TIME ZONE 'Europe/Sofia')::date BETWEEN w.this_first AND w.today) AS new_now,
      (SELECT count(*)::int FROM club_members m
        WHERE ${clubScope(actor, 'reports.view', 'm')}
          AND (m.created_at AT TIME ZONE 'Europe/Sofia')::date BETWEEN w.last_first AND w.last_until) AS new_then,
      (SELECT count(*)::int FROM club_memberships ms
        WHERE ${clubScope(actor, 'reports.view', 'ms')} AND ms.cancelled_at IS NULL
          AND (ms.created_at AT TIME ZONE 'Europe/Sofia')::date BETWEEN w.this_first AND w.today) AS sales_now,
      (SELECT count(*)::int FROM club_memberships ms
        WHERE ${clubScope(actor, 'reports.view', 'ms')} AND ms.cancelled_at IS NULL
          AND (ms.created_at AT TIME ZONE 'Europe/Sofia')::date BETWEEN w.last_first AND w.last_until) AS sales_then
      FROM w
  `);
  const row = result.rows[0] ?? {};
  const pair = (a: unknown, b: unknown): [number, number] => [Number(a ?? 0), Number(b ?? 0)];
  return {
    days: Number(row.days ?? 1),
    revenue: pair(row.rev_now, row.rev_then),
    checkins: pair(row.ci_now, row.ci_then),
    newMembers: pair(row.new_now, row.new_then),
    sales: pair(row.sales_now, row.sales_then),
  };
}

export interface TopClient {
  memberId: string;
  displayName: string;
  value: number;
}

export async function topClients(
  actor: ClubActor,
): Promise<{ byVisits: TopClient[]; bySpend: TopClient[] }> {
  const db = getDb();
  const [visits, spend] = await Promise.all([
    db.execute(sql`
      SELECT m.id, m.display_name, count(*)::int AS value
        FROM club_checkins ci
        JOIN club_members m ON m.club_id = ci.club_id AND m.id = ci.member_id AND m.archived_at IS NULL
       WHERE ${clubScope(actor, 'reports.view', 'ci')}
         AND ci.sofia_day >= (now() AT TIME ZONE 'Europe/Sofia')::date - 90
       GROUP BY m.id, m.display_name
       ORDER BY value DESC, lower(m.display_name)
       LIMIT 10
    `),
    db.execute(sql`
      SELECT m.id, m.display_name, sum(p.amount_cents)::bigint AS value
        FROM club_payments p
        JOIN club_members m ON m.club_id = p.club_id AND m.id = p.member_id AND m.archived_at IS NULL
       WHERE ${clubScope(actor, 'reports.view', 'p')}
         AND p.received_on >= (now() AT TIME ZONE 'Europe/Sofia')::date - 365
       GROUP BY m.id, m.display_name
      HAVING sum(p.amount_cents) > 0
       ORDER BY value DESC, lower(m.display_name)
       LIMIT 10
    `),
  ]);
  const map = (rows: Record<string, unknown>[]): TopClient[] =>
    rows.map((row) => ({
      memberId: String(row.id),
      displayName: String(row.display_name),
      value: Number(row.value ?? 0),
    }));
  return { byVisits: map(visits.rows), bySpend: map(spend.rows) };
}

export interface StaffPayLine {
  userId: string;
  name: string;
  classes: number;
  attendees: number;
  salesCents: number;
  payKind: string;
  /** What the terms give for the month; null for 'none'. */
  payCents: number | null;
}

/** `month` is `YYYY-MM`. */
export async function staffPay(actor: ClubActor, month: string): Promise<StaffPayLine[]> {
  const result = await getDb().execute(sql`
    WITH span AS (
      SELECT ${`${month}-01`}::date AS first, (${`${month}-01`}::date + interval '1 month')::date AS next
    ), taught AS (
      SELECT coalesce(o.instructor_user_id, k.instructor_user_id) AS user_id, o.id AS occurrence_id
        FROM club_class_occurrences o
        JOIN club_classes k ON k.id = o.class_id
        JOIN span ON true
       WHERE ${clubScope(actor, 'reports.view', 'o')} AND o.status = 'scheduled'
         AND o.starts_at < now()
         AND (o.starts_at AT TIME ZONE 'Europe/Sofia')::date >= span.first
         AND (o.starts_at AT TIME ZONE 'Europe/Sofia')::date < span.next
    ), per AS (
      SELECT t.user_id, count(DISTINCT t.occurrence_id)::int AS classes,
             count(ci.id)::int AS attendees
        FROM taught t LEFT JOIN club_checkins ci ON ci.occurrence_id = t.occurrence_id
       WHERE t.user_id IS NOT NULL
       GROUP BY t.user_id
    ), sold AS (
      SELECT ms.sold_by AS user_id, sum(p.amount_cents)::bigint AS cents
        FROM club_payments p
        JOIN club_charges ch ON ch.id = p.charge_id
        JOIN club_memberships ms ON ms.id = ch.membership_id
        JOIN span ON true
       WHERE ${clubScope(actor, 'reports.view', 'p')}
         AND p.received_on >= span.first AND p.received_on < span.next AND ms.sold_by IS NOT NULL
       GROUP BY ms.sold_by
    )
    SELECT s.user_id, s.pay_rate_kind, s.pay_rate_cents, s.pay_share_bp,
           coalesce(nullif(btrim(s.display_name), ''), nullif(btrim(u.display_name), ''),
                    split_part(u.email, '@', 1)) AS name,
           coalesce(per.classes, 0) AS classes, coalesce(per.attendees, 0) AS attendees,
           coalesce(sold.cents, 0) AS sales
      FROM club_staff s
      JOIN users u ON u.id = s.user_id
      LEFT JOIN per ON per.user_id = s.user_id
      LEFT JOIN sold ON sold.user_id = s.user_id
     WHERE ${clubScope(actor, 'reports.view', 's')}
       AND (per.classes > 0 OR sold.cents > 0 OR s.pay_rate_kind <> 'none')
     ORDER BY name
  `);
  return result.rows.map((row) => {
    const classes = Number(row.classes);
    const attendees = Number(row.attendees);
    const salesCents = Number(row.sales);
    const kind = String(row.pay_rate_kind);
    const rate = row.pay_rate_cents === null ? 0 : Number(row.pay_rate_cents);
    const share = row.pay_share_bp === null ? 0 : Number(row.pay_share_bp);
    const payCents =
      kind === 'flat'
        ? rate * classes
        : kind === 'per_head'
          ? rate * attendees
          : kind === 'share'
            ? Math.round((salesCents * share) / 10_000)
            : null;
    return {
      userId: String(row.user_id),
      name: String(row.name),
      classes,
      attendees,
      salesCents,
      payKind: kind,
      payCents,
    };
  });
}

export interface EngagementBands {
  high: number;
  medium: number;
  low: number;
}

/** Members with a live abonnement, by engagement band. */
export async function engagementBands(actor: ClubActor): Promise<EngagementBands> {
  const result = await getDb().execute(sql`
    SELECT m.id,
           ((now() AT TIME ZONE 'Europe/Sofia')::date - last.day) AS days_since,
           (SELECT count(*)::int FROM club_checkins ci
             WHERE ci.club_id = m.club_id AND ci.member_id = m.id
               AND ci.sofia_day > (now() AT TIME ZONE 'Europe/Sofia')::date - 30) AS visits30,
           (SELECT (extract(year FROM age((now() AT TIME ZONE 'Europe/Sofia')::date, min(ms.starts_on))) * 12
                  + extract(month FROM age((now() AT TIME ZONE 'Europe/Sofia')::date, min(ms.starts_on))))::int
              FROM club_memberships ms
             WHERE ms.club_id = m.club_id AND ms.member_id = m.id AND ms.cancelled_at IS NULL) AS months
      FROM club_members m
      LEFT JOIN LATERAL (SELECT max(ci.sofia_day) AS day FROM club_checkins ci
                          WHERE ci.club_id = m.club_id AND ci.member_id = m.id) last ON true
     WHERE ${clubScope(actor, 'reports.view', 'm')} AND m.archived_at IS NULL
       AND EXISTS (SELECT 1 FROM club_membership_balances mb
                    WHERE mb.club_id = m.club_id AND mb.member_id = m.id
                      AND mb.state IN ('active', 'paused'))
  `);
  const bands: EngagementBands = { high: 0, medium: 0, low: 0 };
  for (const row of result.rows) {
    const score = engagementScore({
      daysSinceLastVisit: row.days_since === null ? null : Number(row.days_since),
      visitsLast30Days: Number(row.visits30 ?? 0),
      monthsAsMember: Math.max(0, Number(row.months ?? 0)),
    });
    bands[engagementBand(score)] += 1;
  }
  return bands;
}
