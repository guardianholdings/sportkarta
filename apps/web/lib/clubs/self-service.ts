import { sql, type SQL } from '@sportkarta/db';
import {
  contractEndsOn,
  selfPauseRange,
  type IsoDate,
  type PauseRequest,
} from '@sportkarta/lib/clubs';

import { clubWritableGuard } from './access';
import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import type { ContactPreferencesInput } from './input';
import { memberSelfScope } from './scope';

/**
 * What a member may change THEMSELVES in their club portal (0045), each only
 * when the club's plan allows it and only for a record memberSelfScope admits
 * (their own, or a child's under it) — in the statement, so a forged id
 * changes nothing:
 *
 *   - stop the renewal of a renewing abonnement, with the plan's notice and
 *     minimum term (lib/src/clubs/policies.ts contractEndsOn) — never shorter
 *     than a period already sold;
 *   - pause a membership once, for up to SELF_PAUSE_MAX_DAYS days, from today
 *     or later (0041's trigger still decides it lies inside the validity);
 *   - their phone and their marketing consents. A consent is a TIMESTAMP:
 *     ticking it again keeps the original moment; unticking clears it. Giving
 *     an SMS consent also lifts an earlier SMS opt-out.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export type SelfServiceResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; error: string };

/** The tail of the renewing chain `membershipId` belongs to. */
const CHAIN_TAIL = (membershipId: string) => sql`
  WITH RECURSIVE chain AS (
    SELECT id FROM club_memberships WHERE id = ${membershipId}::uuid
    UNION ALL
    SELECT nx.id FROM club_memberships nx JOIN chain ON nx.renewal_of = chain.id
  )
  SELECT c.id FROM chain c
   WHERE NOT EXISTS (SELECT 1 FROM club_memberships nx WHERE nx.renewal_of = c.id)
   LIMIT 1`;

export async function memberStopRenewal(
  db: TransactionalDb,
  userId: string,
  clubId: string,
  membershipId: string,
  today: IsoDate,
): Promise<SelfServiceResult<{ endsOn: IsoDate }>> {
  return db.transaction(async (tx) => {
    const found = await tx.execute(sql`
      SELECT ms.id, ms.member_id, p.notice_days, p.min_term_months,
             to_char(coalesce(ms.term_started_on, ms.starts_on), 'YYYY-MM-DD') AS term_started_on
        FROM club_memberships ms
        JOIN club_plans p ON p.club_id = ms.club_id AND p.id = ms.plan_id
        JOIN club_members m ON m.club_id = ms.club_id AND m.id = ms.member_id
       WHERE ms.id = (${CHAIN_TAIL(membershipId)})
         AND ms.renews AND ms.renewal_ends_on IS NULL AND ms.cancelled_at IS NULL
         AND p.self_cancel_allowed
         AND ${memberSelfScope(userId, clubId, 'm')} AND ${clubWritableGuard(clubId)}
         FOR NO KEY UPDATE OF ms
    `);
    const row = found.rows[0];
    if (!row) return { ok: false, error: 'not_allowed' } as const;
    const endsOn = contractEndsOn(today, {
      noticeDays: Number(row.notice_days),
      minTermMonths: row.min_term_months === null ? null : Number(row.min_term_months),
      termStartedOn: String(row.term_started_on),
    });
    await tx.execute(sql`
      UPDATE club_memberships ms SET renewal_ends_on = ${endsOn}::date
        FROM club_members m
       WHERE ms.id = ${String(row.id)}::uuid AND m.club_id = ms.club_id AND m.id = ms.member_id
         AND ${memberSelfScope(userId, clubId, 'm')}
    `);
    await recordClubAudit(tx, {
      clubId,
      by: { kind: 'member', userId },
      action: 'renewal_stopped',
      subjectMemberId: String(row.member_id),
      detail: { membershipId: String(row.id), endsOn },
    });
    return { ok: true, endsOn } as const;
  });
}

