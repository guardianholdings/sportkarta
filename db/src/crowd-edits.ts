import { sql, type SQL } from 'drizzle-orm';

/**
 * The crowd-edit feed and its undo (pre-launch audit finding 53).
 *
 * Any signed-in member can correct any facility, and crowd edits outrank every
 * import, so one throwaway account could quietly rewrite sixty facilities an
 * hour — and re-running the OSM import would not put anything back, because
 * the crowd value is frozen against it. Until now the operator had no list of
 * recent crowd edits and no way to undo one short of retyping each facility.
 *
 * REVERTING IS AN EDIT, NOT AN ERASURE. facility_edits is append-only (triggers
 * in migration 0001), so a revert never touches the row it undoes: it restores
 * the facility's column and appends a NEW row — field = the same field, old =
 * what was there, new = what it goes back to, actor = the operator, source =
 * 'crowd'. That last part matches the admin editor (apps/web facilities
 * actions): an operator's decision is the top of the merge policy, so a
 * restored value is protected from the next import exactly like a hand fix.
 *
 * A REVERT NEVER CLOBBERS A LATER EDIT. It applies only while the column still
 * holds the value this edit wrote; if somebody has changed it since, the
 * outcome is `superseded` and nothing is written. Reverting everything by an
 * account works newest-first through the same rule, so an account's run of
 * edits unwinds step by step and stops at anyone else's correction.
 *
 * ADMIN-ONLY BY CONTRACT. Nothing here is municipality-scoped; the one caller
 * (/admin/redakcii) gates on requireRole('admin').
 */

interface SqlRunner {
  execute(query: SQL): Promise<{ rows: Record<string, unknown>[] }>;
}

interface TransactionalDb extends SqlRunner {
  transaction<T>(callback: (tx: SqlRunner) => Promise<T>): Promise<T>;
}

/**
 * Fields a revert can restore. Everything a member can write, plus `status`
 * (publishing) and `created` (a crowd-added facility, undone by marking it
 * gone — the row itself cannot be deleted while its audit trail exists).
 * `verified`, `reported_missing` and `access_proposed` changed no column.
 */
export const REVERTABLE_FIELDS = [
  'access',
  'surface',
  'lighting',
  'covered',
  'sport_types',
  'status',
  'condition',
  'created',
] as const;
export type RevertableField = (typeof REVERTABLE_FIELDS)[number];

export function isRevertable(field: string): field is RevertableField {
  return (REVERTABLE_FIELDS as readonly string[]).includes(field);
}

/** Columns that may never be restored to "nothing". */
const NOT_NULL_FIELDS = new Set<string>(['access', 'covered', 'sport_types', 'status']);

/**
 * The facility's current value for an edit's field, as jsonb, with SQL NULL
 * mapped to JSON null so it compares equal to what facility_edits recorded.
 * A closed CASE — the field name is data from the row, never interpolated.
 */
const CURRENT_VALUE = sql`COALESCE(CASE e.field
    WHEN 'access' THEN to_jsonb(f.access::text)
    WHEN 'surface' THEN to_jsonb(f.surface)
    WHEN 'lighting' THEN to_jsonb(f.lighting)
    WHEN 'covered' THEN to_jsonb(f.covered)
    WHEN 'sport_types' THEN to_jsonb(f.sport_types)
    WHEN 'status' THEN to_jsonb(f.status::text)
    WHEN 'condition' THEN to_jsonb(f.condition::text)
  END, 'null'::jsonb)`;

/** Column writers from a jsonb target. Field names are never interpolated. */
const RESTORE: Record<Exclude<RevertableField, 'created'>, (target: SQL) => SQL> = {
  access: (v) => sql`access = (${v} #>> '{}')::facility_access`,
  surface: (v) => sql`surface = ${v} #>> '{}'`,
  lighting: (v) => sql`lighting = (${v} #>> '{}')::boolean`,
  covered: (v) => sql`covered = (${v} #>> '{}')::boolean`,
  sport_types: (v) => sql`sport_types = ARRAY(SELECT jsonb_array_elements_text(${v}))`,
  status: (v) => sql`status = (${v} #>> '{}')::facility_status`,
  // The condition and its timestamp travel together (facilities_condition_pair):
  // back to "no report" clears both; back to an older state keeps the time.
  condition: (v) =>
    sql`condition = (${v} #>> '{}')::facility_condition,
        condition_reported_at = CASE WHEN ${v} = 'null'::jsonb THEN NULL
                                     ELSE coalesce(condition_reported_at, now()) END`,
};

