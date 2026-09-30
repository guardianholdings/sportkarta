import { sql, type SQL } from '@sportkarta/db';

import type { Role } from './roles';

/**
 * Municipality-scoped moderation (docs/ROADMAP.md §5, Stage 3.3).
 *
 * The authorization rule is expressed IN THE SQL, not in a check before it:
 * every statement joins against ambassador_municipalities, so an ambassador
 * acting outside their municipalities updates zero rows even if the application
 * gate were bypassed entirely. `db/src/moderation-authz.test.ts` proves that at
 * the query layer, against real Postgres.
 *
 * Every decision that does land is written to the append-only
 * moderation_decisions log in the same transaction, so "decided but unlogged"
 * is not a reachable state.
 *
 * A photo that ends up refused — rejected in the queue, or taken down after it
 * was published — also loses its FILE. The usual reason to refuse a photo is
 * that it shows people; keeping the image on the volume, and in every nightly
 * backup, would keep exactly the personal data the decision refused, for no
 * purpose. The delete runs only AFTER the transaction has committed: deleting
 * first and then failing to commit would leave a live row pointing at nothing,
 * while a failed delete after commit leaves only an orphan file no public
 * request can reach (the serving route answers from the row, and the row now
 * says rejected).
 */

export interface ModerationActor {
  id: string;
  role: Role;
}

export type PhotoDecision = 'approved' | 'rejected';
/** The log value for taking an APPROVED photo down again (migration 0034). */
export type PhotoTakedown = 'removed';
export type ReportDecision = 'reviewed' | 'dismissed';
export type FacilityDecision = 'verified' | 'gone';

export interface DecisionResult {
  /** False when the item was out of scope, already decided, or absent. */
  applied: boolean;
}

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/**
 * Where a refused photo's file is deleted from: the storage adapter in the app
 * (`getStorage()`), a recorder in tests. Required, not optional, so no caller
 * can decide a photo and forget the file.
 */
export interface PhotoFiles {
  delete(key: string): Promise<void>;
}

/**
 * The scope predicate. Callers MUST alias facilities as `f`, which is why the
 * column is written literally here rather than interpolated — there is no path
 * for a caller to supply a table or column name.
 *
 * An ambassador with no municipalities yet matches nothing: the subquery is
 * empty, so the predicate is false and every decision is a no-op. That is the
 * intended fail-closed default for a freshly granted account.
 */
export function scopeClause(actor: ModerationActor): SQL {
  if (actor.role === 'admin') return sql`TRUE`;
  if (actor.role !== 'ambassador') return sql`FALSE`;
  return sql`f.municipality_id IN (
    SELECT municipality_id FROM ambassador_municipalities WHERE user_id = ${actor.id}
  )`;
}

/** Same predicate for read queries that already alias facilities as `f`. */
export const moderationScopeFor = scopeClause;

async function logDecision(
  tx: SqlRunner,
  actor: ModerationActor,
  row: {
    targetType: 'photo' | 'report' | 'facility';
    targetId: string;
    facilityId: string;
    municipalityId: number | null;
    decision: string;
    /** The item's own created_at, or `now()` for a decision that had no queue. */
    queuedAt: string | SQL;
  },
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO moderation_decisions (
      actor_id, target_type, target_id, facility_id, municipality_id, decision, queued_at
    )
    VALUES (
      ${actor.id}, ${row.targetType}::moderation_target, ${row.targetId}::uuid,
      ${row.facilityId}::uuid, ${row.municipalityId}, ${row.decision}::moderation_decision,
      ${row.queuedAt}
    )
  `);
}

/**
 * Delete a refused photo's file, after its decision committed. Best effort by
 * design: the decision is already true and must not be reported as failed
 * because the volume hiccuped, and the storage delete is idempotent, so a
 * later retry is harmless. Logs the photo id and the error CODE only — never
 * the message, which for a filesystem error embeds the path.
 */
async function discardPhotoFile(files: PhotoFiles, photoId: string, key: string): Promise<void> {
  try {
    await files.delete(key);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    console.error(
      `[moderation] photo ${photoId} was refused but its file could not be deleted:`,
      typeof code === 'string' ? code : error instanceof Error ? error.name : 'unknown error',
    );
  }
}

/** Approve or reject a pending photo, inside the actor's scope. */
export async function decidePhoto(
  db: TransactionalDb,
  actor: ModerationActor,
  photoId: string,
  decision: PhotoDecision,
  files: PhotoFiles,
): Promise<DecisionResult> {
  const decided = await db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE facility_photos p
      SET status = ${decision}::photo_status
      FROM facilities f
      WHERE p.id = ${photoId}::uuid
        AND f.id = p.facility_id
        AND p.status = 'pending'
        AND ${scopeClause(actor)}
      RETURNING p.id, p.facility_id, p.storage_path, p.created_at, f.municipality_id
    `);
    const row = updated.rows[0];
    if (!row) return null;

    await logDecision(tx, actor, {
      targetType: 'photo',
      targetId: String(row.id),
      facilityId: String(row.facility_id),
      municipalityId: (row.municipality_id as number | null) ?? null,
      decision,
      queuedAt: String(row.created_at),
    });
    return { storagePath: String(row.storage_path) };
  });
  if (!decided) return { applied: false };

  // Committed. Only now is it safe to destroy the evidence of the upload.
  if (decision === 'rejected') await discardPhotoFile(files, photoId, decided.storagePath);
  return { applied: true };
}

