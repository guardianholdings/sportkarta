import { getDb, sql } from '@sportkarta/db';

// Read-side for /statistika + /api/stats. Reads the materialized views (0004),
// refreshed by the pg-boss stats.refresh job. Every number here reconciles with
// a direct query on facilities (see the db reconciliation tests). Server-only.

export interface NationalStats {
  total: number;
  active: number;
  needsVerification: number;
  free: number;
  paid: number;
  restricted: number;
  school: number;
  litTrue: number;
  litKnown: number;
  litUnknown: number;
  municipalitiesCovered: number;
  sportsCount: number;
  /** When the views were last refreshed (now() captured at REFRESH). */
  generatedAt: string;
}

export interface MunicipalityStat {
  ekatteCode: string;
  nameBg: string;
  nameEn: string;
  total: number;
  active: number;
  needsVerification: number;
  free: number;
  litTrue: number;
  litKnown: number;
  /** null → "n/a" (municipality absent from the population dataset). */
  population: number | null;
  per10k: number | null;
}

export interface SportStat {
  sport: string;
  total: number;
}

export interface StatsSnapshot {
  national: NationalStats | null;
  municipalities: MunicipalityStat[];
  sports: SportStat[];
}

function num(v: unknown): number {
  return Number(v);
}
function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export async function getNationalStats(): Promise<NationalStats | null> {
  const db = getDb();
  const result = await db.execute(sql`SELECT * FROM mv_national_stats WHERE id = 1`);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    total: num(row.total),
    active: num(row.active),
    needsVerification: num(row.needs_verification),
    free: num(row.free),
    paid: num(row.paid),
    restricted: num(row.restricted),
    school: num(row.school),
    litTrue: num(row.lit_true),
    litKnown: num(row.lit_known),
    litUnknown: num(row.lit_unknown),
    municipalitiesCovered: num(row.municipalities_covered),
    sportsCount: num(row.sports_count),
    // pg returns timestamptz as a Date; emit a stable ISO string for the API.
    generatedAt: new Date(row.generated_at as string | number | Date).toISOString(),
  };
}

export async function getMunicipalityStats(): Promise<MunicipalityStat[]> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT ekatte_code, name_bg, name_en, total, active, needs_verification,
           free, lit_true, lit_known, population, per_10k
    FROM mv_municipality_stats
    ORDER BY total DESC, name_bg
  `);
  return result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      ekatteCode: String(row.ekatte_code),
      nameBg: String(row.name_bg),
      nameEn: String(row.name_en),
      total: num(row.total),
      active: num(row.active),
      needsVerification: num(row.needs_verification),
      free: num(row.free),
      litTrue: num(row.lit_true),
      litKnown: num(row.lit_known),
      population: numOrNull(row.population),
      per10k: numOrNull(row.per_10k),
    };
  });
}

export async function getSportStats(): Promise<SportStat[]> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT sport, total FROM mv_sport_stats ORDER BY total DESC, sport
  `);
  return result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return { sport: String(row.sport), total: num(row.total) };
  });
}

export async function getStatsSnapshot(): Promise<StatsSnapshot> {
  const [national, municipalities, sports] = await Promise.all([
    getNationalStats(),
    getMunicipalityStats(),
    getSportStats(),
  ]);
  return { national, municipalities, sports };
}
