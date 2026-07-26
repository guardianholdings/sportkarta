-- 0020_minors_as_adults: remove the minor boundary. Operator decision
-- 2026-07-25 — "minors are treated as adults".
--
-- WHAT THIS REVERSES. Three stages built the minor rule as three independent
-- layers, deliberately, because CLAUDE.md and docs/ROADMAP.md §0 called it a
-- binding legal constant:
--
--   1. 0010's CHECK `users_minor_profile_not_public` — a minor's passport
--      could not be public even with the application bypassed.
--   2. 0011's view `leaderboard_eligible_members` — `is_minor = false` as its
--      first predicate, stamped MUST NEVER BE WIDENED.
--   3. The read path: `db/src/passport.ts` re-tested `is_minor = false` in the
--      handle lookup, and `apps/web/lib/passport.ts` refused to publish.
--
-- This migration removes 1 and 2; the same commit removes 3. All three go
-- together on purpose: leaving any one in place would produce a member who is
-- told they are public, appears on no board, and whose shared link 404s. (The
-- reviewable failure mode here is the migration being SKIPPED while the app
-- commit ships — see the journal note at the bottom of this header.)
--
-- WHAT REPLACES IT: NOTHING, AND THAT IS THE POINT. Age is no longer an input
-- to any decision. What remains gating a public passport and a leaderboard row
-- is the predicate that was always doing the real work — CONSENT, the member's
-- own opt-in, DEFAULT 'private' — plus a handle to link to. The view keeps
-- both. It is now "members who chose to be public", with no age term.
--
-- WHY THE VIEW STILL EXISTS. Its `is_minor` predicate is gone but its reason
-- for being a view is not: one definition of who may appear on a public board,
-- joined by the national, per-city, per-sport and campaign slices, so a slice
-- added next year inherits consent-checking without its author knowing the
-- rule exists. The "MUST NEVER BE WIDENED" stamp is rewritten rather than
-- deleted — the consent predicate carries it now.
--
-- NO DATA MIGRATION, AND ONE DELIBERATE OMISSION. The old CHECK made
-- (is_minor, public) unconstructible, so no row needs correcting. And nothing
-- here re-publishes the passports of members whom `saveProfile` demoted to
-- private when they entered a minor's date of birth: their consent record was
-- overwritten, not merely overridden, and re-publishing a passport nobody
-- asked to re-publish would be a disclosure this migration has no mandate to
-- make. Those members can opt in again from /pasport, which is now offered to
-- them.
--
-- is_minor SURVIVES AS A COLUMN AND GATES NOTHING. Dropping it is forward-only
-- and unrecoverable (the DOB it came from was discarded — lib/src/age.ts), and
-- lib/src/reports/grant.ts records that a youth participation figure is "one
-- catalogue entry if ММС ever requires it", which needs the column. The
-- profile form keeps deriving it and keeps discarding the date;
-- apps/web/tests/dob-not-persisted.test.ts is untouched by this migration and
-- still passes.
--
-- LOCKING, STATED PRECISELY. Two statements here take a lock that can block
-- live traffic, and the guards are therefore the FIRST things in the file —
-- before any of them, which is the whole point of the 0010 pattern:
--
--   * CREATE OR REPLACE VIEW takes ACCESS EXCLUSIVE on THE VIEW (not merely a
--     catalog read of `users`) and holds it until COMMIT, because drizzle runs
--     every migration in ONE transaction. db/src/leaderboard.ts and
--     db/src/campaigns.ts read this view on public pages, so an unbounded wait
--     here would queue behind an in-flight reader AND block every reader
--     arriving after it — the public leaderboard and campaign standings would
--     hang for as long as the deploy step did. lock_timeout bounds the wait to
--     3s; the hold is milliseconds of catalog work.
--   * ALTER TABLE … DROP CONSTRAINT takes ACCESS EXCLUSIVE on `users`, which
--     blocks READS — i.e. every signed-in request. It is catalog-only (no scan,
--     no rewrite) and is placed at the END with the two COMMENTs, the 0008/
--     0009/0010 house rule, so the window is the last few ms of the
--     transaction.
--
-- SET LOCAL, NOT SET, AND RESET AT THE END. `SET` is session-scoped and would
-- outlive this file; `SET LOCAL` dies at COMMIT. But COMMIT here is the end of
-- the WHOLE migration run, so on a fresh database (CI, db:reset) these values
-- would still apply to every migration that runs after this one — a future
-- backfill would silently inherit a 30 s statement_timeout and abort halfway.
-- Hence the explicit reset to DEFAULT as the last statements: the guards cover
-- exactly this migration and nothing else.
--
-- rollback (compensating SQL — RE-IMPOSES the boundary). Run the DETECTION
-- query first: the ADD CONSTRAINT full-scans `users` under ACCESS EXCLUSIVE and
-- will FAIL if any minor has published a passport since, which is correct
-- behaviour — the operator must decide what happens to those members before the
-- CHECK can come back. The comments are restored too, or a rolled-back database
-- would document the opposite of what it enforces.
--   -- 1. who blocks the rollback:
--   SELECT id FROM users WHERE is_minor AND profile_visibility <> 'private';
--   -- 2. the operator's decision, if it is to un-publish them:
--   UPDATE users SET profile_visibility = 'private' WHERE is_minor;
--   -- 3. the rollback itself (same lock guards as the forward migration):
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   CREATE OR REPLACE VIEW "leaderboard_eligible_members" WITH (security_invoker = true) AS
--     SELECT u.id, u.public_handle, u.display_name, u.home_city FROM users u
--     WHERE u.is_minor = false AND u.profile_visibility = 'public'
--       AND u.public_handle IS NOT NULL;
--   COMMENT ON VIEW "leaderboard_eligible_members" IS 'The ONE definition of who may appear on a public leaderboard: not a minor (binding legal constant), has opted their passport public, and has a handle to link to. MUST NEVER BE WIDENED.';
--   ALTER TABLE "users" ADD CONSTRAINT "users_minor_profile_not_public"
--     CHECK ("users"."profile_visibility" = 'private' OR NOT "users"."is_minor");
--   COMMENT ON COLUMN "users"."is_minor" IS 'Derived once from a date of birth that is never persisted. Gates minor protections (no individual public leaderboards).';
--   COMMENT ON COLUMN "users"."profile_visibility" IS 'Opt-in only: DEFAULT private. A minor can never be non-private (users_minor_profile_not_public, written as an allowlist so a future enum value stays forbidden until deliberately permitted) — CLAUDE.md, no individual public exposure of minors.';
--   SET LOCAL lock_timeout = DEFAULT;
--   SET LOCAL statement_timeout = DEFAULT;
--
-- JOURNAL NOTE (why `when` in meta/_journal.json was hand-stamped). The
-- migrator applies a file only when its journal `when` is GREATER than the
-- newest `created_at` already in drizzle.__drizzle_migrations — it never looks
-- at file order or hashes. 0019 was hand-stamped 1785066000000, which is ahead
-- of the wall clock this migration was generated at, so drizzle-kit's real-time
-- stamp would have been LOWER and this migration would have been silently
-- skipped on any database that already had 0019 (exit code 0, deploy green,
-- production left in exactly the half-state this header forbids). idx 20 is
-- therefore stamped 1785069600000. Every later migration must keep clearing
-- that bar.

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE OR REPLACE VIEW "leaderboard_eligible_members" WITH (security_invoker = true) AS
SELECT
  u.id,
  u.public_handle,
  u.display_name,
  u.home_city
