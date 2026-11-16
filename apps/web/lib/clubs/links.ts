import { getDb, sql, type SQL } from '@sportkarta/db';
import { generateInviteToken, sha256Hex } from '@sportkarta/lib/clubs/secrets';

import { recordClubAudit } from './audit';
import { clubActorMay, clubScope, clubWriteScope, type ClubActor } from './scope';

/**
 * The OPTIONAL link between a club's client record and a POPS account (0040;
 * decision 2026-10-24). Linking is always the PERSON's act: a club can invite
 * an address, and a person can claim a record that carries their VERIFIED
 * address — the desk approves a claim, an accepted invite needs no approval
 * because the club chose the address. «Това не съм аз» declines a match.
 *
 * Children never link: they hang under a guardian record, and the guardian's
 * account sees them in the portal (memberSelfScope).
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export const MEMBER_INVITE_DAYS = 14;

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

export type LinkInviteResult =
  | { ok: true; inviteId: string }
  | {
      ok: false;
      error: 'no_email' | 'already_linked' | 'not_allowed' | 'opted_out' | 'recently_invited';
    };

/** One invitation per record per day: a desk cannot turn «Покани» into a mailer. */
export const MEMBER_INVITE_COOLDOWN_HOURS = 24;

/** The desk invites a record's address; the worker mails the token. */
export async function inviteMemberToLink(
  db: TransactionalDb,
  actor: ClubActor,
  memberId: string,
): Promise<LinkInviteResult> {
  return db.transaction(async (tx) => {
    // Locked, so two quick presses cannot both pass the cooldown below.
    const member = await tx.execute(sql`
      SELECT m.email, m.is_minor, (m.email_opt_out_at IS NOT NULL) AS opted_out,
             EXISTS (SELECT 1 FROM club_member_links l WHERE l.member_id = m.id AND l.status = 'active') AS linked,
             EXISTS (SELECT 1 FROM club_member_invites i
                      WHERE i.club_id = m.club_id AND i.member_id = m.id
                        AND i.created_at > now() - make_interval(hours => ${MEMBER_INVITE_COOLDOWN_HOURS}::int))
               AS recent
        FROM club_members m
       WHERE m.id = ${memberId}::uuid AND ${clubWriteScope(actor, 'members.manage', 'm')}
       FOR NO KEY UPDATE OF m
    `);
    const row = member.rows[0];
    if (!row) return { ok: false, error: 'not_allowed' } as const;
    if (row.linked === true) return { ok: false, error: 'already_linked' } as const;
    const email = text(row.email);
    if (!email || row.is_minor === true) return { ok: false, error: 'no_email' } as const;
    // A one-click opt-out covers invitations too: the address asked for silence.
    if (row.opted_out === true) return { ok: false, error: 'opted_out' } as const;
    if (row.recent === true) return { ok: false, error: 'recently_invited' } as const;
    // A fresh invite replaces any still-open one for this record.
    await tx.execute(sql`
      UPDATE club_member_invites SET revoked_at = now()
       WHERE club_id = ${actor.clubId}::uuid AND member_id = ${memberId}::uuid
         AND accepted_at IS NULL AND revoked_at IS NULL
    `);
    const created = await tx.execute(sql`
      INSERT INTO club_member_invites (club_id, member_id, email, token_hash, expires_at, created_by)
      VALUES (${actor.clubId}::uuid, ${memberId}::uuid, ${email},
              ${sha256Hex(`placeholder:${generateInviteToken()}`)},
              now() + make_interval(days => ${MEMBER_INVITE_DAYS}::int), ${actor.userId})
      RETURNING id
    `);
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'link_invited',
      subjectMemberId: memberId,
    });
    return { ok: true, inviteId: String(created.rows[0]?.id) } as const;
  });
}

export interface MemberInvitePreview {
  clubSlug: string;
  clubName: string;
  memberName: string;
  email: string;
  usable: boolean;
}

/**
 * SQL: the record `m` is still the one the invitation `i` was sent for — not
 * archived, and carrying the invited address NOW. An invitation is the club
 * choosing an address; once the desk corrects that address (a typo that
 * reached a stranger) or archives the record, the token is worth nothing,
 * whether or not it was revoked (updateMember and setMemberArchived do).
 */
const INVITE_RECORD_UNCHANGED = sql`(m.archived_at IS NULL AND m.email = i.email)`;