export type RevertOutcome =
  /** The column went back and a new audit row says so. */
  | 'reverted'
  /** Somebody changed the value since; nothing was written. */
  | 'superseded'
  /** The column already holds the value this edit replaced. */
  | 'already'
  /** This kind of edit changed no column, or cannot be restored. */
  | 'not_revertable'
  | 'not_found';

export interface RevertResult {
  editId: number;
  outcome: RevertOutcome;
  facilityId?: string;
  field?: string;
}

async function revertInTransaction(
  tx: SqlRunner,
  editId: number,
  actorId: string,
): Promise<RevertResult> {
  // One statement reads the edit, locks its facility and compares the live
  // value against both sides of the edit.
  const found = await tx.execute(sql`
    SELECT e.facility_id, e.field, e.old_value, e.new_value, f.status::text AS status,
           ${CURRENT_VALUE} = e.new_value AS at_new,
           ${CURRENT_VALUE} = e.old_value AS at_old
    FROM facility_edits e
    JOIN facilities f ON f.id = e.facility_id
    WHERE e.id = ${editId} AND e.source = 'crowd'
    FOR UPDATE OF f
  `);
  const row = found.rows[0];
  if (!row) return { editId, outcome: 'not_found' };
  const facilityId = String(row.facility_id);
  const field = String(row.field);
  const base = { editId, facilityId, field };
  if (!isRevertable(field)) return { ...base, outcome: 'not_revertable' };

  if (field === 'created') {
    // A crowd-added facility is undone by taking it off the map. The row stays:
    // facility_edits references it, and the history is the evidence.
    const status = String(row.status);
    if (status === 'gone') return { ...base, outcome: 'already' };
    await tx.execute(sql`UPDATE facilities SET status = 'gone' WHERE id = ${facilityId}::uuid`);
    await tx.execute(sql`
      INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
      VALUES (${facilityId}::uuid, ${actorId}, 'crowd', 'status',
              ${JSON.stringify(status)}::jsonb, '"gone"'::jsonb)
    `);
    return { ...base, outcome: 'reverted' };
  }

  if (row.at_old === true) return { ...base, outcome: 'already' };
  if (row.at_new !== true) return { ...base, outcome: 'superseded' };

  const target = row.old_value ?? null;
  // An edit with no "before" (a first condition report writes old = null) is
  // fine to undo — unless the column can never be empty.
  if (target === null && NOT_NULL_FIELDS.has(field)) return { ...base, outcome: 'not_revertable' };

  const targetJson = sql`${JSON.stringify(target)}::jsonb`;
  await tx.execute(
    sql`UPDATE facilities SET ${RESTORE[field](targetJson)} WHERE id = ${facilityId}::uuid`,
  );
  await tx.execute(sql`
    INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
    VALUES (${facilityId}::uuid, ${actorId}, 'crowd', ${field},
            ${JSON.stringify(row.new_value ?? null)}::jsonb, ${targetJson})
  `);
  return { ...base, outcome: 'reverted' };
}

/** Undo one crowd edit, if the facility still shows what it wrote. */
export async function revertCrowdEdit(
  db: TransactionalDb,
  params: { editId: number; actorId: string },
): Promise<RevertResult> {
  if (!Number.isSafeInteger(params.editId) || params.editId <= 0) {
    return { editId: params.editId, outcome: 'not_found' };
  }
  return db.transaction((tx) => revertInTransaction(tx, params.editId, params.actorId));
}

/** An upper bound per request, so one click is one bounded transaction. */
export const MAX_BULK_REVERT = 500;

export interface BulkRevertResult {
  considered: number;
  reverted: number;
  superseded: number;
  already: number;
  notRevertable: number;
  /** True when the account had more edits than one request handles. */
  truncated: boolean;
  facilityIds: string[];
}

/**
 * Undo everything one account changed in the last `withinHours`, newest first,
 * in ONE transaction: either the whole unwind lands or none of it does.
 *
 * Newest-first is what makes a run of edits by the same account unwind cleanly
 * (A→B then B→C goes back to B, then to A) while a correction by somebody else
 * in between stops the older edits as `superseded` instead of being overwritten.
 */