/**
 * Take an APPROVED photo down again — the notice-and-action path: a parent
 * whose child is recognisable in it, a rights-holder, or an approval that was
 * simply a mistake. Same shape as a queue decision: scoped in the statement,
 * logged in the same transaction, the file deleted after commit.
 *
 * The photo goes to status 'rejected' (from the public's side a withdrawn photo
 * and a refused one are the same thing: not shown), but the log records
 * 'removed', so "it was public and we withdrew it" stays distinguishable from
 * "it never went out". A takedown has no queue, so it is recorded as acted on
 * the moment it was queued, and the SLA medians leave it out
 * (lib/moderation-data.ts) rather than let it pull them toward zero.
 */
export async function unpublishPhoto(
  db: TransactionalDb,
  actor: ModerationActor,
  photoId: string,
  files: PhotoFiles,
): Promise<DecisionResult> {
  const takedown: PhotoTakedown = 'removed';
  const removed = await db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE facility_photos p
      SET status = 'rejected'
      FROM facilities f
      WHERE p.id = ${photoId}::uuid
        AND f.id = p.facility_id
        AND p.status = 'approved'
        AND ${scopeClause(actor)}
      RETURNING p.id, p.facility_id, p.storage_path, f.municipality_id
    `);
    const row = updated.rows[0];
    if (!row) return null;

    await logDecision(tx, actor, {
      targetType: 'photo',
      targetId: String(row.id),
      facilityId: String(row.facility_id),
      municipalityId: (row.municipality_id as number | null) ?? null,
      decision: takedown,
      // now() is the transaction timestamp, so this equals decided_at's
      // default exactly and moderation_decisions_order (decided >= queued) holds.
      queuedAt: sql`now()`,
    });
    return { storagePath: String(row.storage_path) };
  });
  if (!removed) return { applied: false };

  await discardPhotoFile(files, photoId, removed.storagePath);
  return { applied: true };
}

/** Mark a pending problem report reviewed or dismissed, inside the actor's scope. */
export async function resolveReport(
  db: TransactionalDb,
  actor: ModerationActor,
  reportId: string,
  decision: ReportDecision,
): Promise<DecisionResult> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE facility_reports r
      SET status = ${decision}::report_status
      FROM facilities f
      WHERE r.id = ${reportId}::uuid
        AND f.id = r.facility_id
        AND r.status = 'pending'
        AND ${scopeClause(actor)}
      RETURNING r.id, r.facility_id, r.created_at, f.municipality_id
    `);
    const row = updated.rows[0];
    if (!row) return { applied: false };

    await logDecision(tx, actor, {
      targetType: 'report',
      targetId: String(row.id),
      facilityId: String(row.facility_id),
      municipalityId: (row.municipality_id as number | null) ?? null,
      decision,
      queuedAt: String(row.created_at),
    });
    return { applied: true };
  });
}

/**
 * Decide a crowd-submitted facility awaiting verification: publish it, or mark
 * it gone. Also writes the facility_edits row, so the field-level audit trail
 * and the moderation log agree.
 */
export async function decideFacility(
  db: TransactionalDb,
  actor: ModerationActor,
  facilityId: string,
  decision: FacilityDecision,
): Promise<DecisionResult> {
  const nextStatus = decision === 'verified' ? 'active' : 'gone';

  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE facilities f
      SET status = ${nextStatus}::facility_status
      WHERE f.id = ${facilityId}::uuid
        AND f.status = 'needs_verification'
        AND ${scopeClause(actor)}
      RETURNING f.id, f.created_at, f.municipality_id
    `);
    const row = updated.rows[0];
    if (!row) return { applied: false };

    await tx.execute(sql`
      INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
      VALUES (${facilityId}::uuid, ${actor.id}, 'crowd', 'status',
              '"needs_verification"'::jsonb, ${JSON.stringify(nextStatus)}::jsonb)
    `);
    await logDecision(tx, actor, {
      targetType: 'facility',
      targetId: String(row.id),
      facilityId: String(row.id),
      municipalityId: (row.municipality_id as number | null) ?? null,
      decision,
      queuedAt: String(row.created_at),
    });
    return { applied: true };
  });
}