export async function memberInviteByToken(token: string): Promise<MemberInvitePreview | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const result = await getDb().execute(sql`
    SELECT c.slug, c.name_bg, m.display_name, i.email,
           (i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
            AND c.status = 'active' AND ${INVITE_RECORD_UNCHANGED}) AS usable
      FROM club_member_invites i
      JOIN clubs c ON c.id = i.club_id
      JOIN club_members m ON m.club_id = i.club_id AND m.id = i.member_id
     WHERE i.token_hash = ${sha256Hex(token)}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    clubSlug: String(row.slug),
    clubName: String(row.name_bg),
    memberName: String(row.display_name),
    email: String(row.email),
    usable: row.usable === true,
  };
}

export type AcceptLinkResult =
  { ok: true; slug: string } | { ok: false; error: 'invalid' | 'wrong_account' | 'already_linked' };

export async function acceptMemberInvite(
  db: TransactionalDb,
  userId: string,
  token: string,
): Promise<AcceptLinkResult> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { ok: false, error: 'invalid' };
  return db.transaction(async (tx) => {
    // Only the invitation is locked: the desk correcting the address or
    // archiving the record revokes it (members.ts), which waits on this lock
    // and then finds it accepted — so the two go one after the other.
    const invite = await tx.execute(sql`
      SELECT i.id, i.club_id, i.member_id, c.slug,
             (u.email_verified AND lower(u.email) = i.email) AS matches,
             EXISTS (SELECT 1 FROM club_member_links l
                      WHERE l.club_id = i.club_id AND l.user_id = ${userId}
                        AND l.status <> 'declined' AND l.member_id <> i.member_id) AS other_record
        FROM club_member_invites i
        JOIN clubs c ON c.id = i.club_id
        JOIN club_members m ON m.club_id = i.club_id AND m.id = i.member_id
        JOIN users u ON u.id = ${userId}
       WHERE i.token_hash = ${sha256Hex(token)}
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
         AND c.status = 'active' AND ${INVITE_RECORD_UNCHANGED}
       FOR UPDATE OF i
    `);
    const row = invite.rows[0];
    if (!row) return { ok: false, error: 'invalid' } as const;
    if (row.matches !== true) return { ok: false, error: 'wrong_account' } as const;
    if (row.other_record === true) return { ok: false, error: 'already_linked' } as const;
    const clubId = String(row.club_id);
    const memberId = String(row.member_id);
    // An answered claim (pending, declined) gives way to the invitation; an
    // ACTIVE link of another account never does — the rule is in the upsert
    // itself, so no interleaving can take a portal from the person who holds it.
    const linked = await tx.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
      VALUES (${memberId}::uuid, ${clubId}::uuid, ${userId}, 'active', 'invite')
      ON CONFLICT (member_id) DO UPDATE
         SET user_id = EXCLUDED.user_id, status = 'active', method = 'invite',
             passport_consent_at = CASE WHEN club_member_links.user_id = EXCLUDED.user_id
                                        THEN club_member_links.passport_consent_at END
       WHERE club_member_links.status <> 'active'
          OR club_member_links.user_id = EXCLUDED.user_id
      RETURNING member_id
    `);
    // The record belongs to another account by now: the invitation offers nothing.
    if (linked.rows.length === 0) return { ok: false, error: 'invalid' } as const;
    await tx.execute(
      sql`UPDATE club_member_invites SET accepted_at = now() WHERE id = ${String(row.id)}::uuid`,
    );
    await recordClubAudit(tx, {
      clubId,
      by: { kind: 'member', userId },
      action: 'link_approved',
      subjectMemberId: memberId,
      detail: { method: 'invite' },
    });
    return { ok: true, slug: String(row.slug) } as const;
  });
}

export interface ClaimableRecord {
  memberId: string;
  clubSlug: string;
  clubName: string;
  memberName: string;
}

/**
 * Records in operating clubs that carry this account's VERIFIED address, are
 * not minors, and are not linked or already answered by this person.
 */
