-- Two seed facilities were published to the national map as `active`, which in
-- this product means somebody stood there and confirmed the place exists.
--
-- WHY THIS MIGRATION EXISTS. Rows 6 and 7 of the seed ('Фитнес на открито –
-- Гребен канал' in Пловдив, 'Стрийтбол – Морска градина' in Варна) were added
-- on 2026-08-09 for a purely technical reason: the db-backed test suites borrow
-- facilities in DISTINCT municipalities, and a seed-only CI database had all
-- five original rows in Столична, so six suites failed. They were written from
-- a map, not from the ground. Publishing them as verified overstates what is
-- known about them, on the one surface — a municipality-facing map used for
-- accountability — where that matters most.
--
-- The seed itself now inserts them as `needs_verification` (db/scripts/seed.ts),
-- but the seed is `ON CONFLICT (id) DO NOTHING` by design, so it cannot correct
-- rows that already exist. Hence this one-time forward-only correction.
--
-- WHY IT IS SAFE TO RE-RUN AND WHY IT WILL NOT FIGHT A HUMAN. The predicate is
-- narrow on purpose: the two fixed seed UUIDs, AND still carrying the seed
-- marker, AND still exactly `active`. Once a moderator verifies one of these on
-- the ground through /admin/facilities the row is `active` again — but this
-- migration has already run and will never run a second time, so a real
-- verification is never reverted. On a database where the rows do not exist
-- (a fresh install seeded by the new code) it updates zero rows and is a no-op.
--
-- NOT deleted, deliberately: `facility_edits` is append-only and references
-- facilities ON DELETE RESTRICT, and a place that plausibly exists belongs in
-- the verification queue rather than erased from the record.
--
-- Rollback (DESTRUCTIVE — re-publishes an unverified claim as verified):
--   UPDATE facilities SET status = 'active'
--    WHERE id IN ('00000000-0000-4000-8000-000000000006',
--                 '00000000-0000-4000-8000-000000000007');

UPDATE "facilities"
   SET "status" = 'needs_verification',
       "updated_at" = now()
 WHERE "id" IN (
         '00000000-0000-4000-8000-000000000006'::uuid,
         '00000000-0000-4000-8000-000000000007'::uuid
       )
   AND "attrs"->>'seed' = 'true'
   AND "status" = 'active';
