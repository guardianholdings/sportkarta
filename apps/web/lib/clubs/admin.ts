import { getDb, sql, type SQL } from '@sportkarta/db';
import {
  CLUB_PURGE_AFTER_DAYS,
  CLUB_TRIAL_DAYS,
  clubAccessState,
  sofiaToday,
  type ClubAccessState,
  type ClubContractBilling,
  type ClubKind,
  type ClubStatus,
  type ClubTier,
  type IsoDate,
} from '@sportkarta/lib/clubs';

import { recordAdminAction } from '../admin-actions';

import { clubWritableSql } from './access';

/**
 * The operator's side of «Клубове» — /admin/klubove (requireRole('admin') on
 * every page and action).
 *
 * THE OPERATOR SELLS THE ADD-ON BY INVOICE (decision 2026-10-24): approving an
 * application starts a 30-day trial on any tier (all are paid); when the bank transfer
 * arrives the operator records `paid_until`; nothing here charges a card.
 * Every change lands in admin_actions IN THE SAME TRANSACTION (0033's rule),
 * and every state change is written as "set the TARGET state WHERE it differs"
 * so a double submit settles and logs nothing twice.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export type AdminClubFilter = 'pending' | 'live' | 'lapsed' | 'suspended' | 'archived';

export const ADMIN_CLUB_FILTERS: readonly AdminClubFilter[] = [
  'pending',
  'live',
  'lapsed',
  'suspended',
  'archived',
];

/** Days an archived club stays exportable before it may be purged (Art. 28(3)(g)). */
export const PURGE_AFTER_DAYS = CLUB_PURGE_AFTER_DAYS;