export async function memberPause(
  db: TransactionalDb,
  userId: string,
  clubId: string,
  membershipId: string,
  request: PauseRequest,
  today: IsoDate,
): Promise<SelfServiceResult> {
  const range = selfPauseRange(request, today);
  if (!range) return { ok: false, error: 'pause_invalid' };
  try {
    return await db.transaction(async (tx) => {
      const created = await tx.execute(sql`
        INSERT INTO club_membership_pauses (club_id, membership_id, starts_on, ends_on, created_by)
        SELECT ms.club_id, ms.id, ${range.startsOn}::date, ${range.endsOn}::date, ${userId}
          FROM club_memberships ms
          JOIN club_plans p ON p.club_id = ms.club_id AND p.id = ms.plan_id
          JOIN club_members m ON m.club_id = ms.club_id AND m.id = ms.member_id
         WHERE ms.id = ${membershipId}::uuid AND ms.cancelled_at IS NULL AND p.self_pause_allowed
           AND NOT EXISTS (SELECT 1 FROM club_membership_pauses ps
                            WHERE ps.membership_id = ms.id AND ps.created_by = ${userId})
           AND ${memberSelfScope(userId, clubId, 'm')} AND ${clubWritableGuard(clubId)}
        RETURNING (SELECT member_id FROM club_memberships WHERE id = membership_id) AS member_id
      `);
      const memberId = text(created.rows[0]?.member_id);
      if (!memberId) return { ok: false, error: 'not_allowed' } as const;
      await recordClubAudit(tx, {
        clubId,
        by: { kind: 'member', userId },
        action: 'membership_paused',
        subjectMemberId: memberId,
        detail: { membershipId, from: range.startsOn, to: range.endsOn },
      });
      return { ok: true } as const;
    });
  } catch (error: unknown) {
    const constraint = violatedConstraint(error);
    if (constraint === 'club_membership_pauses_no_overlap')
      return { ok: false, error: 'pause_overlap' };
    if (constraint === 'club_membership_pauses_within_membership') {
      return { ok: false, error: 'pause_outside' };
    }
    throw error;
  }
}

export interface OwnContact {
  memberId: string;
  phone: string | null;
  marketingEmail: boolean;
  marketingSms: boolean;
}

/**
 * The account's OWN record's contact preferences — the record linked to this
 * account directly, never a child's (portalView reads no contact column at
 * all; tests/club-projections.test.ts).
 */
export async function ownContact(
  db: SqlRunner,
  userId: string,
  clubId: string,
): Promise<OwnContact | null> {
  const result = await db.execute(sql`
    SELECT m.id, m.phone, (m.marketing_email_at IS NOT NULL) AS marketing_email,
           (m.marketing_sms_at IS NOT NULL) AS marketing_sms
      FROM club_member_links ml
      JOIN club_members m ON m.club_id = ml.club_id AND m.id = ml.member_id
     WHERE ml.club_id = ${clubId}::uuid AND ml.user_id = ${userId} AND ml.status = 'active'
       AND m.archived_at IS NULL
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    memberId: String(row.id),
    phone: text(row.phone),
    marketingEmail: row.marketing_email === true,
    marketingSms: row.marketing_sms === true,
  };
}

export async function setContactPreferences(
  db: TransactionalDb,
  userId: string,
  clubId: string,
  memberId: string,
  input: ContactPreferencesInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_members m
         SET phone = ${input.phone},
             marketing_email_at = CASE WHEN ${input.marketingEmail}
                                       THEN coalesce(m.marketing_email_at, now()) END,
             marketing_sms_at = CASE WHEN ${input.marketingSms}
                                     THEN coalesce(m.marketing_sms_at, now()) END,
             sms_opt_out_at = CASE WHEN ${input.marketingSms} THEN NULL ELSE m.sms_opt_out_at END
       WHERE m.id = ${memberId}::uuid AND m.archived_at IS NULL
         AND ${memberSelfScope(userId, clubId, 'm')} AND ${clubWritableGuard(clubId)}
      RETURNING m.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId,
      by: { kind: 'member', userId },
      action: 'preferences_changed',
      subjectMemberId: memberId,
      detail: {
        phone: input.phone !== null,
        marketingEmail: input.marketingEmail,
        marketingSms: input.marketingSms,
      },
    });
    return true;
  });
}
