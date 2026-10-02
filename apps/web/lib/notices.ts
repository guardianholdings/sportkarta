import { sql, type SQL } from '@sportkarta/db';
import { isReasonFor } from '@sportkarta/lib/moderation';

import type { NoticeInput } from './notice-input';

/**
 * Notices from the public "report content" form (/signal) — DSA Art. 16's
 * notice-and-action mechanism, migration 0034. The statements live here; what
 * a notice may contain is `lib/notice-input.ts`, which the client form shares.
 *
 * WHO DECIDES. Admins only (`requireRole('admin')` at the action, and the role
 * again INSIDE the UPDATE, read from `users` — never from a session cookie). A
 * notice can concern any page on the site, not a municipality, and answering a
 * claim of illegality is the controller's act, not a volunteer's.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

/** Store a notice. Returns its id. */
export async function insertNotice(db: SqlRunner, notice: NoticeInput): Promise<string> {
  const result = await db.execute(sql`
    INSERT INTO content_notices
      (target_url, category, explanation, notifier_name, notifier_email, good_faith)
    VALUES (${notice.targetUrl}, ${notice.category}::content_notice_category,
            ${notice.explanation}, ${notice.notifierName}, ${notice.notifierEmail}, true)
    RETURNING id
  `);
  return String(result.rows[0]?.id ?? '');
}

export type NoticeDecision = 'actioned' | 'dismissed';

/**
 * Decide a pending notice. `applied` is false when it was already decided, is
 * absent, the reason does not belong to the outcome, or the actor is not an
 * admin — the role is checked in the statement itself, against the database.
 * `notify` says whether the notifier left an address to tell.
 */
export async function decideNotice(
  db: SqlRunner,
  actorId: string,
  noticeId: string,
  decision: NoticeDecision,
  reason: unknown,
): Promise<{ applied: boolean; notify: boolean }> {
  const context = decision === 'actioned' ? 'notice_actioned' : 'notice_dismissed';
  if (!isReasonFor(context, reason)) return { applied: false, notify: false };

  const result = await db.execute(sql`
    UPDATE content_notices
       SET status = ${decision}::content_notice_status,
           decided_at = now(),
           decided_by = ${actorId},
           decision_reason = ${reason}
     WHERE id = ${noticeId}::uuid
       AND status = 'pending'
       AND EXISTS (SELECT 1 FROM users WHERE id = ${actorId} AND role = 'admin')
    RETURNING notifier_email IS NOT NULL AS has_contact
  `);
  const row = result.rows[0];
  if (!row) return { applied: false, notify: false };
  return { applied: true, notify: row.has_contact === true };
}

export interface QueueNotice {
  id: string;
  targetUrl: string;
  category: string;
  explanation: string;
  notifierName: string | null;
  notifierEmail: string | null;
  createdAt: string;
}

/** Pending notices, oldest first — the admin queue. */
export async function pendingNotices(db: SqlRunner, limit = 50): Promise<QueueNotice[]> {
  const result = await db.execute(sql`
    SELECT id, target_url, category, explanation, notifier_name, notifier_email, created_at
      FROM content_notices
     WHERE status = 'pending'
     ORDER BY created_at
     LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    targetUrl: String(row.target_url),
    category: String(row.category),
    explanation: String(row.explanation),
    notifierName: (row.notifier_name as string | null) ?? null,
    notifierEmail: (row.notifier_email as string | null) ?? null,
    createdAt: String(row.created_at),
  }));
}