export interface AdminClubRow {
  id: string;
  slug: string;
  nameBg: string;
  kind: ClubKind;
  tier: ClubTier;
  status: ClubStatus;
  accessState: ClubAccessState;
  visible: boolean;
  trialEndsOn: IsoDate | null;
  paidUntil: IsoDate | null;
  memberCap: number | null;
  /** SMS parts per Sofia month (0051); 0 = no SMS. */
  smsMonthlyCap: number;
  appliedAt: string;
  cityBg: string | null;
  cityEn: string | null;
  owners: number;
  ownerName: string | null;
  ownerEmail: string | null;
  members: number;
  lastMonthActive: number | null;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function filterSql(filter: AdminClubFilter): SQL {
  switch (filter) {
    case 'pending':
      return sql`c.status = 'pending'`;
    case 'live':
      return sql`${clubWritableSql('c')}`;
    case 'lapsed':
      return sql`c.status = 'active' AND NOT ${clubWritableSql('c')}`;
    case 'suspended':
      return sql`c.status = 'suspended'`;
    case 'archived':
      return sql`c.status = 'archived'`;
  }
}

function toRow(row: Record<string, unknown>, today: IsoDate): AdminClubRow {
  const club = {
    status: String(row.status) as ClubStatus,
    tier: String(row.tier) as ClubTier,
    trialEndsOn: text(row.trial_ends_on),
    paidUntil: text(row.paid_until),
  };
  return {
    id: String(row.id),
    slug: String(row.slug),
    nameBg: String(row.name_bg),
    kind: String(row.kind) as ClubKind,
    ...club,
    accessState: clubAccessState(club, today),
    visible: row.visible === true,
    memberCap: row.member_cap === null ? null : Number(row.member_cap),
    smsMonthlyCap: Number(row.sms_monthly_cap ?? 0),
    appliedAt: new Date(String(row.applied_at)).toISOString(),
    cityBg: text(row.city_bg),
    cityEn: text(row.city_en),
    owners: Number(row.owners ?? 0),
    ownerName: text(row.owner_name),
    ownerEmail: text(row.owner_email),
    members: Number(row.members ?? 0),
    lastMonthActive: row.last_active === null ? null : Number(row.last_active),
  };
}

const LIST_COLUMNS = sql`
  c.id, c.slug, c.name_bg, c.kind, c.tier, c.status, c.visible, c.member_cap, c.sms_monthly_cap,
  c.applied_at,
  to_char(c.trial_ends_on, 'YYYY-MM-DD') AS trial_ends_on,
  to_char(c.paid_until, 'YYYY-MM-DD') AS paid_until,
  mu.name_bg AS city_bg, mu.name_en AS city_en,
  (SELECT count(*)::int FROM club_staff s WHERE s.club_id = c.id AND s.role = 'owner') AS owners,
  (SELECT u.display_name FROM club_staff s JOIN users u ON u.id = s.user_id
    WHERE s.club_id = c.id AND s.role = 'owner' ORDER BY s.created_at LIMIT 1) AS owner_name,
  (SELECT u.email FROM club_staff s JOIN users u ON u.id = s.user_id
    WHERE s.club_id = c.id AND s.role = 'owner' ORDER BY s.created_at LIMIT 1) AS owner_email,
  (SELECT count(*)::int FROM club_members m WHERE m.club_id = c.id AND m.archived_at IS NULL) AS members,
  (SELECT a.members_active FROM club_monthly_activity a WHERE a.club_id = c.id
    ORDER BY a.month DESC LIMIT 1) AS last_active`;

export async function adminClubList(filter: AdminClubFilter): Promise<AdminClubRow[]> {
  const today = sofiaToday();
  const result = await getDb().execute(sql`
    SELECT ${LIST_COLUMNS}
      FROM clubs c
      LEFT JOIN municipalities mu ON mu.id = c.municipality_id
     WHERE ${filterSql(filter)}
     ORDER BY c.applied_at DESC
     LIMIT 500
  `);
  return result.rows.map((row) => toRow(row, today));
}

export async function adminClubCounts(): Promise<Record<AdminClubFilter, number>> {
  const result = await getDb().execute(sql`
    SELECT count(*) FILTER (WHERE c.status = 'pending')::int AS pending,
           count(*) FILTER (WHERE ${clubWritableSql('c')})::int AS live,
           count(*) FILTER (WHERE c.status = 'active' AND NOT ${clubWritableSql('c')})::int AS lapsed,
           count(*) FILTER (WHERE c.status = 'suspended')::int AS suspended,
           count(*) FILTER (WHERE c.status = 'archived')::int AS archived
      FROM clubs c
  `);
  const row = result.rows[0] ?? {};
  return {
    pending: Number(row.pending ?? 0),
    live: Number(row.live ?? 0),
    lapsed: Number(row.lapsed ?? 0),
    suspended: Number(row.suspended ?? 0),
    archived: Number(row.archived ?? 0),
  };
}

export interface AdminClubDetail extends AdminClubRow {
  legalName: string | null;
  eik: string | null;
  publicEmail: string | null;
  websiteUrl: string | null;
  descriptionBg: string | null;
  sports: string[];
  approvedAt: string | null;
  archivedAt: string | null;
  purgeableFrom: IsoDate | null;
  /** The contract's recorded facts (0061); its terms come from clubContractTerm. */
  contractStartsOn: IsoDate | null;
  contractBilling: ClubContractBilling | null;
  contractNoticeOn: IsoDate | null;
  staff: { userId: string; name: string; email: string; role: string; since: string }[];
  counts: {
    members: number;
    liveMemberships: number;
    classes: number;
    checkins30: number;
    locations: number;
  };
  activity: { month: IsoDate; membersActive: number; checkins: number; revenueCents: number }[];
}

export async function adminClubDetail(slug: string): Promise<AdminClubDetail | null> {
  const db = getDb();
  const today = sofiaToday();
  const result = await db.execute(sql`
    SELECT ${LIST_COLUMNS}, c.legal_name, c.eik, c.public_email, c.website_url, c.description_bg,
           c.sports, c.approved_at, c.archived_at, c.contract_billing,
           to_char(c.contract_starts_on, 'YYYY-MM-DD') AS contract_starts_on,
           to_char(c.contract_notice_on, 'YYYY-MM-DD') AS contract_notice_on,
           to_char((c.archived_at AT TIME ZONE 'Europe/Sofia')::date + ${PURGE_AFTER_DAYS}::int,
                   'YYYY-MM-DD') AS purgeable_from
      FROM clubs c
      LEFT JOIN municipalities mu ON mu.id = c.municipality_id
     WHERE c.slug = ${slug}
  `);
  const row = result.rows[0];
  if (!row) return null;
  const base = toRow(row, today);
  const [staff, counts, activity] = await Promise.all([
    db.execute(sql`
      SELECT s.user_id, u.display_name, u.email, s.role, s.created_at
        FROM club_staff s JOIN users u ON u.id = s.user_id
       WHERE s.club_id = ${base.id}::uuid
       ORDER BY array_position(ARRAY['owner','manager','trainer','desk'], s.role), s.created_at
    `),
    db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM club_members m WHERE m.club_id = ${base.id}::uuid AND m.archived_at IS NULL) AS members,
        (SELECT count(*)::int FROM club_membership_balances b
          WHERE b.club_id = ${base.id}::uuid AND b.state IN ('active', 'paused')) AS live_memberships,
        (SELECT count(*)::int FROM club_classes k WHERE k.club_id = ${base.id}::uuid AND k.status = 'scheduled') AS classes,
        (SELECT count(*)::int FROM club_checkins ci WHERE ci.club_id = ${base.id}::uuid
            AND ci.sofia_day >= (now() AT TIME ZONE 'Europe/Sofia')::date - 30) AS checkins30,
        (SELECT count(*)::int FROM club_locations l WHERE l.club_id = ${base.id}::uuid AND l.active) AS locations
    `),
    db.execute(sql`
      SELECT to_char(a.month, 'YYYY-MM-DD') AS month, a.members_active, a.checkins, a.revenue_cents
        FROM club_monthly_activity a
       WHERE a.club_id = ${base.id}::uuid
       ORDER BY a.month DESC LIMIT 12
    `),
  ]);
  const c = counts.rows[0] ?? {};
  return {
    ...base,
    legalName: text(row.legal_name),
    eik: text(row.eik),
    publicEmail: text(row.public_email),
    websiteUrl: text(row.website_url),
    descriptionBg: text(row.description_bg),
    sports: Array.isArray(row.sports) ? row.sports.map(String) : [],
    approvedAt: row.approved_at ? new Date(String(row.approved_at)).toISOString() : null,
    archivedAt: row.archived_at ? new Date(String(row.archived_at)).toISOString() : null,
    purgeableFrom: text(row.purgeable_from),
    contractStartsOn: text(row.contract_starts_on),
    contractBilling: text(row.contract_billing) as ClubContractBilling | null,
    contractNoticeOn: text(row.contract_notice_on),
    staff: staff.rows.map((s) => ({
      userId: String(s.user_id),
      name: String(s.display_name ?? ''),
      email: String(s.email),
      role: String(s.role),
      since: new Date(String(s.created_at)).toISOString(),
    })),
    counts: {
      members: Number(c.members ?? 0),
      liveMemberships: Number(c.live_memberships ?? 0),
      classes: Number(c.classes ?? 0),
      checkins30: Number(c.checkins30 ?? 0),
      locations: Number(c.locations ?? 0),
    },
    activity: activity.rows.map((a) => ({
      month: String(a.month),
      membersActive: Number(a.members_active),
      checkins: Number(a.checkins),
      revenueCents: Number(a.revenue_cents),
    })),
  };
}

// ─── Changes ───────────────────────────────────────────────────────────────

/** Approve a pending application: active, and the trial (every tier is paid, 2026-10-31). */
export async function approveClub(
  db: TransactionalDb,
  adminId: string,
  clubId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE clubs
         SET status = 'active', approved_at = now(),
             trial_ends_on = coalesce(trial_ends_on,
               (now() AT TIME ZONE 'Europe/Sofia')::date + ${CLUB_TRIAL_DAYS}::int)
       WHERE id = ${clubId}::uuid AND status = 'pending'
       RETURNING id
    `);
    if (updated.rows.length === 0) return false;
    await recordAdminAction(tx, adminId, {
      action: 'club_status_changed',
      detail: { clubId, status: 'active' },
    });
    return true;
  });
}

