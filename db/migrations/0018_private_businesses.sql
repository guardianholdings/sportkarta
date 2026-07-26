-- 0018_private_businesses: commercial (access='paid') venues become an
-- admin-gated category, toggled per BUSINESS, not per spot.
--
-- WHY. The corpus is gaining private venues (gyms, studios, dojos — OSM
-- already maps access=customers / fee=yes / leisure=sports_centre to 'paid').
-- The operator decides whether that category appears on the public site at
-- all (one master switch), and beneath it whether a given BUSINESS appears —
-- a chain with thirty locations is one decision, never thirty. Visibility is
-- part of PUBLIC_FACILITY_PREDICATE (lib/src/opendata/schema.ts), so the map,
-- the API, the SEO pages, the open-data dumps and the stats views all agree:
-- with the master switch off (the default) a paid row is public NOWHERE.
--
-- Three objects:
--   app_settings — one-row-per-key operator switches. Key 'public_show_paid'
--     is the master toggle, seeded 'false'. DELIBERATE figure change: paid
--     rows previously counted in the stats views; with the switch off they
--     leave the public corpus entirely, so /statistika totals drop by the
--     paid count at the next refresh and the views' `paid` column now means
--     "paid facilities currently displayed", not "paid rows in the table".
--     That is the product decision this migration exists to make: the public
--     corpus is free public infrastructure unless the operator opts the
--     commercial category in.
--   businesses — the toggle unit. normalized_key groups spots that belong to
--     one operator (brand > operator > name, lowercased/trimmed — the same
--     precedence the backfill and the importer use), so re-imports attach to
--     the same row instead of minting duplicates. Institutional names only
--     (OSM brand/operator tags) — no person resolves from this table, and it
--     is deliberately NOT on the open-data ALLOWED_RELATIONS.
--   facilities.business_id — nullable: a paid row with no recognisable
--     business (no brand, no operator, no name) rides the master switch
--     alone — visible whenever the category is on, since there is no
--     business row to toggle it by. The nullif-normalised key below keeps
--     that set to genuinely anonymous rows.
--
-- The three stats matviews are recreated with the new predicate (matviews
-- cannot be ALTERed; definitions are 0017's verbatim except the paid gate).
-- A toggle flip reaches /statistika at the next stats.refresh run — the same
-- eventual consistency every other facility edit already has.
--
-- rollback (compensating SQL): re-run 0017's matview block; then
--   ALTER TABLE facilities DROP COLUMN business_id;
--   DROP TABLE businesses; DROP TABLE app_settings;

CREATE TABLE "app_settings" (
  "key" text PRIMARY KEY,
  "value" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  -- The toggle is read as text = 'true'; make the invalid spelling unrepresentable.
  CONSTRAINT "app_settings_bool_keys" CHECK ("key" <> 'public_show_paid' OR "value" IN ('true', 'false'))
);--> statement-breakpoint

INSERT INTO "app_settings" ("key", "value") VALUES ('public_show_paid', 'false');--> statement-breakpoint

CREATE TABLE "businesses" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "name" text NOT NULL,
  "normalized_key" text NOT NULL UNIQUE,
  "visible" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "businesses_name_not_blank" CHECK (btrim("name") <> ''),
  CONSTRAINT "businesses_key_normalized" CHECK ("normalized_key" = lower(btrim("normalized_key")) AND "normalized_key" <> '')
);--> statement-breakpoint

ALTER TABLE "facilities" ADD COLUMN "business_id" bigint REFERENCES "businesses"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- Backfill: one business per distinct brand/operator/name among existing paid
-- rows. DISTINCT ON picks one display name per key (they differ only in
-- whitespace/case). Unnamed, operator-less rows keep business_id NULL.
INSERT INTO "businesses" ("name", "normalized_key")
SELECT DISTINCT ON (lower(coalesce(nullif(btrim(attrs->>'brand'), ''), nullif(btrim(attrs->>'operator'), ''), nullif(btrim(name), ''))))
       btrim(coalesce(nullif(btrim(attrs->>'brand'), ''), nullif(btrim(attrs->>'operator'), ''), nullif(btrim(name), ''))),
       lower(coalesce(nullif(btrim(attrs->>'brand'), ''), nullif(btrim(attrs->>'operator'), ''), nullif(btrim(name), '')))
