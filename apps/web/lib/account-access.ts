import 'server-only';

import { getDb, sql } from '@sportkarta/db';

/**
 * The accountability trail for /admin/akaunti (migration 0028).
 *
 * The admin account screen can show everything the platform records about one
 * person, including — behind the two consents on `users` — their stored GPS
 * routes and their heart rate, which is GDPR Art. 9 special-category data. That
 * capability is legitimate for a data controller and indefensible without a
 * record of its use: "who looked at whom, and when" is the question that
 * separates administration from surveillance.
 *
 * This module is the ONLY writer. The table is append-only by trigger, so there
 * is no update or delete path to write here even if someone wanted one.
 */

/**
 * Recorded per scope rather than as a single "viewed" event, because the
 * interesting question is not whether an admin opened an account — they do that
 * to answer support mail — but whether anyone opened the health panel, which
 * nothing in the product needs.
 */
export type AccountAccessScope = 'overview' | 'training' | 'health' | 'export';

/**
 * Record that `actorId` opened `scope` on `subjectId`.
 *
 * FAILS CLOSED, deliberately: this throws rather than swallowing a database
 * error, and every caller awaits it BEFORE rendering the data it describes. A
 * log that silently stops recording is worse than no log, because the absence of
 * rows would then read as "nobody looked". If the log is broken the panel does
 * not render — that is the correct trade for an accountability record, and it is
 * the reason there is no try/catch here.
 *
 * Self-access is recorded like any other. An admin reading their own account is
 * not a risk, but an exemption is a branch, and a branch in an audit path is a
 * place for a future hole to hide.
 */
export async function recordAccountAccess(
  actorId: string,
  subjectId: string,
  scope: AccountAccessScope,
): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO account_access_log (actor_id, subject_id, scope)
    VALUES (${actorId}, ${subjectId}, ${scope})
  `);
}

export interface AccountAccessEntry {
  /** The admin's account id, and their address/name IF the account still exists. */
  actorId: string;
  actorEmail: string | null;
  actorDisplayName: string | null;
  scope: AccountAccessScope;
  viewedAt: string;
}

/**
 * Who has read this person's data.
 *
 * Rendered on the subject's own admin screen, so an admin answering "has anyone
 * looked at me?" — the question a member is entitled to ask — can answer it from
 * the same page rather than from the database.
 *
 * The join is LEFT: `actor_id` carries no foreign key (see the migration header),
 * so an admin who has since erased their own account resolves to NULL here and
 * renders as the "former user" label, exactly like `facility_edits.actor`.
 */
export async function accountAccessHistory(
  subjectId: string,
  limit = 50,
): Promise<AccountAccessEntry[]> {
  const result = await getDb().execute(sql`
    SELECT l.actor_id, l.scope, l.viewed_at, u.email, u.display_name
    FROM account_access_log l
    LEFT JOIN users u ON u.id = l.actor_id
    WHERE l.subject_id = ${subjectId}
    ORDER BY l.viewed_at DESC
    LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    actorId: String(row.actor_id),
    actorEmail: row.email === null || row.email === undefined ? null : String(row.email),
    actorDisplayName:
      row.display_name === null || row.display_name === undefined
        ? null
        : String(row.display_name),
    scope: String(row.scope) as AccountAccessScope,
    viewedAt: new Date(String(row.viewed_at)).toISOString(),
  }));
}
