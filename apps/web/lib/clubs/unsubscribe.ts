import { getDb, sql } from '@sportkarta/db';

import { recordClubAudit } from './audit';

/**
 * The one-click opt-out in mail to an UNLINKED client (List-Unsubscribe and
 * /klubove/otpisvane/<token>), and — since 0051 — the way out of a club's
 * offers that every marketing message carries, linked member or not. The token is random per record (0040), shaped
 * 32 hex, and grants nothing but this. Opting out is idempotent and keeps its
 * first timestamp; nothing about the person is shown on the page beyond the
 * club's name.
 */

const TOKEN = /^[0-9a-f]{32}$/;

/**
 * What the person is saying no to (0051): every club mail (an unlinked
 * client, the original opt-out), the club's OFFERS by e-mail and SMS (the
 * link every marketing message carries), or SMS altogether (the short link in
 * a marketing SMS). Consent timestamps are cleared, opt-out timestamps keep
 * their first value — what a regulator asks for is when.
 */
export const UNSUBSCRIBE_SCOPES = ['all', 'marketing', 'sms'] as const;
export type UnsubscribeScope = (typeof UNSUBSCRIBE_SCOPES)[number];

export function unsubscribeScope(value: unknown): UnsubscribeScope {
  return value === 'marketing' || value === 'sms' ? value : 'all';
}

const OPTED_OUT: Record<UnsubscribeScope, ReturnType<typeof sql>> = {
  all: sql`(m.email_opt_out_at IS NOT NULL)`,
  marketing: sql`(m.marketing_email_at IS NULL AND m.marketing_sms_at IS NULL)`,
  sms: sql`(m.sms_opt_out_at IS NOT NULL)`,
};

const SET: Record<UnsubscribeScope, ReturnType<typeof sql>> = {
  all: sql`email_opt_out_at = coalesce(email_opt_out_at, now())`,
  marketing: sql`marketing_email_at = NULL, marketing_sms_at = NULL`,
  sms: sql`sms_opt_out_at = coalesce(sms_opt_out_at, now()), marketing_sms_at = NULL`,
};

export async function unsubscribeTarget(
  token: string,
  locale: string,
  scope: UnsubscribeScope = 'all',
): Promise<{ clubName: string; optedOut: boolean } | null> {
  if (!TOKEN.test(token)) return null;
  const result = await getDb().execute(sql`
    SELECT CASE WHEN ${locale} = 'en' THEN coalesce(c.name_en, c.name_bg) ELSE c.name_bg END AS name,
           ${OPTED_OUT[scope]} AS opted_out
      FROM club_members m JOIN clubs c ON c.id = m.club_id
     WHERE m.unsubscribe_token = ${token}
  `);
  const row = result.rows[0];
  return row ? { clubName: String(row.name), optedOut: row.opted_out === true } : null;
}

export async function unsubscribe(
  token: string,
  scope: UnsubscribeScope = 'all',
): Promise<boolean> {
  if (!TOKEN.test(token)) return false;
  return getDb().transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_members SET ${SET[scope]}
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
      detail:
        scope === 'all'
          ? { mailOptOut: true }
          : scope === 'marketing'
            ? { marketingOptOut: true }
            : { smsOptOut: true },
    });
    return true;
  });
}
