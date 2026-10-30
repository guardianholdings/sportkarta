import { getDb, sql, type SQL } from '@sportkarta/db';
import { grantableRoles, type ClubRole } from '@sportkarta/lib/clubs';
import { generateInviteToken, sha256Hex } from '@sportkarta/lib/clubs/secrets';

import { recordClubAudit } from './audit';
import { violatedConstraint } from './errors';
import { clubFeatureSql } from './features';
import type { PayRateInput, StaffInviteInput, StaffProfileInput, TimeOffInput } from './input';
import { clubActorMay, clubScope, clubWriteScope, type ClubActor } from './scope';

/**
 * The club's team. Staff are POPS accounts with a role at the club
 * (club_staff); they join by accepting an emailed invite while signed in with
 * the invited, verified address.
 *
 * INVITE TOKENS: the invite row is created with an unusable placeholder hash
 * and the WORKER mints the real token at send time (lib/src/clubs/jobs.ts) —
 * the only copy of the credential is the email.
 *
 * THE LAST OWNER. There is no last-owner trigger (0039: it would make erasure
 * blockable). The application refuses to demote or remove the last owner
 * instead, inside the same statement, so two managers racing cannot both
 * succeed.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export const STAFF_INVITE_DAYS = 14;

export interface StaffMember {
  userId: string;
  name: string;
  email: string;
  role: ClubRole;
  displayName: string | null;
  bio: string | null;
  publicProfile: boolean;
  /** Pay terms — report data only (0039); null unless the reader may manage staff. */
  pay: { kind: string; cents: number | null; shareBp: number | null } | null;
  since: string;
}

export interface PendingStaffInvite {
  id: string;
  email: string;
  role: ClubRole;
  expiresAt: string;
}

export async function clubTeam(
  actor: ClubActor,
  managesPay = false,
): Promise<{ staff: StaffMember[]; invites: PendingStaffInvite[] }> {
  const db = getDb();
  const [staff, invites] = await Promise.all([
    db.execute(sql`
      SELECT s.user_id, u.display_name AS account_name, u.email, s.role, s.display_name,
             s.bio, s.public_profile, s.pay_rate_kind, s.pay_rate_cents, s.pay_share_bp,
             s.created_at
        FROM club_staff s JOIN users u ON u.id = s.user_id
       WHERE ${clubScope(actor, 'staff.view', 's')}
       ORDER BY array_position(ARRAY['owner','manager','trainer','desk'], s.role), s.created_at
    `),
    db.execute(sql`
      SELECT si.id, si.email, si.role, si.expires_at
        FROM club_staff_invites si
       WHERE ${clubScope(actor, 'staff.manage', 'si')}
         AND si.accepted_at IS NULL AND si.revoked_at IS NULL AND si.expires_at > now()
       ORDER BY si.created_at DESC
    `),
  ]);
  return {
    staff: staff.rows.map((row) => ({
      userId: String(row.user_id),
      name: String(row.account_name ?? ''),
      email: String(row.email),
      role: String(row.role) as ClubRole,
      displayName: row.display_name === null ? null : String(row.display_name),
      bio: row.bio === null ? null : String(row.bio),
      publicProfile: row.public_profile === true,
      pay: managesPay
        ? {
            kind: String(row.pay_rate_kind),
            cents: row.pay_rate_cents === null ? null : Number(row.pay_rate_cents),
            shareBp: row.pay_share_bp === null ? null : Number(row.pay_share_bp),
          }
        : null,
      since: new Date(String(row.created_at)).toISOString(),
    })),
    invites: invites.rows.map((row) => ({
      id: String(row.id),
      email: String(row.email),
      role: String(row.role) as ClubRole,
      expiresAt: new Date(String(row.expires_at)).toISOString(),
    })),
  };
}

/** Trainers for the class editor's select (display name, else account name). */
export async function clubInstructors(
  actor: ClubActor,
): Promise<{ userId: string; name: string }[]> {
  const result = await getDb().execute(sql`
    SELECT s.user_id, coalesce(nullif(btrim(s.display_name), ''), nullif(btrim(u.display_name), ''), split_part(u.email, '@', 1)) AS name
      FROM club_staff s JOIN users u ON u.id = s.user_id
     WHERE ${clubScope(actor, 'schedule.view', 's')}
     ORDER BY name
  `);
  return result.rows.map((row) => ({ userId: String(row.user_id), name: String(row.name) }));
}

