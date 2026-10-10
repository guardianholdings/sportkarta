import { getDb, sql, type SQL } from '@sportkarta/db';

import { scopeClause, type ModerationActor } from './moderation';
import { photosLookupClause, type PhotoLookup } from './photos';

/**
 * Reads behind the moderation screens. Every query carries the same scope
 * predicate as the mutations, so an ambassador can never be shown an item they
 * would then be unable to decide — the list and the action agree by
 * construction.
 */

/**
 * A photo as a moderator sees it. No storage key: the screen shows the image
 * itself, through /api/photos/[id] (lib/photos.ts), and a key is an internal
 * detail nobody should be deciding on.
 */
export interface ModerationPhoto {
  id: string;
  facilityId: string;
  facilityName: string | null;
  /** users.id, or null for an anonymous report photo or an erased uploader. */
  uploadedBy: string | null;
  /** The uploader's display name, so a repeat uploader is recognisable. */
  uploaderName: string | null;
  createdAt: string;
}

export interface QueuePhoto extends ModerationPhoto {
  municipalityName: string | null;
  flags: QueueFlag[];
}

export interface QueueReport {
  id: string;
  facilityId: string;
  facilityName: string | null;
  municipalityName: string | null;
  issue: string;
  body: string | null;
  /** The attached photo, unless it has been refused (its file is then gone). */
  photoId: string | null;
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

/**
 * A timestamp as ISO text, so the screens format it in Sofia time
 * (lib/format). String(Date) prints the process's UTC rendering instead.
 */
function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toModerationPhoto(row: Record<string, unknown>): ModerationPhoto {
  const name = (row.uploader_name as string | null) ?? null;
  return {
    id: String(row.id),
    facilityId: String(row.facility_id),
    facilityName: (row.facility_name as string | null) ?? null,
    uploadedBy: (row.uploaded_by as string | null) ?? null,
    uploaderName: name && name.trim() ? name : null,
    createdAt: iso(row.created_at),
  };
}

export async function queuePhotos(actor: ModerationActor, limit = 50): Promise<QueuePhoto[]> {
  const result = await getDb().execute(sql`
    SELECT p.id, p.facility_id, f.name AS facility_name, m.name_bg AS municipality_name,
           p.uploaded_by, u.display_name AS uploader_name, p.created_at,
           ${flagsSubquery('photo', sql`p.id`)} AS flags
    FROM facility_photos p
    JOIN facilities f ON f.id = p.facility_id
    LEFT JOIN municipalities m ON m.id = f.municipality_id
    LEFT JOIN users u ON u.id = p.uploaded_by
    WHERE p.status = 'pending' AND ${scopeClause(actor)}
    ORDER BY p.created_at
    LIMIT ${limit}
  `);
  return result.rows.map((row) => ({
    ...toModerationPhoto(row),
    municipalityName: (row.municipality_name as string | null) ?? null,
    flags: flagsOf(row.flags),
  }));
}

/**
 * APPROVED photos within scope, newest upload first — the takedown list.
 * `lookup` narrows it to one photo or one facility (lib/photos.ts
 * parsePhotoLookup), because a complaint names a specific picture and the
 * newest two dozen will not contain it for long.
 */
export async function publishedPhotos(
  actor: ModerationActor,
  lookup: PhotoLookup | null,
  limit = 24,
): Promise<ModerationPhoto[]> {
  const result = await getDb().execute(sql`
    SELECT p.id, p.facility_id, f.name AS facility_name,
           p.uploaded_by, u.display_name AS uploader_name, p.created_at
    FROM facility_photos p
    JOIN facilities f ON f.id = p.facility_id
    LEFT JOIN users u ON u.id = p.uploaded_by
    WHERE p.status = 'approved' AND ${scopeClause(actor)} AND ${photosLookupClause(lookup)}
    ORDER BY p.created_at DESC
    LIMIT ${limit}
  `);
  return result.rows.map(toModerationPhoto);
}

export async function queueReports(actor: ModerationActor, limit = 50): Promise<QueueReport[]> {
  const result = await getDb().execute(sql`
    SELECT r.id, r.facility_id, f.name AS facility_name, m.name_bg AS municipality_name,
           r.issue, r.body, r.created_at,
           CASE WHEN ph.status <> 'rejected' THEN ph.id END AS photo_id,
           ${flagsSubquery('report', sql`r.id`)} AS flags
    FROM facility_reports r
    JOIN facilities f ON f.id = r.facility_id
    LEFT JOIN municipalities m ON m.id = f.municipality_id
    LEFT JOIN facility_photos ph ON ph.id = r.photo_id
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
    photoId: row.photo_id ? String(row.photo_id) : null,
    createdAt: iso(row.created_at),
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
    createdAt: iso(row.created_at),
    flags: flagsOf(row.flags),
  }));
}

export interface ModerationSla {
  /** Items waiting right now in the crowd queue, by type. */
  pendingPhotos: number;
  pendingReports: number;
  /** Crowd-added facilities awaiting a second pair of eyes — the list below the panel. */
  pendingFacilities: number;
  /**
   * Imported facilities (OSM, municipal registers) awaiting verification: the
   * verify deck's backlog, counted apart from the crowd queue.
   */
  importBacklog: number;
  /** Age of the oldest waiting crowd item, in hours; null when the queue is empty. */
  oldestPendingHours: number | null;
  /** Median time from queued to decided over the window, crowd queue only. */
  medianHours: number | null;
  decisionsInWindow: number;
  windowDays: number;
}

/**
 * Queue depth and time-to-decision for the SLA panel.
 *
 * THE CROWD QUEUE, AND THE IMPORT BACKLOG BESIDE IT (UX audit 2026-10-10,
 * A-7). The panel used to count every facility awaiting verification — some
 * 6,900 of them OSM imports waiting for the verify deck — next to a list that
 * shows only crowd-added ones, and its oldest item and median were the import
 * date of the map. A member's photo, report or new facility is the queue whose
 * speed this measures; the backlog is a separate number with its own screen.
 * So the depth, the oldest item and the median all describe the crowd queue:
 * decisions about imported facilities stay out of the median exactly like
 * their rows stay out of the depth, so numerator and denominator still agree.
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
      (SELECT count(*) FROM facilities f
        WHERE f.status = 'needs_verification' AND f.source = 'crowd' AND ${scopeClause(actor)})::int
        AS pending_facilities,
      (SELECT count(*) FROM facilities f
        WHERE f.status = 'needs_verification' AND f.source <> 'crowd' AND ${scopeClause(actor)})::int
        AS import_backlog,
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
          WHERE f.status = 'needs_verification' AND f.source = 'crowd' AND ${scopeClause(actor)}
       ) ages) AS oldest_pending_hours
  `);

  // Decisions are scoped by the municipality recorded ON THE DECISION, so the
  // figure stays stable even if a facility's boundary is corrected later.
  // A takedown ('removed', 0032) is not a queue decision — it has no queue
  // time to measure — so it stays out of the median it would drag toward zero.
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
      AND d.decision <> 'removed'
      -- The crowd queue only: a verify-deck decision about an imported
      -- facility was "queued" when the map was imported, months before.
      AND NOT EXISTS (
        SELECT 1 FROM facilities f
        WHERE d.target_type = 'facility' AND f.id = d.facility_id AND f.source <> 'crowd'
      )
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
    importBacklog: Number(depthRow.import_backlog ?? 0),
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
          AND d.decision <> 'removed'
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
    lastDecisionAt: row.last_decision_at ? iso(row.last_decision_at) : null,
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
