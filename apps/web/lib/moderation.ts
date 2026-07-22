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
 */

export interface ModerationActor {
  id: string;
  role: Role;
}

export type PhotoDecision = 'approved' | 'rejected';
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
    queuedAt: string;
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

/** Approve or reject a pending photo, inside the actor's scope. */
export async function decidePhoto(
  db: TransactionalDb,
  actor: ModerationActor,
  photoId: string,
  decision: PhotoDecision,
): Promise<DecisionResult> {
  return db.transaction(async (tx) => {
    const updated = await tx.execute(sql`
      UPDATE facility_photos p
      SET status = ${decision}::photo_status
      FROM facilities f
      WHERE p.id = ${photoId}::uuid
        AND f.id = p.facility_id
        AND p.status = 'pending'
        AND ${scopeClause(actor)}
      RETURNING p.id, p.facility_id, p.created_at, f.municipality_id
    `);
    const row = updated.rows[0];
    if (!row) return { applied: false };

    await logDecision(tx, actor, {
      targetType: 'photo',
      targetId: String(row.id),
      facilityId: String(row.facility_id),
      municipalityId: (row.municipality_id as number | null) ?? null,
      decision,
      queuedAt: String(row.created_at),
    });
    return { applied: true };
  });
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
