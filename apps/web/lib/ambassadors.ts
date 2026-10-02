import { sql, type SQL } from '@sportkarta/db';

import { recordAdminAction } from './admin-actions';

/**
 * Granting and revoking ambassadors (Stage 3.3). Admin-only — the calling
 * server action establishes that; these functions are the data layer.
 *
 * Two separate things, deliberately: the ROLE says "this person moderates", the
 * SCOPE says where. A role without scope can see the queue and decide nothing,
 * which is the safe intermediate state while an admin assigns municipalities.
 *
 * Every change that lands writes an `admin_actions` row (0033) in the SAME
 * transaction, with the acting admin as actor — before that, a grant was a bare
 * UPDATE and a revocation a bare DELETE, and after a rogue-ambassador incident
 * nobody could say who had widened whose scope, or when. A call that changes
 * nothing (an idempotent re-grant, removing a municipality that was not there)
 * logs nothing.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export type GrantResult =
  { ok: true } | { ok: false; reason: 'not_found' | 'is_admin' | 'unexpected_role' };

/**
 * Promote a member to ambassador. Admins are left alone: demoting an admin to
 * ambassador through this screen would be a privilege change disguised as a
 * grant, and the admin role is managed by ADMIN_EMAILS anyway.
 */
export async function grantAmbassador(
  db: TransactionalDb,
  userId: string,
  actorId: string,
): Promise<GrantResult> {
  return db.transaction(async (tx): Promise<GrantResult> => {
    const result = await tx.execute(sql`
      UPDATE users SET role = 'ambassador'
      WHERE id = ${userId} AND role = 'user'
      RETURNING id
    `);
    if (result.rows.length > 0) {
      await recordAdminAction(tx, actorId, { action: 'ambassador_granted', subjectId: userId });
      return { ok: true };
    }

    const existing = await tx.execute(sql`SELECT role FROM users WHERE id = ${userId}`);
    const role = existing.rows[0]?.role;
    if (role === undefined) return { ok: false, reason: 'not_found' };
    if (role === 'admin') return { ok: false, reason: 'is_admin' };
    // Already an ambassador — idempotent, and nothing to log.
    if (role === 'ambassador') return { ok: true };
    // Anything else (a legacy value) changed nothing, so do not report success.
    return { ok: false, reason: 'unexpected_role' };
  });
}

/**
 * Revoke the role AND every municipality in one transaction: a demoted account
 * must not keep a scope row that would silently reactivate if the role were
 * ever regranted.
 */
export async function revokeAmbassador(
  db: TransactionalDb,
  userId: string,
  actorId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const scopes = await tx.execute(sql`
      DELETE FROM ambassador_municipalities WHERE user_id = ${userId} RETURNING municipality_id
    `);
    const demoted = await tx.execute(sql`
      UPDATE users SET role = 'user' WHERE id = ${userId} AND role = 'ambassador' RETURNING id
    `);
    if (demoted.rows.length === 0 && scopes.rows.length === 0) return;
    await recordAdminAction(tx, actorId, {
      action: 'ambassador_revoked',
      subjectId: userId,
      detail: { scopesRemoved: scopes.rows.length },
    });
  });
}

/**
 * Add a municipality to an ambassador's scope. The role check is in the
 * statement itself, so a race that demotes the account mid-request cannot leave
 * a scope row attached to a plain member.
 */
export async function addMunicipality(
  db: TransactionalDb,
  userId: string,
  municipalityId: number,
  grantedBy: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const result = await tx.execute(sql`
      INSERT INTO ambassador_municipalities (user_id, municipality_id, granted_by)
      SELECT ${userId}, ${municipalityId}, ${grantedBy}
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND role = 'ambassador')
        AND EXISTS (SELECT 1 FROM municipalities WHERE id = ${municipalityId})
      ON CONFLICT (user_id, municipality_id) DO NOTHING
      RETURNING user_id
    `);
    if (result.rows.length === 0) return false;
    await recordAdminAction(tx, grantedBy, {
      action: 'ambassador_scope_added',
      subjectId: userId,
      detail: { municipalityId },
    });
    return true;
  });
}

export async function removeMunicipality(
  db: TransactionalDb,
  userId: string,
  municipalityId: number,
  actorId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const removed = await tx.execute(sql`
      DELETE FROM ambassador_municipalities
      WHERE user_id = ${userId} AND municipality_id = ${municipalityId}
      RETURNING user_id
    `);
    if (removed.rows.length === 0) return;
    await recordAdminAction(tx, actorId, {
      action: 'ambassador_scope_removed',
      subjectId: userId,
      detail: { municipalityId },
    });
  });
}