export async function claimableRecords(userId: string): Promise<ClaimableRecord[]> {
  const result = await getDb().execute(sql`
    SELECT m.id, c.slug, c.name_bg, m.display_name
      FROM users u
      JOIN club_members m ON m.email = lower(u.email)
      JOIN clubs c ON c.id = m.club_id AND c.status = 'active'
     WHERE u.id = ${userId} AND u.email_verified
       AND NOT m.is_minor AND m.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM club_member_links l WHERE l.member_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM club_member_links l2
                        WHERE l2.club_id = m.club_id AND l2.user_id = u.id AND l2.status <> 'declined')
     ORDER BY c.name_bg
     LIMIT 20
  `);
  return result.rows.map((row) => ({
    memberId: String(row.id),
    clubSlug: String(row.slug),
    clubName: String(row.name_bg),
    memberName: String(row.display_name),
  }));
}

export async function claimRecord(
  db: TransactionalDb,
  userId: string,
  memberId: string,
  decision: 'claim' | 'decline',
): Promise<{ ok: boolean; clubId: string | null }> {
  return db.transaction(async (tx) => {
    const found = await tx.execute(sql`
      SELECT m.club_id FROM club_members m
        JOIN users u ON u.id = ${userId} AND u.email_verified AND m.email = lower(u.email)
        JOIN clubs c ON c.id = m.club_id AND c.status = 'active'
       WHERE m.id = ${memberId}::uuid AND NOT m.is_minor
         AND NOT EXISTS (SELECT 1 FROM club_member_links l WHERE l.member_id = m.id)
         AND (${decision} = 'decline' OR NOT EXISTS (
               SELECT 1 FROM club_member_links l2
                WHERE l2.club_id = m.club_id AND l2.user_id = ${userId} AND l2.status <> 'declined'))
       FOR NO KEY UPDATE OF m
    `);
    const clubId = text(found.rows[0]?.club_id);
    if (!clubId) return { ok: false, clubId: null };
    await tx.execute(sql`
      INSERT INTO club_member_links (member_id, club_id, user_id, status, method)
      VALUES (${memberId}::uuid, ${clubId}::uuid, ${userId},
              ${decision === 'claim' ? 'pending' : 'declined'}, 'claim')
    `);
    await recordClubAudit(tx, {
      clubId,
      by: { kind: 'member', userId },
      action: decision === 'claim' ? 'link_claimed' : 'link_declined',
      subjectMemberId: memberId,
    });
    return { ok: true, clubId };
  });
}

/** The desk answers a claim. A refused claim removes the pending link. */
export async function decideClaim(
  db: TransactionalDb,
  actor: ClubActor,
  memberId: string,
  approve: boolean,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const changed = approve
      ? await tx.execute(sql`
          UPDATE club_member_links l SET status = 'active'
           WHERE l.member_id = ${memberId}::uuid AND l.status = 'pending'
             AND ${clubWriteScope(actor, 'members.manage', 'l')}
           RETURNING l.member_id`)
      : await tx.execute(sql`
          DELETE FROM club_member_links l
           WHERE l.member_id = ${memberId}::uuid AND l.status = 'pending'
             AND ${clubScope(actor, 'members.manage', 'l')}
           RETURNING l.member_id`);
    if (changed.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: approve ? 'link_approved' : 'link_removed',
      subjectMemberId: memberId,
    });
    return true;
  });
}

/**
 * Unlink — the member from the portal, or the desk. One thing goes with the
 * link: the member's «no» to club mail. The switch lives on the link row
 * (`notify_email`), and with the row gone a club that mails clients without
 * an account would write to the record's own address again — so a muted link
 * leaves the record opted out (`email_opt_out_at`, which every mail path
 * reads; the first timestamp is kept). Nothing else changes.
 */
export async function unlinkRecord(
  db: TransactionalDb,
  by: { kind: 'staff'; actor: ClubActor } | { kind: 'member'; userId: string },
  memberId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed =
      by.kind === 'staff'
        ? await tx.execute(sql`
            DELETE FROM club_member_links l
             WHERE l.member_id = ${memberId}::uuid AND ${clubScope(by.actor, 'members.manage', 'l')}
               AND ${clubActorMay(by.actor, 'members.manage', { write: false })}
             RETURNING l.club_id, l.notify_email`)
        : await tx.execute(sql`
            DELETE FROM club_member_links l
             WHERE l.member_id = ${memberId}::uuid AND l.user_id = ${by.userId}
             RETURNING l.club_id, l.notify_email`);
    const clubId = text(removed.rows[0]?.club_id);
    if (!clubId) return false;
    if (removed.rows[0]?.notify_email === false) {
      // The record of the link just removed, in the club it was removed from:
      // the DELETE above is this statement's authority.
      await tx.execute(sql`
        UPDATE club_members m SET email_opt_out_at = coalesce(m.email_opt_out_at, now())
         WHERE m.id = ${memberId}::uuid AND m.club_id = ${clubId}::uuid
      `);
    }
    await recordClubAudit(tx, {
      clubId,
      by:
        by.kind === 'staff'
          ? { kind: 'staff', actor: by.actor }
          : { kind: 'member', userId: by.userId },
      action: 'link_removed',
      subjectMemberId: memberId,
    });
    return true;
  });
}