FROM "facilities"
WHERE access = 'paid'
  AND coalesce(nullif(btrim(attrs->>'brand'), ''), nullif(btrim(attrs->>'operator'), ''), nullif(btrim(name), '')) IS NOT NULL
ORDER BY lower(coalesce(nullif(btrim(attrs->>'brand'), ''), nullif(btrim(attrs->>'operator'), ''), nullif(btrim(name), ''))), btrim(coalesce(nullif(btrim(attrs->>'brand'), ''), nullif(btrim(attrs->>'operator'), ''), nullif(btrim(name), ''))), id;--> statement-breakpoint

UPDATE "facilities" f
SET "business_id" = b."id"
FROM "businesses" b
WHERE f.access = 'paid'
  AND coalesce(nullif(btrim(f.attrs->>'brand'), ''), nullif(btrim(f.attrs->>'operator'), ''), nullif(btrim(f.name), '')) IS NOT NULL
  AND b."normalized_key" = lower(coalesce(nullif(btrim(f.attrs->>'brand'), ''), nullif(btrim(f.attrs->>'operator'), ''), nullif(btrim(f.name), '')));--> statement-breakpoint

-- After the backfill so the UPDATE does not pay index maintenance. Plain
-- CREATE INDEX (CONCURRENTLY is unavailable inside the transactional migrate);
-- the corpus is small enough that the SHARE lock is brief.
CREATE INDEX "facilities_business_id_idx" ON "facilities" ("business_id") WHERE "business_id" IS NOT NULL;--> statement-breakpoint

-- ─── Stats matviews: 0017's definitions + the paid gate ────────────────────
DROP MATERIALIZED VIEW "mv_sport_stats";--> statement-breakpoint
DROP MATERIALIZED VIEW "mv_municipality_stats";--> statement-breakpoint
DROP MATERIALIZED VIEW "mv_national_stats";--> statement-breakpoint

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
      AND (f2.access <> 'paid' OR (EXISTS (SELECT 1 FROM app_settings st WHERE st.key = 'public_show_paid' AND st.value = 'true') AND (f2.business_id IS NULL OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = f2.business_id AND b.visible))))
  ) AS sports_count,
  -- Evaluated at each REFRESH, so it reports when the stats were last built.
  now() AS generated_at
FROM facilities
WHERE status <> 'gone' AND slug IS NOT NULL
  AND (access <> 'paid' OR (EXISTS (SELECT 1 FROM app_settings st WHERE st.key = 'public_show_paid' AND st.value = 'true') AND (facilities.business_id IS NULL OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = facilities.business_id AND b.visible))));--> statement-breakpoint
CREATE UNIQUE INDEX "mv_national_stats_id" ON "mv_national_stats" ("id");--> statement-breakpoint

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
  AND (f.access <> 'paid' OR (EXISTS (SELECT 1 FROM app_settings st WHERE st.key = 'public_show_paid' AND st.value = 'true') AND (f.business_id IS NULL OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = f.business_id AND b.visible))))
LEFT JOIN municipality_population p ON p.ekatte_code = m.ekatte_code
GROUP BY m.id, m.ekatte_code, m.name_bg, m.name_en, p.population;--> statement-breakpoint
CREATE UNIQUE INDEX "mv_municipality_stats_municipality_id" ON "mv_municipality_stats" ("municipality_id");--> statement-breakpoint

CREATE MATERIALIZED VIEW "mv_sport_stats" AS
SELECT s.sport, count(*) AS total
FROM facilities f, LATERAL unnest(f.sport_types) AS s(sport)
WHERE f.status <> 'gone' AND f.slug IS NOT NULL
  AND (f.access <> 'paid' OR (EXISTS (SELECT 1 FROM app_settings st WHERE st.key = 'public_show_paid' AND st.value = 'true') AND (f.business_id IS NULL OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = f.business_id AND b.visible))))
GROUP BY s.sport;--> statement-breakpoint
CREATE UNIQUE INDEX "mv_sport_stats_sport" ON "mv_sport_stats" ("sport");
