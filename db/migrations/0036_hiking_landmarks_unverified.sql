-- The twenty curated hiking landmarks were on the national map as `active`,
-- which in this product means somebody stood there and confirmed the place.
--
-- WHY THIS MIGRATION EXISTS. 0016_hiking_landmarks (2026-07-23) inserted the
-- twenty most-visited hiking landmarks of Bulgaria (Мусала, Вихрен, Черни връх
-- and the rest; every point an OSM element) with
-- `status = 'active'` written into the SQL, so that they would show on the
-- map. That was never needed: `PUBLIC_FACILITY_PREDICATE` hides only `gone`
-- and slug-less rows, so a `needs_verification` place shows too. Their only
-- audit row is 0016's own NULL-actor 'created': nobody has ever verified them,
-- and their pages say «Все още непроверено» with no «Последна проверка». Yet
-- every counter read them as verified: on 2026-10-07 they were the only
-- `active` rows in production (/api/stats: active 20), and the «Дял
-- проверени» of 13 municipality pages came from them alone. 0030 and 0031
-- corrected exactly this for the seed rows, by id, so they could not catch
-- these. Operator decision #34.2 (2026-10-07): the landmarks stay on the map,
-- awaiting confirmation.
--
-- THIS IS A RELABELLING, NOT A TAKEDOWN. The landmarks stay on the map, in
-- /igrishta and in the open-data export, now with the «Очаква проверка» badge,
-- and they join the verification queue. Nothing in the application gates on
-- `active` except the counters; the first on-site verification activates a
-- landmark, with a date and points, like any other place
-- (apps/web/lib/contributions/verify-facility.ts). From then on `active` is an
-- honest «проверени» count.
--
-- CONVERGENT, NOT ORDER-DEPENDENT. In production this corrects the twenty
-- rows. On an empty database (CI, `pnpm db:reset`) 0016 and this file run in
-- the same batch and reach the same end state: the landmarks exist as
-- `needs_verification`. 0016 itself is not edited; an applied migration never
-- is.
--
-- WHY IT CANNOT FIGHT A HUMAN. The update is guarded four ways: the curated tag
-- (`attrs->>'curated' = 'hiking_landmark'`), the rows' own `source = 'osm'`,
-- `status = 'active'`, and — as in 0031 — no facility_edits row by a PERSON
-- (actor IS NOT NULL). An on-site verification of an already `active` row
-- writes field edits but no status edit, so the attributed edit is the only
-- trace that someone has been there, and such a row is left exactly as it is.
-- A moderator's `gone` is never reverted: that row is no longer `active`.
--
-- ONE THING THIS CHANGES BEYOND THE BADGE AND THE COUNTERS. The OSM importer
-- never matches these rows as candidates (a peak or a park is not a sports
-- facility; see 0016), so no import re-activates or rewrites them. Its
-- lifecycle withdrawal, though, covers every `source = 'osm'` row that is
-- `needs_verification` (withdrawFromOsm in scripts/import-osm/src/importer.ts):
-- if OSM ever tags one of these elements abandoned/disused while it also
-- carries a tag the extract keeps (sport=*, a sports leisure), a live import
-- marks it `gone`, exactly as it would any other unverified place. While
-- `active` they were exempt. Live imports are only ever requested by hand
-- (dry-run by default, never scheduled), and the import report lists every
-- withdrawal.
--
-- THE AUDIT ROW. One per relabelled row, written by the same statement, so it
-- exists for exactly the rows that changed: the twenty in production, and the
-- same twenty on an empty database, where 0016 has just inserted them as
-- `active`. `actor` is NULL and that is load-bearing, not stylistic: «Последна
-- проверка» is dated only from a PERSON's edits (VERIFICATION_EVIDENCE,
-- apps/web/lib/public-data.ts), and this is an institutional correction, not
-- evidence. `source` is 'osm' because that is the rows' own source, as 0030
-- and 0031 used theirs.
--
-- NOT deleted, deliberately: `facility_edits` is append-only and references
-- facilities ON DELETE RESTRICT, and a landmark that exists belongs in the
-- verification queue rather than erased from the record.
--
-- NO matview REFRESH here, deliberately (as 0030 and 0031): the seed step that
-- follows migrate in the deploy refreshes `mv_national_stats` and the
-- municipality views — `--production` keeps that step — and the worker
-- refreshes them every 15 minutes. CONCURRENTLY cannot run in the migrator's
-- transaction, and the plain form takes ACCESS EXCLUSIVE and would block
-- /statistika.
--
-- LOCKING: row locks on at most twenty rows, under a 3 s lock_timeout. The
-- migrator runs the whole pending batch in ONE transaction, so a SET LOCAL
-- leaks into the next migration file; the last statement resets it, as
-- 0020..0031 do.
--
-- Rollback (DESTRUCTIVE — re-publishes unverified landmarks as verified; keep
-- the guards: a landmark someone has verified since is already `active`, and
-- one a moderator marked `gone` is not `needs_verification`, so both are left
-- alone. The audit rows this wrote stay: facility_edits is append-only):
--   UPDATE facilities SET status = 'active'
--    WHERE attrs->>'curated' = 'hiking_landmark'
--      AND source = 'osm'
--      AND status = 'needs_verification';

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
WITH corrected AS (
  UPDATE "facilities" f
     SET "status" = 'needs_verification'
   WHERE f."attrs"->>'curated' = 'hiking_landmark'
     AND f."source" = 'osm'
     AND f."status" = 'active'
     AND NOT EXISTS (SELECT 1 FROM "facility_edits" e
                      WHERE e."facility_id" = f."id" AND e."actor" IS NOT NULL)
  RETURNING f."id"
)
INSERT INTO "facility_edits" ("facility_id", "actor", "source", "field", "old_value", "new_value")
SELECT "id", NULL, 'osm', 'status', '"active"'::jsonb, '"needs_verification"'::jsonb
  FROM corrected;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