/**
 * The member's own switches on their link: the passport bridge (consent, a
 * timestamp — the obligation is to demonstrate it) and club mail. Target
 * state, own active link only.
 *
 * Club mail has a second «no» — the record's one-click opt-out
 * (`email_opt_out_at`: the link in a mail, or a muted link that was removed),
 * and mail needs both to agree. Switching club mail ON here is the member's
 * own signed-in yes for this club, so it lifts that opt-out too: without it a
 * member who muted, unlinked and linked again would see the switch on and
 * never get a reminder. The lift is logged, like the opt-out was.
 */
export async function setLinkPreference(
  userId: string,
  memberId: string,
  preference: 'passport' | 'notify' | 'push',
  on: boolean,
): Promise<boolean> {
  const set =
    preference === 'passport'
      ? sql`passport_consent_at = ${on ? sql`coalesce(passport_consent_at, now())` : sql`NULL`}`
      : preference === 'push'
        ? sql`notify_push = ${on}`
        : sql`notify_email = ${on}`;
  return getDb().transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_member_links SET ${set}
       WHERE member_id = ${memberId}::uuid AND user_id = ${userId} AND status = 'active'
       RETURNING member_id, club_id
    `);
    const link = updated.rows[0];
    if (!link) return false;
    if (preference === 'notify' && on) {
      // The record of the caller's OWN active link — the same WHERE as above.
      const lifted = await tx.execute(sql`
        UPDATE club_members m SET email_opt_out_at = NULL
         WHERE m.id = ${memberId}::uuid AND m.email_opt_out_at IS NOT NULL
           AND EXISTS (SELECT 1 FROM club_member_links own
                        WHERE own.member_id = m.id AND own.user_id = ${userId}
                          AND own.status = 'active')
         RETURNING m.id
      `);
      if (lifted.rows.length > 0) {
        await recordClubAudit(tx, {
          clubId: String(link.club_id),
          by: { kind: 'member', userId },
          action: 'member_updated',
          subjectMemberId: memberId,
          detail: { mailOptOut: false },
        });
      }
    }
    return true;
  });
}

/**
 * A linked member asks the club (the controller) to erase their record. POPS
 * cannot do it for the club; it flags the record for the owner and mails them.
 */
export async function requestErasure(
  db: TransactionalDb,
  userId: string,
  memberId: string,
): Promise<{ ok: boolean; clubId: string | null }> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_members m SET erasure_requested_at = coalesce(m.erasure_requested_at, now())
       WHERE m.id = ${memberId}::uuid
         AND EXISTS (SELECT 1 FROM club_member_links l
                      WHERE l.member_id = m.id AND l.user_id = ${userId} AND l.status = 'active')
       RETURNING m.club_id
    `);
    const clubId = text(updated.rows[0]?.club_id);
    if (!clubId) return { ok: false, clubId: null };
    await recordClubAudit(tx, {
      clubId,
      by: { kind: 'member', userId },
      action: 'erasure_requested',
      subjectMemberId: memberId,
    });
    return { ok: true, clubId };
  });
}

/** Pending claims waiting for the desk — the office's to-do. */
export async function pendingClaims(
  actor: ClubActor,
): Promise<{ memberId: string; memberName: string; claimedAt: string }[]> {
  const result = await getDb().execute(sql`
    SELECT l.member_id, m.display_name, l.created_at
      FROM club_member_links l JOIN club_members m ON m.id = l.member_id
     WHERE ${clubScope(actor, 'members.manage', 'l')} AND l.status = 'pending'
     ORDER BY l.created_at
  `);
  return result.rows.map((row) => ({
    memberId: String(row.member_id),
    memberName: String(row.display_name),
    claimedAt: new Date(String(row.created_at)).toISOString(),
  }));
}