export type StaffInviteResult =
  | { ok: true; inviteId: string }
  | {
      ok: false;
      error: 'role_not_grantable' | 'already_staff' | 'already_invited' | 'not_allowed';
    };

export async function inviteStaff(
  db: TransactionalDb,
  actor: ClubActor,
  input: StaffInviteInput,
): Promise<StaffInviteResult> {
  const granter: ClubRole = actor.role ?? 'owner';
  if (!actor.ngoAdmin && !grantableRoles(granter).includes(input.role)) {
    return { ok: false, error: 'role_not_grantable' };
  }
  const permission = input.role === 'owner' ? 'staff.manage_owners' : 'staff.manage';
  return db.transaction(async (tx) => {
    const existing = await tx.execute(sql`
      SELECT 1 FROM club_staff s JOIN users u ON u.id = s.user_id
       WHERE s.club_id = ${actor.clubId}::uuid AND lower(u.email) = ${input.email}
    `);
    if (existing.rows.length > 0) return { ok: false, error: 'already_staff' } as const;
    // One live invitation per address: a second click sends no second mail.
    const pending = await tx.execute(sql`
      SELECT 1 FROM club_staff_invites i
       WHERE i.club_id = ${actor.clubId}::uuid AND lower(i.email) = ${input.email}
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    `);
    if (pending.rows.length > 0) return { ok: false, error: 'already_invited' } as const;
    const created = await tx.execute(sql`
      INSERT INTO club_staff_invites (club_id, email, role, token_hash, expires_at, created_by)
      SELECT ${actor.clubId}::uuid, ${input.email}, ${input.role},
             ${sha256Hex(`placeholder:${generateInviteToken()}`)},
             now() + make_interval(days => ${STAFF_INVITE_DAYS}::int), ${actor.userId}
       WHERE ${clubActorMay(actor, permission, { write: true })}
      RETURNING id
    `);
    const inviteId = created.rows[0]?.id;
    if (!inviteId) return { ok: false, error: 'not_allowed' } as const;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'staff_invited',
      detail: { role: input.role },
    });
    return { ok: true, inviteId: String(inviteId) } as const;
  });
}

export async function revokeStaffInvite(
  db: TransactionalDb,
  actor: ClubActor,
  inviteId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_staff_invites si SET revoked_at = now()
       WHERE si.id = ${inviteId}::uuid AND si.accepted_at IS NULL AND si.revoked_at IS NULL
         AND ${clubScope(actor, 'staff.manage', 'si')}
       RETURNING si.id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'staff_invite_revoked',
    });
    return true;
  });
}

export interface StaffInvitePreview {
  inviteId: string;
  clubId: string;
  clubSlug: string;
  clubName: string;
  role: ClubRole;
  email: string;
  usable: boolean;
}

