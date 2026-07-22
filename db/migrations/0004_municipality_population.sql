-- 0004_municipality_population: population table (drizzle) + public-statistics
-- materialized views (hand-written, like the 0001 triggers — drizzle does not
-- model matviews). The views power /statistika + /api/stats and are refreshed
-- by the pg-boss `stats.refresh` job (apps/worker) via REFRESH MATERIALIZED
-- VIEW CONCURRENTLY, which requires the UNIQUE indexes below. Views are created
-- WITH DATA, so they are populated immediately on migrate.
--
-- Visibility mirrors the public rule everywhere: status <> 'gone'. Percentages
-- keep numerator + denominator so the app renders "n/a" when a denominator is
-- 0/unknown; per_10k is NULL when the municipality has no population row (never
-- estimated).
--
-- rollback (compensating SQL, reverse order):
--   DROP MATERIALIZED VIEW mv_sport_stats, mv_municipality_stats, mv_national_stats;
--   DROP TABLE "municipality_population";
CREATE TABLE "municipality_population" (
	"ekatte_code" text PRIMARY KEY NOT NULL,
	"population" integer NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "municipality_population_positive" CHECK ("municipality_population"."population" > 0),
	CONSTRAINT "municipality_population_source_not_blank" CHECK (btrim("municipality_population"."source") <> '')
);
--> statement-breakpoint
ALTER TABLE "municipality_population" ADD CONSTRAINT "municipality_population_ekatte_code_municipalities_ekatte_code_fk" FOREIGN KEY ("ekatte_code") REFERENCES "public"."municipalities"("ekatte_code") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

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
    WHERE f2.status <> 'gone'
  ) AS sports_count,
  -- Evaluated at each REFRESH, so it reports when the stats were last built.
  now() AS generated_at
FROM facilities
WHERE status <> 'gone';--> statement-breakpoint
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
JOIN facilities f ON f.municipality_id = m.id AND f.status <> 'gone'
LEFT JOIN municipality_population p ON p.ekatte_code = m.ekatte_code
GROUP BY m.id, m.ekatte_code, m.name_bg, m.name_en, p.population;--> statement-breakpoint
CREATE UNIQUE INDEX "mv_municipality_stats_municipality_id" ON "mv_municipality_stats" ("municipality_id");--> statement-breakpoint

-- ─── Per-sport (a multi-sport facility counts once per sport) ───────────────
CREATE MATERIALIZED VIEW "mv_sport_stats" AS
SELECT s.sport, count(*) AS total
FROM facilities f, LATERAL unnest(f.sport_types) AS s(sport)
WHERE f.status <> 'gone'
GROUP BY s.sport;--> statement-breakpoint
CREATE UNIQUE INDEX "mv_sport_stats_sport" ON "mv_sport_stats" ("sport");