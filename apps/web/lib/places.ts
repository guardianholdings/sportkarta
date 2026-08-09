import { getDb, publicFacilityVisible, sql, type SQL } from '@sportkarta/db';
import { assignCitySlugs, type City, type MunicipalityRow } from '@sportkarta/lib/cities';
import { slugify } from '@sportkarta/lib/slug';
import { CANONICAL_SPORTS } from '@sportkarta/lib/sports';

// Only canonical sports get their own /igrishta/[city]/[sport] page (the
// [segment] route allowlists them). Any stray non-canonical value in
// sport_types must NOT be emitted as a sitemap URL or cross-link, or it would
// point at a page that 404s.
const CANONICAL_SPORT_SET = new Set<string>(CANONICAL_SPORTS);

// City identity (slugs, display names) lives in @sportkarta/lib/cities: the
// worker needs the same slugs for the digest email, and two implementations of
// the collision rule would drift.
export { assignCitySlugs, cityDisplayName } from '@sportkarta/lib/cities';
export type { City, MunicipalityRow } from '@sportkarta/lib/cities';

/**
 * Data layer for the programmatic "places" pages (/igrishta/[city]/...).
 * Server-only. A "city" is a municipality; its URL slug is derived from the
 * Bulgarian name (transliterated, collision-suffixed) since municipalities have
 * no slug column. Well-known cities get an override so, e.g., Sofia's
 * "Столична" municipality reads `sofia` / "София" rather than `stolichna`.
 */

interface CityCatalog {
  bySlug: Map<string, City>;
  byId: Map<number, City>;
  all: City[];
}

let catalogCache: CityCatalog | null = null;

/** Load + cache the city catalog. Municipalities are static after import. */
export async function loadCityCatalog(): Promise<CityCatalog> {
  if (catalogCache) return catalogCache;
  const db = getDb();
  const result = await db.execute(sql`SELECT id, name_bg, name_en FROM municipalities ORDER BY id`);
  const cities = assignCitySlugs(result.rows as unknown as MunicipalityRow[]);

  const bySlug = new Map<string, City>();
  const byId = new Map<number, City>();
  for (const city of cities) {
    bySlug.set(city.slug, city);
    byId.set(city.id, city);
  }

  catalogCache = { bySlug, byId, all: cities };
  return catalogCache;
}

export async function getCityBySlug(slug: string): Promise<City | null> {
  const { bySlug } = await loadCityCatalog();
  return bySlug.get(slug) ?? null;
}

export interface ScopeOptions {
  sport?: string;
  quarter?: string;
}

// Public base + city scope + optional sport (array-overlap) / quarter filter.
function scopeConditions(cityId: number, opts: ScopeOptions): SQL {
  const conditions: SQL[] = [publicFacilityVisible, sql`f.municipality_id = ${cityId}`];
  if (opts.sport) conditions.push(sql`f.sport_types && ARRAY[${opts.sport}]::text[]`);
  if (opts.quarter) conditions.push(sql`f.quarter = ${opts.quarter}`);
  return sql.join(conditions, sql` AND `);
}

export interface ScopedFacility {
  slug: string;
  name: string | null;
  sportTypes: string[];
  lon: number;
  lat: number;
}

// Cap the embedded scoped set: keeps the SSR payload bounded even for large
// cities (Sofia has ~1.7k facilities) while still showing density on the map.
export const SCOPE_LIMIT = 500;