export async function staffInviteByToken(token: string): Promise<StaffInvitePreview | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const result = await getDb().execute(sql`
    SELECT si.id, si.club_id, si.role, si.email, c.slug, c.name_bg,
           (si.accepted_at IS NULL AND si.revoked_at IS NULL AND si.expires_at > now()
            AND c.status IN ('pending', 'active')) AS usable
      FROM club_staff_invites si JOIN clubs c ON c.id = si.club_id
     WHERE si.token_hash = ${sha256Hex(token)}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    inviteId: String(row.id),
    clubId: String(row.club_id),
    clubSlug: String(row.slug),
    clubName: String(row.name_bg),
    role: String(row.role) as ClubRole,
    email: String(row.email),
    usable: row.usable === true,
  };
}

export type AcceptStaffResult =
  { ok: true; slug: string } | { ok: false; error: 'invalid' | 'wrong_account' };

/**
 * Accept while signed in. The invite names an ADDRESS; the account must own
 * it, verified — otherwise a forwarded link would let anybody join a club's
 * office. Re-accepting is harmless: an existing grant takes the invited role.
 */
export async function acceptStaffInvite(
  db: TransactionalDb,
  userId: string,
  token: string,
): Promise<AcceptStaffResult> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { ok: false, error: 'invalid' };
  return db.transaction(async (tx) => {
    const invite = await tx.execute(sql`
      SELECT si.id, si.club_id, si.role, si.email, c.slug,
             (u.email_verified AND lower(u.email) = si.email) AS matches
        FROM club_staff_invites si
        JOIN clubs c ON c.id = si.club_id
        JOIN users u ON u.id = ${userId}
       WHERE si.token_hash = ${sha256Hex(token)}
         AND si.accepted_at IS NULL AND si.revoked_at IS NULL AND si.expires_at > now()
         AND c.status IN ('pending', 'active')
       FOR UPDATE OF si
    `);
    const row = invite.rows[0];
    if (!row) return { ok: false, error: 'invalid' } as const;
    if (row.matches !== true) return { ok: false, error: 'wrong_account' } as const;
    const clubId = String(row.club_id);
    await tx.execute(sql`
      INSERT INTO club_staff (club_id, user_id, role)
      VALUES (${clubId}::uuid, ${userId}, ${String(row.role)})
      ON CONFLICT (club_id, user_id) DO UPDATE SET role = EXCLUDED.role
       -- An owner is never demoted by accepting an older invitation.
       WHERE club_staff.role <> 'owner'
    `);
    await tx.execute(
      sql`UPDATE club_staff_invites SET accepted_at = now() WHERE id = ${String(row.id)}::uuid`,
    );
    await recordClubAudit(tx, {
      clubId,
      by: {
        kind: 'staff',
        actor: { userId, clubId, role: String(row.role) as ClubRole, ngoAdmin: false },
      },
      action: 'staff_joined',
      detail: { role: String(row.role) },
    });
    return { ok: true, slug: String(row.slug) } as const;
  });
}

/**
 * Lock every owner row of the club, in one order, BEFORE the last-owner
 * check: two co-owners leaving or demoting each other at the same instant
 * would otherwise each see the other still standing and both succeed. The
 * second transaction waits here, then its check runs on a fresh snapshot.
 */
async function lockOwners(tx: SqlRunner, clubId: string): Promise<void> {
  await tx.execute(sql`
    SELECT user_id FROM club_staff
     WHERE club_id = ${clubId}::uuid AND role = 'owner'
     ORDER BY user_id
     FOR UPDATE
  `);
}

const OTHER_OWNER_REMAINS = (clubId: string, userId: string) => sql`EXISTS (
  SELECT 1 FROM club_staff o
   WHERE o.club_id = ${clubId}::uuid AND o.role = 'owner' AND o.user_id <> ${userId})`;

export type StaffChangeResult =
  { ok: true } | { ok: false; error: 'last_owner' | 'not_allowed' | 'not_found' };

export async function changeStaffRole(
  db: TransactionalDb,
  actor: ClubActor,
  userId: string,
  role: ClubRole,
): Promise<StaffChangeResult> {
  return db.transaction(async (tx) => {
    await lockOwners(tx, actor.clubId);
    const current = await tx.execute(sql`
      SELECT role FROM club_staff WHERE club_id = ${actor.clubId}::uuid AND user_id = ${userId}
       FOR UPDATE
    `);
    const was = current.rows[0]?.role;
    if (!was) return { ok: false, error: 'not_found' } as const;
    if (was === role) return { ok: true } as const;
    // Touching an owner, in either direction, is an owner's act.
    const permission = was === 'owner' || role === 'owner' ? 'staff.manage_owners' : 'staff.manage';
    const updated = await tx.execute(sql`
      UPDATE club_staff s SET role = ${role}
       WHERE s.club_id = ${actor.clubId}::uuid AND s.user_id = ${userId}
         AND ${clubActorMay(actor, permission, { write: true })}
         AND (s.role <> 'owner' OR ${OTHER_OWNER_REMAINS(actor.clubId, userId)})
       RETURNING s.user_id
    `);
    if (updated.rows.length === 0) {
      return { ok: false, error: was === 'owner' ? 'last_owner' : 'not_allowed' } as const;
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'staff_role_changed',
      detail: { from: String(was), to: role },
    });
    return { ok: true } as const;
  });
}

export async function removeStaff(
  db: TransactionalDb,
  actor: ClubActor,
  userId: string,
): Promise<StaffChangeResult> {
  return db.transaction(async (tx) => {
    await lockOwners(tx, actor.clubId);
    const current = await tx.execute(sql`
      SELECT role FROM club_staff WHERE club_id = ${actor.clubId}::uuid AND user_id = ${userId}
       FOR UPDATE
    `);
    const was = current.rows[0]?.role;
    if (!was) return { ok: false, error: 'not_found' } as const;
    const permission = was === 'owner' ? 'staff.manage_owners' : 'staff.manage';
    // Anyone may leave a team themselves (except as the last owner).
    const allowed =
      userId === actor.userId ? sql`TRUE` : clubActorMay(actor, permission, { write: true });
    const deleted = await tx.execute(sql`
      DELETE FROM club_staff s
       WHERE s.club_id = ${actor.clubId}::uuid AND s.user_id = ${userId}
         AND ${allowed}
         AND (s.role <> 'owner' OR ${OTHER_OWNER_REMAINS(actor.clubId, userId)})
       RETURNING s.user_id
    `);
    if (deleted.rows.length === 0) {
      return { ok: false, error: was === 'owner' ? 'last_owner' : 'not_allowed' } as const;
    }
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'staff_removed',
      detail: { role: String(was) },
    });
    return { ok: true } as const;
  });
}

/** The clubs a person works at — the /klub hub. */
export async function clubsForStaff(
  userId: string,
): Promise<
  { slug: string; nameBg: string; nameEn: string | null; role: ClubRole; status: string }[]
> {
  const result = await getDb().execute(sql`
    SELECT c.slug, c.name_bg, c.name_en, s.role, c.status
      FROM club_staff s JOIN clubs c ON c.id = s.club_id
     WHERE s.user_id = ${userId} AND c.status <> 'archived'
     ORDER BY c.name_bg
  `);
  return result.rows.map((row) => ({
    slug: String(row.slug),
    nameBg: String(row.name_bg),
    nameEn: row.name_en === null ? null : String(row.name_en),
    role: String(row.role) as ClubRole,
    status: String(row.status),
  }));
}

// ─── Profile, pay terms, time off (0045) ────────────────────────────────────

/**
 * A member of staff's OWN public profile: the name and bio the club page shows
 * and the opt-in to show them at all. Only the person may switch it on — a
 * trainer appears on a public page by their own choice, never the owner's.
 */
export async function updateOwnProfile(
  db: TransactionalDb,
  actor: ClubActor,
  input: StaffProfileInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE club_staff s
         SET display_name = ${input.displayName}, bio = ${input.bio},
             public_profile = ${input.publicProfile}
       WHERE s.user_id = ${actor.userId} AND ${clubWriteScope(actor, 'office.view', 's')}
      RETURNING s.user_id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'staff_profile_changed',
      detail: { publicProfile: input.publicProfile },
    });
    return true;
  });
}

/**
 * Pay terms for one member of staff: report data only, no payroll (0039).
 * Touching an owner's terms, or one's OWN, is an owner's act
 * (staff.manage_owners) — a manager cannot set their own share.
 */
export async function setPayRate(
  db: TransactionalDb,
  actor: ClubActor,
  userId: string,
  input: PayRateInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const cents = input.kind === 'flat' || input.kind === 'per_head' ? input.cents : null;
    const shareBp = input.kind === 'share' ? input.shareBp : null;
    const updated = await tx.execute(sql`
      UPDATE club_staff s
         SET pay_rate_kind = ${input.kind}, pay_rate_cents = ${cents}, pay_share_bp = ${shareBp}
       WHERE s.user_id = ${userId}
         AND ${
           userId === actor.userId
             ? clubWriteScope(actor, 'staff.manage_owners', 's')
             : sql`(CASE WHEN s.role = 'owner'
                         THEN ${clubWriteScope(actor, 'staff.manage_owners', 's')}
                         ELSE ${clubWriteScope(actor, 'staff.manage', 's')} END)`
         }
         AND ${clubFeatureSql(actor.clubId, 'staff_pay')}
      RETURNING s.user_id
    `);
    if (updated.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'staff_profile_changed',
      detail: { pay: input.kind },
    });
    return true;
  });
}

export interface TimeOffEntry {
  id: string;
  userId: string;
  name: string;
  startsOn: string;
  endsOn: string;
  reason: string;
}

/** Leave from yesterday onwards, everyone's — staff plan around each other. */
export async function upcomingTimeOff(actor: ClubActor): Promise<TimeOffEntry[]> {
  const result = await getDb().execute(sql`
    SELECT b.id, b.staff_user_id, b.reason,
           coalesce(nullif(btrim(st.display_name), ''), nullif(btrim(u.display_name), ''),
                    split_part(u.email, '@', 1)) AS name,
           to_char((b.starts_at AT TIME ZONE 'Europe/Sofia')::date, 'YYYY-MM-DD') AS starts_on,
           to_char(((b.ends_at AT TIME ZONE 'Europe/Sofia') - interval '1 second')::date,
                   'YYYY-MM-DD') AS ends_on
      FROM club_time_blocks b
      JOIN club_staff st ON st.club_id = b.club_id AND st.user_id = b.staff_user_id
      JOIN users u ON u.id = b.staff_user_id
     WHERE ${clubScope(actor, 'staff.view', 'b')} AND b.ends_at > now() - interval '1 day'
     ORDER BY b.starts_at
     LIMIT 100
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    userId: String(row.staff_user_id),
    name: String(row.name),
    startsOn: String(row.starts_on),
    endsOn: String(row.ends_on),
    reason: String(row.reason),
  }));
}