FROM users u
WHERE u.profile_visibility = 'public'
  AND u.public_handle IS NOT NULL;--> statement-breakpoint
COMMENT ON VIEW "leaderboard_eligible_members" IS 'The ONE definition of who may appear on a public leaderboard: has opted their passport public (appearing on a ranked public list is individual public exposure and needs consent), and has a handle to link to. Age is NOT a condition — the minor exclusion was removed by 0020 (operator decision 2026-07-25, minors are treated as adults). Every leaderboard slice joins this view rather than users, so a new slice inherits the consent rule. MUST NEVER BE WIDENED: what is left is a consent record, and adding members to it is publishing people who did not ask to be published.';--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_minor_profile_not_public";--> statement-breakpoint
COMMENT ON COLUMN "users"."is_minor" IS 'Derived once from a date of birth that is never persisted (lib/src/age.ts). GATES NOTHING since 0020 (operator decision 2026-07-25 — minors are treated as adults): no CHECK, no view predicate and no read path reads it. Kept because dropping a column is unrecoverable and a youth participation figure in the MMC annex would need it. Do not gate on it again without reversing 0020.';--> statement-breakpoint
COMMENT ON COLUMN "users"."profile_visibility" IS 'Opt-in only: DEFAULT private, and the ONLY gate on a public passport since 0020 removed the minor exclusion. A public passport is an act, not a setting somebody forgot to turn off.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
