import { getDb, sql } from '@sportkarta/db';

import { recordClubAudit } from './audit';

/**
 * The one-click opt-out in mail to an UNLINKED client (List-Unsubscribe and
 * /klubove/otpisvane/<token>). The token is random per record (0040), shaped
 * 32 hex, and grants nothing but this. Opting out is idempotent and keeps its
 * first timestamp; nothing about the person is shown on the page beyond the
 * club's name.
 */

const TOKEN = /^[0-9a-f]{32}$/;

export async function unsubscribeTarget(
  token: string,
  locale: string,
): Promise<{ clubName: string; optedOut: boolean } | null> {
  if (!TOKEN.test(token)) return null;
  const result = await getDb().execute(sql`
    SELECT CASE WHEN ${locale} = 'en' THEN coalesce(c.name_en, c.name_bg) ELSE c.name_bg END AS name,
           (m.email_opt_out_at IS NOT NULL) AS opted_out
      FROM club_members m JOIN clubs c ON c.id = m.club_id
     WHERE m.unsubscribe_token = ${token}
  `);
  const row = result.rows[0];
  return row ? { clubName: String(row.name), optedOut: row.opted_out === true } : null;
}

export async function unsubscribe(token: string): Promise<boolean> {
  if (!TOKEN.test(token)) return false;
  return getDb().transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_members SET email_opt_out_at = coalesce(email_opt_out_at, now())
       WHERE unsubscribe_token = ${token}
       RETURNING id, club_id
    `);
    const row = updated.rows[0];
    if (!row) return false;
    await recordClubAudit(tx, {
      clubId: String(row.club_id),
      by: { kind: 'system' },
      action: 'member_updated',
      subjectMemberId: String(row.id),
      detail: { mailOptOut: true },
    });
    return true;
  });
}
