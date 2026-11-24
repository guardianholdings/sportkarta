-- 0064_club_demo_status: the status `demo` for the one shared, view-only demo
-- club for prospects. Hand-written; do not regenerate.
--
-- WHY
--
-- A prospect opens the demo club's office screens without signing in. The
-- club gets a status of its own, so every existing status filter keeps it out
-- of the public pages, the admin tabs and the worker with no further edit:
-- the render rule (clubRenderableSql) and the write rule (clubWritableSql)
-- both need status 'active', so a `demo` club is never public and never
-- writable.
--
-- WHAT THIS CHANGES
--
-- clubs_status_known gains 'demo'; the TypeScript twin is CLUB_STATUSES in
-- lib/src/clubs/access.ts. No row changes here: the demo club itself is
-- seeded separately, on the operator's OK.
--
-- Locking: the CHECK swap takes ACCESS EXCLUSIVE on clubs until COMMIT
-- (DROP CONSTRAINT holds it; NOT VALID + VALIDATE is the repo's pattern), so
-- lock_timeout bounds the wait.
--
-- Rollback, only while no club has status 'demo' (the demo purge first):
--   ALTER TABLE "clubs" DROP CONSTRAINT "clubs_status_known";
--   ALTER TABLE "clubs" ADD CONSTRAINT "clubs_status_known"
--     CHECK ("clubs"."status" IN ('pending', 'active', 'suspended', 'archived'));
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "clubs" DROP CONSTRAINT "clubs_status_known";--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_status_known" CHECK ("clubs"."status" IN ('pending', 'active', 'suspended', 'archived', 'demo')) NOT VALID;--> statement-breakpoint
ALTER TABLE "clubs" VALIDATE CONSTRAINT "clubs_status_known";--> statement-breakpoint
COMMENT ON CONSTRAINT "clubs_status_known" ON "clubs" IS
  'The closed list of club statuses; the TypeScript twin is CLUB_STATUSES in lib/src/clubs/access.ts (0064 added demo, the shared view-only demo club).';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
