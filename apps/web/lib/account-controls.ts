import { sql, type SQL } from '@sportkarta/db';

import { deleteAccount, type DeleteAccountOptions, type DeletionSummary } from './account-deletion';
import { recordAdminAction } from './admin-actions';

/**
 * The operator's account controls on /admin/akaunti/[id] (migration 0033):
 * suspend and lift, reset a display name, force a passport private, end every
 * session, erase. Admin-only — every calling server action establishes that
 * with `requireRole('admin')`; these functions are the data layer, in the
 * lib/ambassadors.ts style.
 *
 * FOUR RULES HOLD FOR EVERY FUNCTION HERE:
 *
 *  1. THE CHANGE AND ITS LOG ROW SHARE ONE TRANSACTION. `admin_actions` is
 *     written through the same `tx`, so a change that commits is logged and a
 *     change that rolls back is not — never one without the other.
 *  2. A NO-OP LOGS NOTHING. Each function reads the row `FOR UPDATE` first and
 *     returns `changed: false` when there was nothing to do. A log where "reset
 *     the name" appears three times for one double-clicked button reads as three
 *     decisions.
 *  3. AN ADMIN ACCOUNT IS OUT OF REACH of suspension and erasure. The admin role
 *     is managed by ADMIN_EMAILS (lib/roles.ts syncAdminRole), so the way to act
 *     on an admin is to remove their address there; letting one admin suspend
 *     another from the panel would be a privilege fight with no referee. The
 *     refusal also covers the acting admin's own account.
 *  4. THE ONLY VISIBILITY THIS MODULE WRITES IS 'private'. Publishing a passport
 *     is the member's own act (lib/passport.ts setPassportVisibility), and
 *     nothing here can ever set it — the test in tests/account-controls.test.ts
 *     reads this file to hold that line. Consent receipts (the two training
 *     consents) are not touched at all: withdrawing one is what DELETES the data
 *     it covers, so an admin flag-flip would leave Art. 9 rows behind it.
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

export type ControlFailure =
  'not_found' | 'is_admin' | 'reason_required' | 'reason_too_long' | 'confirmation_mismatch';

export type ControlResult = { ok: true; changed: boolean } | { ok: false; reason: ControlFailure };

/** Mirrors `users_suspended_reason_sane` (0033) so the form fails politely before the CHECK does. */
export const SUSPENSION_REASON_MAX = 300;

interface SubjectRow {
  role: string;
  suspended: boolean;
  isPublic: boolean;
  hasName: boolean;
}

/**
 * Lock and read the subject row. Every control but erasure starts here —
 * erasure runs inside deleteAccount's own transaction.
 */
