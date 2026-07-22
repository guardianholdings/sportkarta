import { getDb } from '@sportkarta/db';
import { facilityAccess, facilitySource, facilityStatus } from '@sportkarta/db/schema';
import { sql, type SQL } from 'drizzle-orm';

/** Read-side queries for the admin screens. Server-only; callers are gated. */

export const STATUS_VALUES = facilityStatus.enumValues;
export const SOURCE_VALUES = facilitySource.enumValues;
export const ACCESS_VALUES = facilityAccess.enumValues;

export type FacilityStatus = (typeof STATUS_VALUES)[number];
export type FacilitySource = (typeof SOURCE_VALUES)[number];
export type FacilityAccess = (typeof ACCESS_VALUES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface FacilityFilters {
  q?: string;
  /** 'none' = municipality IS NULL; number = specific municipality id. */
  municipality?: number | 'none';
  status?: FacilityStatus;
  source?: FacilitySource;
  page: number;
}

export const FACILITIES_PAGE_SIZE = 50;

export interface FacilityListRow {
  id: string;
  name: string | null;
  quarter: string | null;
  municipalityName: string | null;
  sportTypes: string[];
  status: FacilityStatus;
  source: FacilitySource;
  updatedAt: string;
  lon: number;
  lat: number;
}

function facilityConditions(filters: FacilityFilters): SQL {
  const conditions: SQL[] = [sql`true`];
  const q = filters.q?.trim();
  if (q) conditions.push(sql`f.name ILIKE ${'%' + q + '%'}`);
  if (filters.municipality === 'none') conditions.push(sql`f.municipality_id IS NULL`);
  else if (typeof filters.municipality === 'number')
    conditions.push(sql`f.municipality_id = ${filters.municipality}`);
  if (filters.status) conditions.push(sql`f.status::text = ${filters.status}`);
  if (filters.source) conditions.push(sql`f.source::text = ${filters.source}`);
  return sql.join(conditions, sql` AND `);
}

export async function listFacilities(
  filters: FacilityFilters,
): Promise<{ rows: FacilityListRow[]; total: number }> {
  const db = getDb();
  const where = facilityConditions(filters);
  const offset = (filters.page - 1) * FACILITIES_PAGE_SIZE;

  const rows = await db.execute(sql`
    SELECT f.id, f.name, f.quarter, m.name_bg AS municipality_name, f.sport_types,
           f.status, f.source, f.updated_at, ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat
    FROM facilities f
    LEFT JOIN municipalities m ON m.id = f.municipality_id
    WHERE ${where}
    ORDER BY f.updated_at DESC, f.id
    LIMIT ${FACILITIES_PAGE_SIZE} OFFSET ${offset}
  `);
  const count = await db.execute(sql`SELECT count(*)::int AS n FROM facilities f WHERE ${where}`);

  return {
    rows: rows.rows.map((r) => toListRow(r as Record<string, unknown>)),
    total: Number((count.rows[0] as { n?: unknown } | undefined)?.n ?? 0),
  };
}

function toListRow(r: Record<string, unknown>): FacilityListRow {
  return {
    id: String(r.id),
    name: (r.name as string | null) ?? null,
    quarter: (r.quarter as string | null) ?? null,
    municipalityName: (r.municipality_name as string | null) ?? null,
    sportTypes: (r.sport_types as string[] | null) ?? [],
    status: r.status as FacilityStatus,
    source: r.source as FacilitySource,
    updatedAt: String(r.updated_at),
    lon: Number(r.lon),
    lat: Number(r.lat),
  };
}

export interface MunicipalityOption {
  id: number;
  nameBg: string;
}

export async function municipalityOptions(): Promise<MunicipalityOption[]> {
  const db = getDb();
  const result = await db.execute(
    sql`SELECT id, name_bg FROM municipalities ORDER BY name_bg COLLATE "bg-BG-x-icu"`,
  );
  return result.rows.map((r) => {
    const row = r as { id: number; name_bg: string };
    return { id: Number(row.id), nameBg: row.name_bg };
  });
}

export interface DashboardCounts {
  active: number;
  needsVerification: number;
  gone: number;
  pendingPhotos: number;
  municipalities: number;
}

export async function dashboardCounts(): Promise<DashboardCounts> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT
      count(*) FILTER (WHERE status = 'active') AS active,
      count(*) FILTER (WHERE status = 'needs_verification') AS needs_verification,
      count(*) FILTER (WHERE status = 'gone') AS gone,
      (SELECT count(*) FROM facility_photos WHERE status = 'pending') AS pending_photos,
      (SELECT count(*) FROM municipalities) AS municipalities
    FROM facilities
  `);
  const r = result.rows[0] as Record<string, unknown> | undefined;
  return {
    active: Number(r?.active ?? 0),
    needsVerification: Number(r?.needs_verification ?? 0),
    gone: Number(r?.gone ?? 0),
    pendingPhotos: Number(r?.pending_photos ?? 0),
    municipalities: Number(r?.municipalities ?? 0),
  };
}

export interface VerifyCard {
  id: string;
  name: string | null;
  quarter: string | null;
  municipalityName: string | null;
  sportTypes: string[];
  surface: string | null;
  lighting: boolean | null;
  covered: boolean;
  access: FacilityAccess;
  source: FacilitySource;
  lon: number;
  lat: number;
  osmTags: Record<string, string> | null;
}

/**
 * Queue for the one-keystroke verify flow. Latin names sort before Cyrillic
 * under ORDER BY name, which also makes e2e fixtures deterministic.
 */
export async function verifyQueue(
  municipality: number | 'none' | undefined,
  limit = 20,
): Promise<{ cards: VerifyCard[]; remaining: number }> {
  const db = getDb();
  const where =
    municipality === 'none'
      ? sql`f.status = 'needs_verification' AND f.municipality_id IS NULL`
      : typeof municipality === 'number'
        ? sql`f.status = 'needs_verification' AND f.municipality_id = ${municipality}`
        : sql`f.status = 'needs_verification'`;

  const rows = await db.execute(sql`
    SELECT f.id, f.name, f.quarter, m.name_bg AS municipality_name, f.sport_types,
           f.surface, f.lighting, f.covered, f.access, f.source,
           ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat,
           f.attrs -> 'osm' -> 'tags' AS osm_tags
    FROM facilities f
    LEFT JOIN municipalities m ON m.id = f.municipality_id
    WHERE ${where}
    ORDER BY f.name NULLS LAST, f.id
    LIMIT ${limit}
  `);
  const count = await db.execute(sql`SELECT count(*)::int AS n FROM facilities f WHERE ${where}`);

  return {
    cards: rows.rows.map((r) => {
      const row = r as Record<string, unknown>;
      return {
        id: String(row.id),
        name: (row.name as string | null) ?? null,
        quarter: (row.quarter as string | null) ?? null,
        municipalityName: (row.municipality_name as string | null) ?? null,
        sportTypes: (row.sport_types as string[] | null) ?? [],
        surface: (row.surface as string | null) ?? null,
        lighting: (row.lighting as boolean | null) ?? null,
        covered: Boolean(row.covered),
        access: row.access as FacilityAccess,
        source: row.source as FacilitySource,
        lon: Number(row.lon),
        lat: Number(row.lat),
        osmTags: (row.osm_tags as Record<string, string> | null) ?? null,
      };
    }),
    remaining: Number((count.rows[0] as { n?: unknown } | undefined)?.n ?? 0),
  };
}

export interface FacilityDetail extends VerifyCard {
  status: FacilityStatus;
}

export async function getFacility(id: string): Promise<FacilityDetail | null> {
  if (!isUuid(id)) return null;
  const db = getDb();
  const result = await db.execute(sql`
    SELECT f.id, f.name, f.quarter, m.name_bg AS municipality_name, f.sport_types,
           f.surface, f.lighting, f.covered, f.access, f.source, f.status,
           ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat,
           f.attrs -> 'osm' -> 'tags' AS osm_tags
    FROM facilities f
    LEFT JOIN municipalities m ON m.id = f.municipality_id
    WHERE f.id = ${id}
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    name: (row.name as string | null) ?? null,
    quarter: (row.quarter as string | null) ?? null,
    municipalityName: (row.municipality_name as string | null) ?? null,
    sportTypes: (row.sport_types as string[] | null) ?? [],
    surface: (row.surface as string | null) ?? null,
    lighting: (row.lighting as boolean | null) ?? null,
    covered: Boolean(row.covered),
    access: row.access as FacilityAccess,
    source: row.source as FacilitySource,
    status: row.status as FacilityStatus,
    lon: Number(row.lon),
    lat: Number(row.lat),
    osmTags: (row.osm_tags as Record<string, string> | null) ?? null,
  };
}