/** Turn an application down: archived, never approved (the data goes at purge). */
export async function rejectApplication(
  db: TransactionalDb,
  adminId: string,
  clubId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE clubs SET status = 'archived', archived_at = now()
       WHERE id = ${clubId}::uuid AND status = 'pending'
       RETURNING id
    `);
    if (updated.rows.length === 0) return false;
    await recordAdminAction(tx, adminId, {
      action: 'club_status_changed',
      detail: { clubId, status: 'archived' },
    });
    return true;
  });
}

export interface ClubPlanChange {
  tier: ClubTier;
  paidUntil: IsoDate | null;
  trialEndsOn: IsoDate | null;
  memberCap: number | null;
  smsMonthlyCap: number;
  /** The contract, as signed offline (0061): both or neither of start and billing. */
  contractStartsOn: IsoDate | null;
  contractBilling: ClubContractBilling | null;
  contractNoticeOn: IsoDate | null;
}

export async function setClubPlan(
  db: TransactionalDb,
  adminId: string,
  clubId: string,
  change: ClubPlanChange,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE clubs
         SET tier = ${change.tier}, paid_until = ${change.paidUntil}::date,
             trial_ends_on = ${change.trialEndsOn}::date, member_cap = ${change.memberCap},
             sms_monthly_cap = ${change.smsMonthlyCap},
             contract_starts_on = ${change.contractStartsOn}::date,
             contract_billing = ${change.contractBilling}::text,
             contract_notice_on = ${change.contractNoticeOn}::date
       WHERE id = ${clubId}::uuid
         AND (tier, paid_until, trial_ends_on, member_cap, sms_monthly_cap,
              contract_starts_on, contract_billing, contract_notice_on) IS DISTINCT FROM
             (${change.tier}::text, ${change.paidUntil}::date, ${change.trialEndsOn}::date,
              ${change.memberCap}::int, ${change.smsMonthlyCap}::int,
              ${change.contractStartsOn}::date, ${change.contractBilling}::text,
              ${change.contractNoticeOn}::date)
       RETURNING id
    `);
    if (updated.rows.length === 0) return false;
    await recordAdminAction(tx, adminId, {
      action: 'club_plan_changed',
      detail: { clubId, ...change },
    });
    return true;
  });
}

