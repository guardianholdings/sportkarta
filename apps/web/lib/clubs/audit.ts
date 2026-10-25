import { getDb, sql, type SQL } from '@sportkarta/db';
import type { ClubAuditAction } from '@sportkarta/lib/clubs';

import type { ClubActor } from './scope';

/**
 * The only writer (and the only reader) of `club_audit` (0039) — the club's
 * own accountability log, shown to its owner and managers.
 *
 * Same discipline as apps/web/lib/admin-actions.ts: written IN THE SAME
 * TRANSACTION as the change, and `detail` is a small object of ids, counts,
 * dates and closed values. There is no variant that carries a name, an email,
 * a phone, a note or an amount typed by a person — the table is append-only,
 * so anything written here would outlive the client's erasure.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

export type ClubAuditDetail = Record<string, string | number | boolean | null>;

export type ClubAuditActor =
  | { kind: 'staff'; actor: ClubActor }
  | { kind: 'member'; userId: string }
  | { kind: 'system' }
  | { kind: 'kiosk' };

export interface ClubAuditEntryInput {
  clubId: string;
  by: ClubAuditActor;
  action: ClubAuditAction;
  subjectMemberId?: string | null;
  detail?: ClubAuditDetail;
}

function actorColumns(by: ClubAuditActor): { id: string | null; kind: string } {
  switch (by.kind) {
    case 'staff':
      // An NGO admin acting without a staff role is recorded as such.
      return {
        id: by.actor.userId,
        kind: by.actor.role === null && by.actor.ngoAdmin ? 'ngo_admin' : 'staff',
      };
    case 'member':
      return { id: by.userId, kind: 'member' };
    case 'system':
      return { id: null, kind: 'system' };
    case 'kiosk':
      return { id: null, kind: 'kiosk' };
  }
}

export async function recordClubAudit(db: SqlRunner, entry: ClubAuditEntryInput): Promise<void> {
  const actor = actorColumns(entry.by);
  await db.execute(sql`
    INSERT INTO club_audit (club_id, actor_id, actor_kind, action, subject_member_id, detail)
    VALUES (${entry.clubId}::uuid, ${actor.id}, ${actor.kind}, ${entry.action},
            ${entry.subjectMemberId ?? null}::uuid, ${JSON.stringify(entry.detail ?? {})}::jsonb)
  `);
}

export interface ClubAuditEntry {
  id: number;
  action: ClubAuditAction;
  actorKind: string;
  /** The actor's display name, while their account exists. */
  actorName: string | null;
  subjectMemberId: string | null;
  /** The client's name, while the record exists (erased → null). */
  subjectName: string | null;
  detail: Record<string, unknown>;
  actedAt: string;
}

/**
 * The log, newest first. The caller has already passed requireClubStaff with
 * 'audit.view'; the club filter here is the statement's own scope. Names
 * resolve through LEFT JOINs: an erased account or record reads as the
 * "former" label and the row survives.
 */
export async function clubAuditHistory(
  clubId: string,
  filter: { subjectMemberId?: string } = {},
  limit = 50,
): Promise<ClubAuditEntry[]> {
  const subject = filter.subjectMemberId
    ? sql`AND a.subject_member_id = ${filter.subjectMemberId}::uuid`
    : sql``;
  const result = await getDb().execute(sql`
    SELECT a.id, a.action, a.actor_kind, a.subject_member_id, a.detail, a.acted_at,
           coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(u.display_name), ''), split_part(u.email, '@', 1)) AS actor_name,
           m.display_name AS subject_name
      FROM club_audit a
      LEFT JOIN users u ON u.id = a.actor_id
      LEFT JOIN club_staff st ON st.club_id = a.club_id AND st.user_id = a.actor_id
      LEFT JOIN club_members m ON m.club_id = a.club_id AND m.id = a.subject_member_id
     WHERE a.club_id = ${clubId}::uuid ${subject}
     ORDER BY a.acted_at DESC, a.id DESC
     LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    action: String(row.action) as ClubAuditAction,
    actorKind: String(row.actor_kind),
    actorName: row.actor_name === null ? null : String(row.actor_name),
    subjectMemberId: row.subject_member_id === null ? null : String(row.subject_member_id),
    subjectName: row.subject_name === null ? null : String(row.subject_name),
    detail:
      typeof row.detail === 'object' && row.detail !== null
        ? (row.detail as Record<string, unknown>)
        : {},
    actedAt: new Date(String(row.acted_at)).toISOString(),
  }));
}