/**
 * Leave in whole Sofia days. Anyone records their own; staff.manage records
 * anyone's. The block is [first day 00:00, day after the last 00:00) on the
 * Sofia wall clock, so DST cannot shave an hour off a day.
 */
export async function addTimeOff(
  db: TransactionalDb,
  actor: ClubActor,
  input: TimeOffInput,
): Promise<'ok' | 'not_allowed' | 'overlaps'> {
  try {
    return await addTimeOffOnce(db, actor, input);
  } catch (error: unknown) {
    // 0048: a trainer's leave is busy time on the calendar, so it cannot
    // overlap their other leave or an appointment already booked.
    if (violatedConstraint(error) === 'club_calendar_claims_staff_free') return 'overlaps';
    throw error;
  }
}

async function addTimeOffOnce(
  db: TransactionalDb,
  actor: ClubActor,
  input: TimeOffInput,
): Promise<'ok' | 'not_allowed'> {
  return db.transaction(async (tx) => {
    const allowed =
      input.userId === actor.userId
        ? clubActorMay(actor, 'office.view', { write: true })
        : clubActorMay(actor, 'staff.manage', { write: true });
    const created = await tx.execute(sql`
      INSERT INTO club_time_blocks (club_id, staff_user_id, starts_at, ends_at, reason, created_by)
      SELECT s.club_id, s.user_id,
             (${input.startsOn}::date)::timestamp AT TIME ZONE 'Europe/Sofia',
             (${input.endsOn}::date + 1)::timestamp AT TIME ZONE 'Europe/Sofia',
             ${input.reason}, ${actor.userId}
        FROM club_staff s
       WHERE s.club_id = ${actor.clubId}::uuid AND s.user_id = ${input.userId} AND ${allowed}
      RETURNING id
    `);
    if (created.rows.length === 0) return 'not_allowed' as const;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'time_off_saved',
      detail: { from: input.startsOn, to: input.endsOn, reason: input.reason },
    });
    return 'ok' as const;
  });
}

/** Remove a leave: one's own, or anyone's with staff.manage. */
export async function removeTimeOff(
  db: TransactionalDb,
  actor: ClubActor,
  blockId: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const removed = await tx.execute(sql`
      DELETE FROM club_time_blocks b
       WHERE b.id = ${blockId}::uuid AND b.staff_user_id IS NOT NULL
         AND CASE WHEN b.staff_user_id = ${actor.userId}
                  THEN ${clubWriteScope(actor, 'office.view', 'b')}
                  ELSE ${clubWriteScope(actor, 'staff.manage', 'b')} END
      RETURNING b.id
    `);
    if (removed.rows.length === 0) return false;
    await recordClubAudit(tx, {
      clubId: actor.clubId,
      by: { kind: 'staff', actor },
      action: 'time_off_removed',
      detail: {},
    });
    return true;
  });
}
