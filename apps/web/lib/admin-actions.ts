import { getDb, sql, type SQL } from '@sportkarta/db';

/**
 * Who CHANGED what (migration 0033) — the only writer and the only reader of
 * `admin_actions`.
 *
 * Every privilege or visibility change an admin makes lands here IN THE SAME
 * TRANSACTION as the change itself, so "changed but unlogged" is not a
 * reachable state (the moderation_decisions rule, lib/moderation.ts). Reads of
 * a member's data are a different question and live in lib/account-access.ts.
 *
 * THE RECORD TYPE IS THE PRIVACY BOUNDARY. `detail` is a jsonb column, and a
 * jsonb column will hold whatever it is handed; what stops it from becoming a
 * second store of personal data is that the only way to write a row is
 * `AdminActionRecord`, whose details are ids, counts, booleans and one closed
 * setting key. There is deliberately no variant that carries a display name, a
 * suspension reason or an email: the table is append-only, so anything written
 * here would survive the member's erasure forever.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Settings an admin can switch from the UI. Closed, so `detail.key` is never free text. */
export type AdminSettingKey = 'public_show_paid';

export type AdminActionRecord =
  | {
      action: 'account_suspended';
      subjectId: string;
      detail: { sessionsRevoked: number; passportWasPublic: boolean };
    }
  | { action: 'account_unsuspended'; subjectId: string }
  | { action: 'display_name_reset'; subjectId: string; detail: { passportMadePrivate: boolean } }
  | { action: 'passport_made_private'; subjectId: string }
  | { action: 'sessions_revoked'; subjectId: string; detail: { count: number } }
  | { action: 'account_erased'; subjectId: string }
  | { action: 'ambassador_granted'; subjectId: string }
  | { action: 'ambassador_revoked'; subjectId: string; detail: { scopesRemoved: number } }
  | {
      action: 'ambassador_scope_added' | 'ambassador_scope_removed';
      subjectId: string;
      detail: { municipalityId: number };
    }
  | { action: 'setting_changed'; detail: { key: AdminSettingKey; value: 'true' | 'false' } }
  | { action: 'business_visibility_changed'; detail: { businessId: number; visible: boolean } };

export type AdminAction = AdminActionRecord['action'];

/**
 * The national switches — the only actions with no account as their subject.
 * Mirrors `admin_actions_subject_matches_action` (0033), which refuses a row
 * that disagrees.
 */
export const SUBJECTLESS_ACTIONS = [
  'setting_changed',
  'business_visibility_changed',
] as const satisfies readonly AdminAction[];

export const AMBASSADOR_ACTIONS = [
  'ambassador_granted',
  'ambassador_revoked',
  'ambassador_scope_added',
  'ambassador_scope_removed',
] as const satisfies readonly AdminAction[];

/**
 * Append one row. Called with the TRANSACTION the change runs in — never with
 * a fresh connection, or a rolled-back change would leave a logged one behind.
 */
export async function recordAdminAction(
  db: SqlRunner,
  actorId: string,
  record: AdminActionRecord,
): Promise<void> {
  const subjectId = 'subjectId' in record ? record.subjectId : null;
  const detail = 'detail' in record ? record.detail : {};
  await db.execute(sql`
    INSERT INTO admin_actions (actor_id, action, subject_id, detail)
    VALUES (${actorId}, ${record.action}::admin_action, ${subjectId},
            ${JSON.stringify(detail)}::jsonb)
  `);
}

export interface AdminActionEntry {
  id: number;
  action: AdminAction;
  actorId: string;
  /** The admin's name/address IF their account still exists. */
  actorName: string | null;
  actorEmail: string | null;
  subjectId: string | null;
  subjectName: string | null;
  subjectEmail: string | null;
  /** Resolved from `detail.municipalityId` for the scope actions. */
  municipalityNameBg: string | null;
  municipalityNameEn: string | null;
  /** Resolved from `detail.businessId` for business visibility. */
  businessName: string | null;
  detail: Record<string, unknown>;
  actedAt: string;
}

function textOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * The log, newest first, filtered by subject and/or by a set of actions.
 *
 * Every join is LEFT: `actor_id` and `subject_id` carry no FK, so an erased
 * account resolves to NULL and renders as the "former user" label — the row
 * itself is never lost. The municipality and business are looked up from the
 * ids in `detail` only when the value really is a number — inside a CASE, which
 * unlike an AND fixes the evaluation order — so a malformed detail can never
 * turn a history panel into a 500.
 */
export async function adminActionHistory(
  filter: { subjectId?: string; actions?: readonly AdminAction[] },
  limit = 50,
): Promise<AdminActionEntry[]> {
  const conditions: SQL[] = [sql`TRUE`];
  if (filter.subjectId) conditions.push(sql`a.subject_id = ${filter.subjectId}`);
  if (filter.actions && filter.actions.length > 0) {
    // sql.param binds the list as ONE array parameter (CLAUDE.md).
    conditions.push(sql`a.action::text = ANY(${sql.param([...filter.actions])}::text[])`);
  }

  const result = await getDb().execute(sql`
    SELECT a.id, a.action::text AS action, a.actor_id, a.subject_id, a.detail, a.acted_at,
           actor.display_name AS actor_name, actor.email AS actor_email,
           subj.display_name AS subject_name, subj.email AS subject_email,
           m.name_bg AS municipality_name_bg, m.name_en AS municipality_name_en,
           b.name AS business_name
    FROM admin_actions a
    LEFT JOIN users actor ON actor.id = a.actor_id
    LEFT JOIN users subj ON subj.id = a.subject_id
    LEFT JOIN municipalities m
      ON m.id = CASE WHEN jsonb_typeof(a.detail -> 'municipalityId') = 'number'
                     THEN (a.detail ->> 'municipalityId')::numeric END
    LEFT JOIN businesses b
      ON b.id = CASE WHEN jsonb_typeof(a.detail -> 'businessId') = 'number'
                     THEN (a.detail ->> 'businessId')::numeric END
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY a.acted_at DESC, a.id DESC
    LIMIT ${limit}
  `);

  return result.rows.map((row) => ({
    id: Number(row.id),
    action: String(row.action) as AdminAction,
    actorId: String(row.actor_id),
    actorName: textOrNull(row.actor_name),
    actorEmail: textOrNull(row.actor_email),
    subjectId: textOrNull(row.subject_id),
    subjectName: textOrNull(row.subject_name),
    subjectEmail: textOrNull(row.subject_email),
    municipalityNameBg: textOrNull(row.municipality_name_bg),
    municipalityNameEn: textOrNull(row.municipality_name_en),
    businessName: textOrNull(row.business_name),
    detail:
      typeof row.detail === 'object' && row.detail !== null
        ? (row.detail as Record<string, unknown>)
        : {},
    actedAt: new Date(String(row.acted_at)).toISOString(),
  }));
}