export async function revertAccountEdits(
  db: TransactionalDb,
  params: { accountId: string; withinHours: number; actorId: string },
): Promise<BulkRevertResult> {
  const empty: BulkRevertResult = {
    considered: 0,
    reverted: 0,
    superseded: 0,
    already: 0,
    notRevertable: 0,
    truncated: false,
    facilityIds: [],
  };
  const hours = Math.trunc(params.withinHours);
  if (params.accountId.trim() === '' || !(hours > 0)) return empty;

  return db.transaction(async (tx) => {
    const edits = await tx.execute(sql`
      SELECT id FROM facility_edits
      WHERE actor = ${params.accountId}
        AND source = 'crowd'
        AND field = ANY(${sql.param([...REVERTABLE_FIELDS])}::text[])
        AND created_at >= now() - make_interval(hours => ${hours})
      ORDER BY id DESC
      LIMIT ${MAX_BULK_REVERT + 1}
    `);
    const ids = edits.rows.map((row) => Number(row.id));
    const result = {
      ...empty,
      truncated: ids.length > MAX_BULK_REVERT,
      facilityIds: [] as string[],
    };
    const touched = new Set<string>();
    for (const id of ids.slice(0, MAX_BULK_REVERT)) {
      const one = await revertInTransaction(tx, id, params.actorId);
      result.considered += 1;
      if (one.outcome === 'reverted') {
        result.reverted += 1;
        if (one.facilityId) touched.add(one.facilityId);
      } else if (one.outcome === 'superseded') result.superseded += 1;
      else if (one.outcome === 'already') result.already += 1;
      else result.notRevertable += 1;
    }
    result.facilityIds = [...touched];
    return result;
  });
}

export const CROWD_FEED_PAGE_SIZE = 50;

export interface CrowdEditRow {
  id: number;
  facilityId: string;
  facilityName: string | null;
  facilitySlug: string | null;
  facilityStatus: string;
  actor: string;
  /** null when the account no longer resolves (erased) — shown as "former user". */
  actorName: string | null;
  actorRole: string | null;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  /** Metres from the place when the edit was made; null = no position offered. */
  distanceM: number | null;
  createdAt: string;
}

export interface CrowdFeedFilters {
  /** One account's edits only. */
  accountId?: string | undefined;
  /** Only edits from the last N hours. */
  withinHours?: number | undefined;
  /** Keyset pagination: edits older than this id. */
  beforeId?: number | undefined;
  limit?: number | undefined;
}

/**
 * Crowd edits, newest first. Includes operator and moderator edits (they are
 * `source='crowd'` too, by design), which is why the actor's role comes along.
 */
export async function listCrowdEdits(
  db: SqlRunner,
  filters: CrowdFeedFilters = {},
): Promise<CrowdEditRow[]> {
  const conditions: SQL[] = [sql`e.source = 'crowd'`, sql`e.actor IS NOT NULL`];
  if (filters.accountId) conditions.push(sql`e.actor = ${filters.accountId}`);
  if (filters.withinHours && filters.withinHours > 0) {
    conditions.push(
      sql`e.created_at >= now() - make_interval(hours => ${Math.trunc(filters.withinHours)})`,
    );
  }
  if (filters.beforeId && filters.beforeId > 0) conditions.push(sql`e.id < ${filters.beforeId}`);
  const limit = Math.min(Math.max(1, filters.limit ?? CROWD_FEED_PAGE_SIZE), 200);

  const result = await db.execute(sql`
    SELECT e.id, e.facility_id, f.name AS facility_name, f.slug AS facility_slug,
           f.status::text AS facility_status, e.actor, u.display_name, u.role::text AS actor_role,
           e.field, e.old_value, e.new_value, e.distance_m, e.created_at
    FROM facility_edits e
    JOIN facilities f ON f.id = e.facility_id
    LEFT JOIN users u ON u.id = e.actor
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY e.id DESC
    LIMIT ${limit}
  `);
  return result.rows.map((row) => {
    const displayName = (row.display_name as string | null) ?? null;
    const created = row.created_at;
    return {
      id: Number(row.id),
      facilityId: String(row.facility_id),
      facilityName: (row.facility_name as string | null) ?? null,
      facilitySlug: (row.facility_slug as string | null) ?? null,
      facilityStatus: String(row.facility_status),
      actor: String(row.actor),
      actorName: displayName && displayName.trim() ? displayName : null,
      actorRole: (row.actor_role as string | null) ?? null,
      field: String(row.field),
      oldValue: row.old_value,
      newValue: row.new_value,
      distanceM:
        row.distance_m === null || row.distance_m === undefined ? null : Number(row.distance_m),
      createdAt: created instanceof Date ? created.toISOString() : String(created),
    };
  });
}
