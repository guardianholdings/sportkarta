import { getDb, sql, type SQL } from '@sportkarta/db';

import { scopeClause, type ModerationActor } from './moderation';

/**
 * Reads behind the moderation screens. Every query carries the same scope
 * predicate as the mutations, so an ambassador can never be shown an item they
 * would then be unable to decide — the list and the action agree by
 * construction.
 */

export interface QueuePhoto {
  id: string;
  facilityId: string;
  facilityName: string | null;
  municipalityName: string | null;
  storagePath: string;
  uploadedBy: string | null;
  createdAt: string;
  flags: QueueFlag[];
}

export interface QueueReport {
  id: string;
  facilityId: string;
  facilityName: string | null;
  municipalityName: string | null;
  issue: string;
  body: string | null;
  createdAt: string;
  flags: QueueFlag[];
}

export interface QueueFacility {
  id: string;
  name: string | null;
  municipalityName: string | null;
  quarter: string | null;
  createdAt: string;
  flags: QueueFlag[];
}

export interface QueueFlag {
  reason: string;
  note: string | null;
}

function flagsOf(value: unknown): QueueFlag[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is { reason: string; note: string | null } => {
      return typeof entry === 'object' && entry !== null && 'reason' in entry;
    })
    .map((entry) => ({ reason: String(entry.reason), note: entry.note ?? null }));
}

/** Pre-screen flags for one queue item, as a JSON array subquery. */
function flagsSubquery(targetType: 'photo' | 'report' | 'facility', idColumn: SQL): SQL {
  return sql`COALESCE(
    (SELECT jsonb_agg(jsonb_build_object('reason', mf.reason, 'note', mf.note) ORDER BY mf.created_at)
       FROM moderation_flags mf
      WHERE mf.target_type = ${targetType}::moderation_target AND mf.target_id = ${idColumn}),
    '[]'::jsonb
  )`;
}

export async function queuePhotos(actor: ModerationActor, limit = 50): Promise<QueuePhoto[]> {
  const result = await getDb().execute(sql`
    SELECT p.id, p.facility_id, f.name AS facility_name, m.name_bg AS municipality_name,
           p.storage_path, p.uploaded_by, p.created_at,
           ${flagsSubquery('photo', sql`p.id`)} AS flags
    FROM facility_photos p
    JOIN facilities f ON f.id = p.facility_id
    LEFT JOIN municipalities m ON m.id = f.municipality_id
    WHERE p.status = 'pending' AND ${scopeClause(actor)}
    ORDER BY p.created_at
    LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    facilityId: String(row.facility_id),
    facilityName: (row.facility_name as string | null) ?? null,
    municipalityName: (row.municipality_name as string | null) ?? null,
    storagePath: String(row.storage_path),
    uploadedBy: (row.uploaded_by as string | null) ?? null,
    createdAt: String(row.created_at),
    flags: flagsOf(row.flags),
  }));
}

export async function queueReports(actor: ModerationActor, limit = 50): Promise<QueueReport[]> {
  const result = await getDb().execute(sql`
    SELECT r.id, r.facility_id, f.name AS facility_name, m.name_bg AS municipality_name,
           r.issue, r.body, r.created_at,
           ${flagsSubquery('report', sql`r.id`)} AS flags
    FROM facility_reports r
    JOIN facilities f ON f.id = r.facility_id
    LEFT JOIN municipalities m ON m.id = f.municipality_id
    WHERE r.status = 'pending' AND ${scopeClause(actor)}
    ORDER BY r.created_at
    LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    facilityId: String(row.facility_id),
    facilityName: (row.facility_name as string | null) ?? null,
    municipalityName: (row.municipality_name as string | null) ?? null,
    issue: String(row.issue),
    body: (row.body as string | null) ?? null,
    createdAt: String(row.created_at),
    flags: flagsOf(row.flags),
  }));
}

