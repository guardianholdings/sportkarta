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
-- THIS IS A RELABELLING, NOT A TAKEDOWN. `PUBLIC_FACILITY_PREDICATE` hides only
-- `gone` and slug-less rows, so both facilities stay on the map, in /igrishta
-- and in the open-data export; what changes is that they now carry the "awaiting
-- verification" badge and enter the ambassador queue, which is where an
-- unconfirmed claim belongs.
--
-- CONVERGENT, NOT ORDER-DEPENDENT. Production runs `migrate` then `seed`: if the
-- rows exist this corrects them, and if they do not it updates zero rows and the
-- seed inserts them as `needs_verification` moments later. Same end state.
--
-- WHY IT CANNOT FIGHT A HUMAN. Both routes to `active` — the on-site crowd
-- verification and a moderator's decision — require the row to already BE
-- `needs_verification`, so while these rows are `active` no verification can
-- even be in flight, and this migration runs exactly once. A later genuine
-- verification is therefore never reverted.
--
-- NOT deleted, deliberately: `facility_edits` is append-only and references
-- facilities ON DELETE RESTRICT, and a place that plausibly exists belongs in
-- the verification queue rather than erased from the record.
--
-- NO matview REFRESH here, deliberately: this shifts two rows across the
-- active/needs_verification counters in `mv_national_stats` and the municipality
-- views, and both are refreshed by the seed step that follows this migration in
-- the deploy and again by the worker every 15 minutes. A REFRESH inside the
-- migration would be wrong twice: CONCURRENTLY cannot run in the migrator's
-- transaction, and the plain form takes ACCESS EXCLUSIVE and would block
-- /statistika for its duration.
--
-- Rollback (DESTRUCTIVE — re-publishes an unverified claim as verified; the
-- guards matter, or this resurrects a facility a moderator confirmed is gone):
--   UPDATE facilities SET status = 'active'
--    WHERE id IN ('00000000-0000-4000-8000-000000000006',
--                 '00000000-0000-4000-8000-000000000007')
--      AND attrs->>'seed' = 'true'
--      AND status = 'needs_verification';

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
-- One statement so the audit row is written for exactly the rows that actually
-- changed — zero of them on a database seeded by the current code.
--
-- `actor` is NULL and that is load-bearing, not stylistic: the facility page
-- computes "last verified" as max(created_at) over edits WHERE actor IS NOT
-- NULL, so an attributed row would make this facility announce a verification
-- date on the very row this migration exists to mark UNVERIFIED. NULL actor is
-- also the established encoding for institutional, non-person writes.
WITH corrected AS (
  UPDATE "facilities"
     SET "status" = 'needs_verification'
   WHERE "id" IN (
           '00000000-0000-4000-8000-000000000006'::uuid,
           '00000000-0000-4000-8000-000000000007'::uuid
         )
     AND "attrs"->>'seed' = 'true'
     AND "status" = 'active'
  RETURNING "id"
)
INSERT INTO "facility_edits" ("facility_id", "actor", "source", "field", "old_value", "new_value")
SELECT "id", NULL, 'crowd', 'status', '"active"'::jsonb, '"needs_verification"'::jsonb
  FROM corrected;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