async function lockSubject(tx: SqlRunner, subjectId: string): Promise<SubjectRow | null> {
  const result = await tx.execute(sql`
    SELECT role, (suspended_at IS NOT NULL) AS suspended,
           (profile_visibility = 'public') AS is_public,
           (display_name <> '') AS has_name
    FROM users WHERE id = ${subjectId}
    FOR UPDATE
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    role: String(row.role),
    suspended: row.suspended === true,
    isPublic: row.is_public === true,
    hasName: row.has_name === true,
  };
}

export function normalizeSuspensionReason(
  raw: string,
): { ok: true; reason: string } | { ok: false; reason: 'reason_required' | 'reason_too_long' } {
  const reason = raw.trim();
  if (reason === '') return { ok: false, reason: 'reason_required' };
  if (reason.length > SUSPENSION_REASON_MAX) return { ok: false, reason: 'reason_too_long' };
  return { ok: true, reason };
}

/**
 * Suspend: the member is signed out on their next request and cannot sign back
 * in to anything that matters.
 *
 * One transaction, three effects, one log row:
 *  - `suspended_at`/`suspended_reason` set and the passport forced PRIVATE in
 *    the SAME statement — `users_suspended_is_private` refuses any other order —
 *    so the name leaves every public board at commit;
 *  - every `sessions` row deleted, so nothing resumes after a later lift;
 *  - the log row, which records how many sessions ended and whether a public
 *    passport was withdrawn, but never the reason (see lib/admin-actions.ts).
 *
 * The session cookie cache does not delay this: getCurrentUser() filters on
 * `suspended_at IS NULL` against the database on every request.
 */
export async function suspendAccount(
  db: TransactionalDb,
  actorId: string,
  subjectId: string,
  rawReason: string,
): Promise<ControlResult> {
  const reason = normalizeSuspensionReason(rawReason);
  if (!reason.ok) return reason;

  return db.transaction(async (tx) => {
    const subject = await lockSubject(tx, subjectId);
    if (!subject) return { ok: false, reason: 'not_found' } as const;
    if (subject.role === 'admin') return { ok: false, reason: 'is_admin' } as const;
    if (subject.suspended) return { ok: true, changed: false } as const;

    await tx.execute(sql`
      UPDATE users
      SET suspended_at = now(),
          suspended_reason = ${reason.reason},
          profile_visibility = 'private',
          updated_at = now()
      WHERE id = ${subjectId}
    `);
    const ended = await tx.execute(
      sql`DELETE FROM sessions WHERE user_id = ${subjectId} RETURNING id`,
    );
    await recordAdminAction(tx, actorId, {
      action: 'account_suspended',
      subjectId,
      detail: { sessionsRevoked: ended.rows.length, passportWasPublic: subject.isPublic },
    });
    return { ok: true, changed: true } as const;
  });
}

/**
 * Lift a suspension. The reason is cleared with it (`users_suspension_pair`).
 * Nothing is re-published: the passport stays private until the member opts in
 * again, and they sign in afresh because their sessions were deleted.
 */
export async function unsuspendAccount(
  db: TransactionalDb,
  actorId: string,
  subjectId: string,
): Promise<ControlResult> {
  return db.transaction(async (tx) => {
    const subject = await lockSubject(tx, subjectId);
    if (!subject) return { ok: false, reason: 'not_found' } as const;
    if (!subject.suspended) return { ok: true, changed: false } as const;

    await tx.execute(sql`
      UPDATE users
      SET suspended_at = NULL, suspended_reason = NULL, updated_at = now()
      WHERE id = ${subjectId}
    `);
    await recordAdminAction(tx, actorId, { action: 'account_unsuspended', subjectId });
    return { ok: true, changed: true } as const;
  });
}

/**
 * Clear an offensive display name.
 *
 * Also withdraws a PUBLIC passport, in the same statement, because a public
 * passport with an empty name is a blank row on every leaderboard and a
 * nameless public page. The member picks a new name on /profil and publishes
 * again themselves. The old name is NOT logged — the log is append-only, and
 * the name is exactly the text this action exists to remove.
 */
export async function resetDisplayName(
  db: TransactionalDb,
  actorId: string,
  subjectId: string,
): Promise<ControlResult> {
  return db.transaction(async (tx) => {
    const subject = await lockSubject(tx, subjectId);
    if (!subject) return { ok: false, reason: 'not_found' } as const;
    if (!subject.hasName && !subject.isPublic) return { ok: true, changed: false } as const;

    await tx.execute(sql`
      UPDATE users
      SET display_name = '', profile_visibility = 'private', updated_at = now()
      WHERE id = ${subjectId}
    `);
    await recordAdminAction(tx, actorId, {
      action: 'display_name_reset',
      subjectId,
      detail: { passportMadePrivate: subject.isPublic },
    });
    return { ok: true, changed: true } as const;
  });
}

/**
 * Withdraw a public passport without touching anything else. The handle is
 * KEPT, like the member's own "go private" (lib/passport.ts), so a link they
 * shared starts working again the day they re-publish.
 */
export async function forcePassportPrivate(
  db: TransactionalDb,
  actorId: string,
  subjectId: string,
): Promise<ControlResult> {
  return db.transaction(async (tx) => {
    const subject = await lockSubject(tx, subjectId);
    if (!subject) return { ok: false, reason: 'not_found' } as const;
    if (!subject.isPublic) return { ok: true, changed: false } as const;

    await tx.execute(sql`
      UPDATE users SET profile_visibility = 'private', updated_at = now()
      WHERE id = ${subjectId}
    `);
    await recordAdminAction(tx, actorId, { action: 'passport_made_private', subjectId });
    return { ok: true, changed: true } as const;
  });
}

/**
 * End every session — "my phone was stolen", or the first half of a
 * suspension done by hand.
 *
 * On its own this is bounded by the session cookie cache (lib/auth.ts): a
 * device holding a fresh signed cookie keeps working for up to five minutes.
 * Suspension does not have that window, because it is checked against the row
 * on every request; that is the tool for "stop this person now".
 */
export async function revokeSessions(
  db: TransactionalDb,
  actorId: string,
  subjectId: string,
): Promise<ControlResult> {
  return db.transaction(async (tx) => {
    const subject = await lockSubject(tx, subjectId);
    if (!subject) return { ok: false, reason: 'not_found' } as const;

    const ended = await tx.execute(
      sql`DELETE FROM sessions WHERE user_id = ${subjectId} RETURNING id`,
    );
    if (ended.rows.length === 0) return { ok: true, changed: false } as const;
    await recordAdminAction(tx, actorId, {
      action: 'sessions_revoked',
      subjectId,
      detail: { count: ended.rows.length },
    });
    return { ok: true, changed: true } as const;
  });
}

/**
 * GDPR erasure on the member's behalf — the Art. 17 request from someone who can
 * no longer sign in.
 *
 * The confirmation is the member's EMAIL ADDRESS, typed, and compared against
 * the database rather than against anything the form sent: the point is to
 * prove the admin is erasing the account they think they are, and a hidden
 * field would only prove the form was submitted.
 *
 * The erasure itself is the member's own `deleteAccount` — the same tombstone,
 * the same preserved audit trail — with the admin recorded as `erasedBy`, which
 * writes 'account_erased' inside that transaction. `enqueue` is forwarded as
 * well: erasing an organiser cancels their series (a trigger), and the members
 * holding RSVPs are owed the same `series_cancelled` notice they would get had
 * the organiser erased themselves. The calling action passes the hook /profil
 * uses (lib/account-erasure-notify.ts).
 */
export async function eraseAccountAsAdmin(
  db: TransactionalDb,
  actorId: string,
  subjectId: string,
  typedEmail: string,
  options: Pick<DeleteAccountOptions, 'enqueue'> = {},
): Promise<{ ok: true; summary: DeletionSummary } | { ok: false; reason: ControlFailure }> {
  const found = await db.execute(sql`SELECT role, email FROM users WHERE id = ${subjectId}`);
  const row = found.rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (String(row.role) === 'admin') return { ok: false, reason: 'is_admin' };
  // users.email is CHECK-pinned lowercase, so lowering the typed value is the
  // whole normalisation.
  if (typedEmail.trim().toLowerCase() !== String(row.email)) {
    return { ok: false, reason: 'confirmation_mismatch' };
  }

  const summary = await deleteAccount(db, subjectId, {
    erasedBy: actorId,
    enqueue: options.enqueue,
  });
  return { ok: true, summary };
}