export interface EditHistoryRow {
  id: number;
  actor: string | null;
  source: FacilitySource;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  createdAt: string;
}

export async function facilityHistory(id: string): Promise<EditHistoryRow[]> {
  if (!isUuid(id)) return [];
  const db = getDb();
  const result = await db.execute(sql`
    SELECT id, actor, source, field, old_value, new_value, created_at
    FROM facility_edits
    WHERE facility_id = ${id}
    ORDER BY created_at DESC, id DESC
    LIMIT 50
  `);
  return result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: Number(row.id),
      actor: (row.actor as string | null) ?? null,
      source: row.source as FacilitySource,
      field: String(row.field),
      oldValue: row.old_value,
      newValue: row.new_value,
      createdAt: String(row.created_at),
    };
  });
}

export interface PendingPhoto {
  id: string;
  facilityId: string;
  facilityName: string | null;
  storagePath: string;
  uploadedBy: string | null;
  createdAt: string;
}

export async function pendingPhotos(): Promise<PendingPhoto[]> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT p.id, p.facility_id, f.name AS facility_name, p.storage_path, p.uploaded_by, p.created_at
    FROM facility_photos p
    JOIN facilities f ON f.id = p.facility_id
    WHERE p.status = 'pending'
    ORDER BY p.created_at
    LIMIT 100
  `);
  return result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      facilityId: String(row.facility_id),
      facilityName: (row.facility_name as string | null) ?? null,
      storagePath: String(row.storage_path),
      uploadedBy: (row.uploaded_by as string | null) ?? null,
      createdAt: String(row.created_at),
    };
  });
}

export interface ImportJobRow {
  id: string;
  state: string;
  dryRun: boolean;
  actor: string | null;
  createdOn: string;
  completedOn: string | null;
}

/** pg-boss keeps finished jobs in pgboss.job until archival, then pgboss.archive. */
export async function listImportJobs(): Promise<ImportJobRow[]> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT id, state, data, created_on, completed_on FROM (
      SELECT id, state, data, created_on, completed_on FROM pgboss.job WHERE name = 'import.osm'
      UNION ALL
      SELECT id, state, data, created_on, completed_on FROM pgboss.archive WHERE name = 'import.osm'
    ) jobs
    ORDER BY created_on DESC
    LIMIT 20
  `);
  return result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    const data = (row.data as { dryRun?: boolean; actor?: string } | null) ?? {};
    return {
      id: String(row.id),
      state: String(row.state),
      dryRun: data.dryRun !== false,
      actor: data.actor ?? null,
      createdOn: String(row.created_on),
      completedOn: row.completed_on ? String(row.completed_on) : null,
    };
  });
}

export interface ImportJobDetail extends ImportJobRow {
  report: string | null;
}

export async function getImportJob(id: string): Promise<ImportJobDetail | null> {
  if (!isUuid(id)) return null;
  const db = getDb();
  const result = await db.execute(sql`
    SELECT id, state, data, output, created_on, completed_on FROM (
      SELECT id, state, data, output, created_on, completed_on FROM pgboss.job
        WHERE name = 'import.osm' AND id = ${id}
      UNION ALL
      SELECT id, state, data, output, created_on, completed_on FROM pgboss.archive
        WHERE name = 'import.osm' AND id = ${id}
    ) jobs
    LIMIT 1
  `);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const data = (row.data as { dryRun?: boolean; actor?: string } | null) ?? {};
  const output = row.output as { report?: string } | null;
  return {
    id: String(row.id),
    state: String(row.state),
    dryRun: data.dryRun !== false,
    actor: data.actor ?? null,
    createdOn: String(row.created_on),
    completedOn: row.completed_on ? String(row.completed_on) : null,
    report: typeof output?.report === 'string' ? output.report : null,
  };
}