export type ClubStatusTarget = 'active' | 'suspended' | 'archived';

/**
 * Suspend, reinstate or archive an APPROVED club. The status/timestamp pairs
 * are CHECKs (0039), so each target writes both; the WHERE names the states a
 * target may be reached from, so an illegal move updates nothing.
 */
export async function setClubStatus(
  db: TransactionalDb,
  adminId: string,
  clubId: string,
  target: ClubStatusTarget,
): Promise<boolean> {
  const transition = (() => {
    switch (target) {
      case 'suspended':
        return sql`SET status = 'suspended', suspended_at = now()
                   WHERE id = ${clubId}::uuid AND status = 'active'`;
      case 'active':
        return sql`SET status = 'active', suspended_at = NULL, archived_at = NULL
                   WHERE id = ${clubId}::uuid AND status IN ('suspended', 'archived')
                     AND approved_at IS NOT NULL`;
      case 'archived':
        return sql`SET status = 'archived', archived_at = now(), suspended_at = NULL, visible = false
                   WHERE id = ${clubId}::uuid AND status IN ('active', 'suspended')`;
    }
  })();
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`UPDATE clubs ${transition} RETURNING id`);
    if (updated.rows.length === 0) return false;
    await recordAdminAction(tx, adminId, {
      action: 'club_status_changed',
      detail: { clubId, status: target },
    });
    return true;
  });
}

/**
 * Delete an archived club and EVERYTHING it held, after the export window
 * (0039: the processor deletes at contract end, Art. 28(3)(g)). The ledgers'
 * append-only triggers admit the cascade only because this transaction names
 * the club in `pops.purging_club`. Returns the logo key so the caller can
 * remove the file after the commit.
 */
export async function purgeClub(
  db: TransactionalDb,
  adminId: string,
  clubId: string,
): Promise<{ purged: boolean; logoPath: string | null }> {
  return db.transaction(async (tx) => {
    const club = await tx.execute(sql`
      SELECT logo_path FROM clubs
       WHERE id = ${clubId}::uuid AND status = 'archived'
         AND archived_at < now() - make_interval(days => ${PURGE_AFTER_DAYS}::int)
       FOR UPDATE
    `);
    if (club.rows.length === 0) return { purged: false, logoPath: null };
    await recordAdminAction(tx, adminId, { action: 'club_purged', detail: { clubId } });
    await tx.execute(sql`SELECT set_config('pops.purging_club', ${clubId}, true)`);
    await tx.execute(sql`DELETE FROM clubs WHERE id = ${clubId}::uuid`);
    return { purged: true, logoPath: text(club.rows[0]?.logo_path) };
  });
}
