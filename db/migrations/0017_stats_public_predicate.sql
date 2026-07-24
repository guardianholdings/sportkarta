-- 0017_stats_public_predicate: align the statistics materialized views with
-- PUBLIC_FACILITY_PREDICATE (status <> 'gone' AND slug IS NOT NULL).
--
-- 0004 filtered on status <> 'gone' alone, but the map, the API, the SEO pages
-- and the open-data export all share the stricter predicate from
-- lib/src/opendata/schema.ts — a slugless row has no public page and no pin.
-- One active null-slug row therefore made /api/stats count a facility the map
-- does not show (audit 2026-07-24, AUDIT-F2), and the platform's own standard
-- is "count the pins and get the same number". Every production writer slugs
-- its rows, so the figures are unchanged in practice; this closes the edge.
--
-- Matviews cannot be ALTERed into a new definition, so this is DROP + CREATE —
-- the definitions below are 0004's verbatim except for the predicate. Views are
-- created WITH DATA (the default), so they are populated on migrate; the UNIQUE
-- indexes are recreated because REFRESH MATERIALIZED VIEW CONCURRENTLY (the
-- stats.refresh job) requires them. /statistika and /api/stats read through
-- these names and see only the recreated views.
--
-- rollback (compensating SQL): re-run 0004's CREATE MATERIALIZED VIEW block
-- after DROP MATERIALIZED VIEW mv_sport_stats, mv_municipality_stats,
-- mv_national_stats;
DROP MATERIALIZED VIEW "mv_sport_stats";--> statement-breakpoint
DROP MATERIALIZED VIEW "mv_municipality_stats";--> statement-breakpoint
DROP MATERIALIZED VIEW "mv_national_stats";--> statement-breakpoint

-- ─── National totals (single row) ──────────────────────────────────────────
CREATE MATERIALIZED VIEW "mv_national_stats" AS
SELECT
  1 AS id,
  count(*) AS total,
  count(*) FILTER (WHERE status = 'active') AS active,
  count(*) FILTER (WHERE status = 'needs_verification') AS needs_verification,
  count(*) FILTER (WHERE access = 'free') AS free,
  count(*) FILTER (WHERE access = 'paid') AS paid,
  count(*) FILTER (WHERE access = 'restricted') AS restricted,
  count(*) FILTER (WHERE access = 'school') AS school,
  count(*) FILTER (WHERE lighting IS TRUE) AS lit_true,
  count(*) FILTER (WHERE lighting IS NOT NULL) AS lit_known,
  count(*) FILTER (WHERE lighting IS NULL) AS lit_unknown,
  count(DISTINCT municipality_id) FILTER (WHERE municipality_id IS NOT NULL) AS municipalities_covered,
  (
    SELECT count(DISTINCT s.sport)
    FROM facilities f2, LATERAL unnest(f2.sport_types) AS s(sport)
    WHERE f2.status <> 'gone' AND f2.slug IS NOT NULL
  ) AS sports_count,
  -- Evaluated at each REFRESH, so it reports when the stats were last built.
  now() AS generated_at
FROM facilities
WHERE status <> 'gone' AND slug IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mv_national_stats_id" ON "mv_national_stats" ("id");--> statement-breakpoint

-- ─── Per-municipality (only municipalities with ≥1 public facility) ─────────
CREATE MATERIALIZED VIEW "mv_municipality_stats" AS
SELECT
  m.id AS municipality_id,
  m.ekatte_code,
  m.name_bg,
  m.name_en,
  count(*) AS total,
  count(*) FILTER (WHERE f.status = 'active') AS active,
  count(*) FILTER (WHERE f.status = 'needs_verification') AS needs_verification,
  count(*) FILTER (WHERE f.access = 'free') AS free,
  count(*) FILTER (WHERE f.lighting IS TRUE) AS lit_true,
  count(*) FILTER (WHERE f.lighting IS NOT NULL) AS lit_known,
  p.population,
  CASE
    WHEN p.population IS NOT NULL AND p.population > 0
    THEN round(count(*)::numeric * 10000 / p.population::numeric, 2)
    ELSE NULL
  END AS per_10k
FROM municipalities m
JOIN facilities f ON f.municipality_id = m.id AND f.status <> 'gone' AND f.slug IS NOT NULL
LEFT JOIN municipality_population p ON p.ekatte_code = m.ekatte_code
GROUP BY m.id, m.ekatte_code, m.name_bg, m.name_en, p.population;--> statement-breakpoint
CREATE UNIQUE INDEX "mv_municipality_stats_municipality_id" ON "mv_municipality_stats" ("municipality_id");--> statement-breakpoint

-- ─── Per-sport (a multi-sport facility counts once per sport) ───────────────
CREATE MATERIALIZED VIEW "mv_sport_stats" AS
SELECT s.sport, count(*) AS total
FROM facilities f, LATERAL unnest(f.sport_types) AS s(sport)
WHERE f.status <> 'gone' AND f.slug IS NOT NULL
GROUP BY s.sport;--> statement-breakpoint
CREATE UNIQUE INDEX "mv_sport_stats_sport" ON "mv_sport_stats" ("sport");