/** Crowd-submitted facilities awaiting a second pair of eyes, within scope. */
export async function queueFacilities(
  actor: ModerationActor,
  limit = 50,
): Promise<QueueFacility[]> {
  const result = await getDb().execute(sql`
    SELECT f.id, f.name, f.quarter, f.created_at, m.name_bg AS municipality_name,
           ${flagsSubquery('facility', sql`f.id`)} AS flags
    FROM facilities f
    LEFT JOIN municipalities m ON m.id = f.municipality_id
    WHERE f.status = 'needs_verification' AND f.source = 'crowd' AND ${scopeClause(actor)}
    ORDER BY f.created_at
    LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    id: String(row.id),
    name: (row.name as string | null) ?? null,
    municipalityName: (row.municipality_name as string | null) ?? null,
    quarter: (row.quarter as string | null) ?? null,
    createdAt: String(row.created_at),
    flags: flagsOf(row.flags),
  }));
}

export interface ModerationSla {
  /** Items waiting right now, by type. */
  pendingPhotos: number;
  pendingReports: number;
  pendingFacilities: number;
  /** Age of the oldest waiting item, in hours; null when the queue is empty. */
  oldestPendingHours: number | null;
  /** Median time from queued to decided, in hours, over the window. */
  medianHours: number | null;
  decisionsInWindow: number;
  windowDays: number;
}

/**
 * Queue depth and time-to-decision for the SLA panel.
 *
 * The median is `percentile_cont`, not an average: one item that sat for a
 * month would drag a mean far away from what the queue actually feels like.
 */
export async function moderationSla(
  actor: ModerationActor,
  windowDays = 30,
): Promise<ModerationSla> {
  const depth = await getDb().execute(sql`
    SELECT
      (SELECT count(*) FROM facility_photos p JOIN facilities f ON f.id = p.facility_id
        WHERE p.status = 'pending' AND ${scopeClause(actor)})::int AS pending_photos,
      (SELECT count(*) FROM facility_reports r JOIN facilities f ON f.id = r.facility_id
        WHERE r.status = 'pending' AND ${scopeClause(actor)})::int AS pending_reports,
      -- Every facility awaiting a decision, not only crowd-added ones: the
      -- verify deck serves imported facilities too, and their decisions land in
      -- the same log the median is computed from. Counting only crowd rows here
      -- would make the numerator and denominator describe different queues.
      (SELECT count(*) FROM facilities f
        WHERE f.status = 'needs_verification' AND ${scopeClause(actor)})::int
        AS pending_facilities,
      (SELECT extract(epoch FROM now() - min(oldest)) / 3600.0 FROM (
         SELECT min(p.created_at) AS oldest FROM facility_photos p
           JOIN facilities f ON f.id = p.facility_id
          WHERE p.status = 'pending' AND ${scopeClause(actor)}
         UNION ALL
         SELECT min(r.created_at) FROM facility_reports r
           JOIN facilities f ON f.id = r.facility_id
          WHERE r.status = 'pending' AND ${scopeClause(actor)}
         UNION ALL
         SELECT min(f.created_at) FROM facilities f
          WHERE f.status = 'needs_verification' AND ${scopeClause(actor)}
       ) ages) AS oldest_pending_hours
  `);

  // Decisions are scoped by the municipality recorded ON THE DECISION, so the
  // figure stays stable even if a facility's boundary is corrected later.
  const decisionScope =
    actor.role === 'admin'
      ? sql`TRUE`
      : sql`d.municipality_id IN (
          SELECT municipality_id FROM ambassador_municipalities WHERE user_id = ${actor.id}
        )`;
  const timing = await getDb().execute(sql`
    SELECT
      count(*)::int AS decisions,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY extract(epoch FROM d.decided_at - d.queued_at)
      ) / 3600.0 AS median_hours
    FROM moderation_decisions d
    WHERE d.decided_at >= now() - ${`${String(windowDays)} days`}::interval
      AND ${decisionScope}
  `);

  const depthRow = depth.rows[0] ?? {};
  const timingRow = timing.rows[0] ?? {};
  const asNumber = (value: unknown): number | null =>
    value === null || value === undefined ? null : Number(value);

  return {
    pendingPhotos: Number(depthRow.pending_photos ?? 0),
    pendingReports: Number(depthRow.pending_reports ?? 0),
    pendingFacilities: Number(depthRow.pending_facilities ?? 0),
    oldestPendingHours: asNumber(depthRow.oldest_pending_hours),
    medianHours: asNumber(timingRow.median_hours),
    decisionsInWindow: Number(timingRow.decisions ?? 0),
    windowDays,
  };
}

export interface AmbassadorSummary {
  userId: string;
  displayName: string;
  email: string;
  municipalities: { id: number; name: string }[];
  decisions: number;
  medianHours: number | null;
  lastDecisionAt: string | null;
}

/** Per-ambassador activity for the admin screen. */
export async function ambassadorActivity(windowDays = 30): Promise<AmbassadorSummary[]> {
  const result = await getDb().execute(sql`
    SELECT u.id, u.display_name, u.email,
      COALESCE(
        (SELECT jsonb_agg(jsonb_build_object('id', m.id, 'name', m.name_bg) ORDER BY m.name_bg)
           FROM ambassador_municipalities am
           JOIN municipalities m ON m.id = am.municipality_id
          WHERE am.user_id = u.id),
        '[]'::jsonb
      ) AS municipalities,
      (SELECT count(*) FROM moderation_decisions d
        WHERE d.actor_id = u.id AND d.decided_at >= now() - ${`${String(windowDays)} days`}::interval
      )::int AS decisions,
      (SELECT percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch FROM d.decided_at - d.queued_at)) / 3600.0
         FROM moderation_decisions d
        WHERE d.actor_id = u.id AND d.decided_at >= now() - ${`${String(windowDays)} days`}::interval
      ) AS median_hours,
      (SELECT max(d.decided_at) FROM moderation_decisions d WHERE d.actor_id = u.id)
        AS last_decision_at
    FROM users u
    WHERE u.role = 'ambassador'
    ORDER BY u.display_name, u.email
  `);

  return result.rows.map((row) => ({
    userId: String(row.id),
    displayName: String(row.display_name ?? ''),
    email: String(row.email),
    municipalities: Array.isArray(row.municipalities)
      ? (row.municipalities as { id: number; name: string }[])
      : [],
    decisions: Number(row.decisions ?? 0),
    medianHours: row.median_hours === null ? null : Number(row.median_hours),
    lastDecisionAt: row.last_decision_at ? String(row.last_decision_at) : null,
  }));
}

export interface UserLookup {
  id: string;
  email: string;
  displayName: string;
  role: string;
}

/**
 * Find an account to grant. Matched on the exact address rather than a
 * substring search: an admin granting moderation powers should be naming a
 * specific person, not picking from a fuzzy list of everyone on the platform.
 */
export async function findUserByEmail(email: string): Promise<UserLookup | null> {
  const result = await getDb().execute(sql`
    SELECT id, email, display_name, role FROM users WHERE email = ${email.trim().toLowerCase()}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name ?? ''),
    role: String(row.role),
  };
}

/** The municipalities an actor may moderate; empty for a scopeless ambassador. */
export async function actorMunicipalities(
  actor: ModerationActor,
): Promise<{ id: number; name: string }[]> {
  if (actor.role === 'admin') return [];
  const result = await getDb().execute(sql`
    SELECT m.id, m.name_bg AS name
    FROM ambassador_municipalities am
    JOIN municipalities m ON m.id = am.municipality_id
    WHERE am.user_id = ${actor.id}
    ORDER BY m.name_bg
  `);
  return result.rows.map((row) => ({ id: Number(row.id), name: String(row.name) }));
}