export async function scopedFacilityCount(
  cityId: number,
  opts: ScopeOptions = {},
): Promise<number> {
  const db = getDb();
  const result = await db.execute(
    sql`SELECT count(*)::int AS n FROM facilities f WHERE ${scopeConditions(cityId, opts)}`,
  );
  return Number((result.rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

export async function scopedFacilities(
  cityId: number,
  opts: ScopeOptions = {},
  limit = SCOPE_LIMIT,
): Promise<ScopedFacility[]> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT f.slug, f.name, f.sport_types, ST_X(f.geom) AS lon, ST_Y(f.geom) AS lat
    FROM facilities f
    WHERE ${scopeConditions(cityId, opts)}
    ORDER BY f.name NULLS LAST, f.id
    LIMIT ${limit}
  `);
  return result.rows.map((r) => {
    const row = r as Record<string, unknown>;
    return {
      slug: String(row.slug),
      name: (row.name as string | null) ?? null,
      sportTypes: (row.sport_types as string[] | null) ?? [],
      lon: Number(row.lon),
      lat: Number(row.lat),
    };
  });
}

export interface SportCount {
  sport: string;
  count: number;
}

/** Per-sport counts within a city — powers the intro stats + cross-links. */
export async function citySportCounts(cityId: number): Promise<SportCount[]> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT s.sport, count(*)::int AS n
    FROM facilities f, LATERAL unnest(f.sport_types) AS s(sport)
    WHERE ${publicFacilityVisible} AND f.municipality_id = ${cityId}
    GROUP BY s.sport
    ORDER BY n DESC, s.sport
  `);
  return result.rows
    .map((r) => {
      const row = r as { sport: string; n: number };
      return { sport: String(row.sport), count: Number(row.n) };
    })
    .filter((s) => CANONICAL_SPORT_SET.has(s.sport));
}

/** Cities (other than `exceptId`) that also have this sport with ≥min — for cross-links. */
export async function citiesForSport(
  sport: string,
  exceptId: number,
  min = 3,
  limit = 8,
): Promise<{ city: City; count: number }[]> {
  const db = getDb();
  const { byId } = await loadCityCatalog();
  const result = await db.execute(sql`
    SELECT f.municipality_id AS id, count(*)::int AS n
    FROM facilities f
    WHERE ${publicFacilityVisible} AND f.municipality_id IS NOT NULL
      AND f.municipality_id <> ${exceptId}
      AND f.sport_types && ARRAY[${sport}]::text[]
    GROUP BY f.municipality_id
    HAVING count(*) >= ${min}
    ORDER BY n DESC
    LIMIT ${limit}
  `);
  const out: { city: City; count: number }[] = [];
  for (const r of result.rows) {
    const row = r as { id: number; n: number };
    const city = byId.get(Number(row.id));
    if (city) out.push({ city, count: Number(row.n) });
  }
  return out;
}

/**
 * Resolve a quarter URL slug back to its stored free-text name within a city.
 * Quarters have no slug column, so we transliterate each distinct quarter and
 * match. Returns null if none matches. (Few facilities carry a quarter today;
 * this keeps the [segment] route correct once crowd/municipal data adds them.)
 */
export async function resolveQuarterSlug(cityId: number, slug: string): Promise<string | null> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT DISTINCT f.quarter FROM facilities f
    WHERE f.municipality_id = ${cityId} AND f.quarter IS NOT NULL
      AND ${publicFacilityVisible}
    ORDER BY f.quarter
  `);
  for (const r of result.rows) {
    const quarter = String((r as { quarter: string }).quarter);
    if (slugify(quarter) === slug) return quarter;
  }
  return null;
}

// ─── Sitemap sources (all filtered by the ≥min thin-content guard) ──────────

export interface SitemapEntry {
  path: string;
  lastmod: string;
}

/** City pages (/igrishta/[city]) with ≥min facilities; lastmod = newest edit. */
export async function sitemapCities(min = 3): Promise<SitemapEntry[]> {
  const db = getDb();
  const { byId } = await loadCityCatalog();
  const result = await db.execute(sql`
    SELECT f.municipality_id AS id, max(f.updated_at) AS lastmod
    FROM facilities f
    WHERE ${publicFacilityVisible} AND f.municipality_id IS NOT NULL
    GROUP BY f.municipality_id
    HAVING count(*) >= ${min}
  `);
  const entries: SitemapEntry[] = [];
  for (const r of result.rows) {
    const row = r as { id: number; lastmod: string };
    const city = byId.get(Number(row.id));
    if (city) entries.push({ path: `/igrishta/${city.slug}`, lastmod: String(row.lastmod) });
  }
  return entries;
}

/**
 * Municipality accountability pages (/obshtina/[city]).
 *
 * Same ≥min thin-content guard as the city pages, and for the same reason: a
 * municipality with two facilities produces a page of near-zeros that is
 * honest but not worth indexing. The URL still exists and still resolves — it
 * is linked from the city page and pasted into embed snippets — it is simply
 * not advertised to crawlers until there is something to read.
 */
export async function sitemapMunicipalities(min = 3): Promise<SitemapEntry[]> {
  const cities = await sitemapCities(min);
  return cities.map((entry) => ({
    path: entry.path.replace('/igrishta/', '/obshtina/'),
    lastmod: entry.lastmod,
  }));
}

/** City × sport pages with ≥min facilities. */
export async function sitemapCitySports(min = 3): Promise<SitemapEntry[]> {
  const db = getDb();
  const { byId } = await loadCityCatalog();
  const result = await db.execute(sql`
    SELECT f.municipality_id AS id, s.sport, max(f.updated_at) AS lastmod
    FROM facilities f, LATERAL unnest(f.sport_types) AS s(sport)
    WHERE ${publicFacilityVisible} AND f.municipality_id IS NOT NULL
    GROUP BY f.municipality_id, s.sport
    HAVING count(*) >= ${min}
  `);
  const entries: SitemapEntry[] = [];
  for (const r of result.rows) {
    const row = r as { id: number; sport: string; lastmod: string };
    const city = byId.get(Number(row.id));
    if (city && CANONICAL_SPORT_SET.has(String(row.sport))) {
      entries.push({
        path: `/igrishta/${city.slug}/${String(row.sport)}`,
        lastmod: String(row.lastmod),
      });
    }
  }
  return entries;
}

/** All public facility pages (/obekt/[slug]). */
export async function sitemapFacilities(): Promise<SitemapEntry[]> {
  const db = getDb();
  const result = await db.execute(sql`
    SELECT f.slug, f.updated_at AS lastmod
    FROM facilities f
    WHERE ${publicFacilityVisible}
    ORDER BY f.slug
  `);
  return result.rows.map((r) => {
    const row = r as { slug: string; lastmod: string };
    return { path: `/obekt/${String(row.slug)}`, lastmod: String(row.lastmod) };
  });
}
