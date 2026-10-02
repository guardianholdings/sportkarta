-- The five remaining seed facilities were on the national map as `active`,
-- which in this product means somebody stood there and confirmed the place.
--
-- WHY THIS MIGRATION EXISTS. Rows 1–5 of the seed ('Стрийтбол игрища –
-- Борисова градина', 'Фитнес на открито – Южен парк', 'Футболно игрище – парк
-- „Гео Милев“', 'Тенис на маса – парк „Заимов“', 'Стрийт фитнес – Студентски
-- град', all in Столична) are development fixtures. They reached production
-- because the deploy ran the full seed on every release, and there they are
-- `active`, `source = 'crowd'` — so the facility page credits them to the
-- community — and in the nightly open-data export. Their only audit row is the
-- seed's own NULL-actor 'created' (2026-08-08): nobody ever verified them. Three
-- have no other facility within 150 m, and 0030 already relabelled rows 6 and 7
-- on exactly this reasoning. Pre-launch audit finding 82; the operator approved
-- the correction on 2026-09-29.
--
-- WHAT STOPS IT RECURRING. The deploy now runs `pnpm db:seed --production`,
-- which writes only the _health row, municipality population and the stats
-- refresh (db/scripts/seed-plan.ts); the fixtures are for dev and CI only, and
-- there they are inserted as `needs_verification` from the start. So after this
-- runs, nothing re-inserts or re-activates these rows in production.
--
-- THIS IS A RELABELLING, NOT A TAKEDOWN. `PUBLIC_FACILITY_PREDICATE` hides only
-- `gone` and slug-less rows (and paid ones behind the switch), so the five stay
-- on the map with the "awaiting verification" badge and enter the ambassador
-- queue. Whether any of them is fictional — and should be `gone` — is a human
-- decision, made in moderation; it is not guessed here.
--
-- CONVERGENT, NOT ORDER-DEPENDENT. On a database that has the rows as `active`
-- this corrects them; on one seeded by the current code (CI, a fresh dev box)
-- it updates zero rows, because the seed already inserts them as
-- `needs_verification`. Same end state either way.
--
-- WHY IT CANNOT FIGHT A HUMAN. The update is guarded three ways: the fixture
-- ids, `attrs->>'seed' = 'true'`, and — stricter than 0030 — no facility_edits
-- row by a PERSON (actor IS NOT NULL). An on-site verification of an already
-- `active` row writes field edits but no status edit, so the status alone could
-- not show that someone had been there; the attributed edit does, and such a
-- row is left exactly as it is. A moderator's `gone` or a later verification is
-- never reverted either: those rows are no longer `active`.
--
-- NOT deleted, deliberately: `facility_edits` is append-only and references
-- facilities ON DELETE RESTRICT, and a place that plausibly exists belongs in
-- the verification queue rather than erased from the record.
--
-- NO matview REFRESH here, deliberately (as 0030): the seed step that follows
-- migrate in the deploy refreshes `mv_national_stats` and the municipality
-- views — `--production` keeps that step — and the worker refreshes them every
-- 15 minutes. CONCURRENTLY cannot run in the migrator's transaction, and the
-- plain form takes ACCESS EXCLUSIVE and would block /statistika.
--
-- Rollback (DESTRUCTIVE — re-publishes unverified fixtures as verified; keep
-- the guards, or this resurrects a facility a moderator confirmed is gone. The
-- audit rows this wrote stay: facility_edits is append-only):
--   UPDATE facilities SET status = 'active'
--    WHERE id IN ('00000000-0000-4000-8000-000000000001',
--                 '00000000-0000-4000-8000-000000000002',
--                 '00000000-0000-4000-8000-000000000003',
--                 '00000000-0000-4000-8000-000000000004',
--                 '00000000-0000-4000-8000-000000000005')
--      AND attrs->>'seed' = 'true'
--      AND status = 'needs_verification';

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
-- One statement so the audit row is written for exactly the rows that actually
-- changed — zero of them on a database seeded by the current code.
--
-- `actor` is NULL and that is load-bearing, not stylistic: the facility page
-- computes "last verified" as max(created_at) over edits WHERE actor IS NOT
-- NULL, so an attributed row would make these facilities announce a
-- verification date on the very row this migration exists to mark UNVERIFIED.
-- `source` is 'crowd' because that is the rows' own source, as in 0030.
WITH corrected AS (
  UPDATE "facilities" f
     SET "status" = 'needs_verification'
   WHERE f."id" IN (
           '00000000-0000-4000-8000-000000000001'::uuid,
           '00000000-0000-4000-8000-000000000002'::uuid,
           '00000000-0000-4000-8000-000000000003'::uuid,
           '00000000-0000-4000-8000-000000000004'::uuid,
           '00000000-0000-4000-8000-000000000005'::uuid
         )
     AND f."attrs"->>'seed' = 'true'
     AND f."status" = 'active'
     AND NOT EXISTS (
           SELECT 1 FROM "facility_edits" e
            WHERE e."facility_id" = f."id" AND e."actor" IS NOT NULL
         )
  RETURNING f."id"
)
INSERT INTO "facility_edits" ("facility_id", "actor", "source", "field", "old_value", "new_value")
SELECT "id", NULL, 'crowd', 'status', '"active"'::jsonb, '"needs_verification"'::jsonb
  FROM corrected;--> statement-breakpoint
-- The migrator runs the whole pending batch in ONE transaction, so a
-- SET LOCAL leaks into the next migration file; reset like 0020..0030 do.
SET LOCAL lock_timeout = DEFAULT;
