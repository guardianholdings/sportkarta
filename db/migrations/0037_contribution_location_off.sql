-- A contribution made with location OFF was recorded as made 1 000 km away.
-- This puts back the NULL that 0029 reserves for exactly that case.
--
-- WHAT HAPPENED. From the day 0029 went live (2026-08-09, with production
-- itself) until the UX audit fix (PR #29, 2026-10-10), parseCoordinates in
-- apps/web/lib/contributions/proximity.ts read a blank coordinate as zero:
-- `Number('') === 0` and `Number(null) === 0`, both finite and in range. A
-- member who added, verified, condition-reported or reported a problem with a
-- facility WITHOUT sharing a location — permission declined, a desktop with no
-- fix, a timeout — was placed at 0°N 0°E in the Gulf of Guinea, more than
-- 5 000 km from any Bulgarian facility, and the distance was written at the
-- clamp: 1 000 000 m. The member was told «бяхте на 1000 км от обекта», and
-- every admin surface that shows the distance (/admin/redakcii, a facility's
-- history, an account's page) still says so. The check-in path has its own
-- parser, which got this right, so play_session_checkins is not touched; nor is
-- training_logs, whose distance_m is the distance trained.
--
-- WHY NULL. 0029 is explicit that these are different facts: NULL = "no position
-- was offered", a large number = "we know where they were and it was not
-- here", and "a later report that conflated them would be wrong". These rows
-- are the first fact recorded as the second.
--
-- WHAT CHANGES, AND NOTHING ELSE. `distance_m` only, only where it equals the
-- clamp; in facility_edits only on crowd rows (every writer of the column is a
-- crowd contribution path; importers, the seed, the admin editor, moderation
-- and reverts never write it). No DECISION moves: NULL and 1 000 000 are both
-- off-site (isOnSite), so no points (the ledger is append-only and was written
-- at the time anyway), no status and no verification evidence
-- (VERIFICATION_EVIDENCE requires distance_m <= 250) change. Only the label
-- does: «1000 км от мястото» becomes «без местоположение».
--
-- THE ONE AMBIGUITY, ACCEPTED. The clamp also caught GENUINE readings 1 000 km
-- or more from the facility — a member abroad, or a desktop's IP-derived fix
-- that far off. The coordinates were never stored (0029, by design), so they
-- cannot be told apart from the zeros now, and they are cleared too. Bulgaria
-- is about 520 km across at its widest, so a reading that far from one of its
-- facilities says nothing about the place either way; it was already scored as
-- off-site, and "no location" describes it honestly. For the same reason there
-- is no cutoff date: a genuine reading written by the fixed parser before this
-- deploy is cleared on the same terms. The column comments below record this
-- in the catalogue, where `\d+` shows it to anyone who never opens this file.
--
-- ORDER. This branch is stacked on PR #29, which carries the parser fix, so
-- 0037 cannot reach production before the fixed parser does. If both first
-- ship in the same deploy, the one gap is the seconds between `migrate` and
-- `up -d` (deploy.yml), while the previous web container still serves: a
-- contribution made with location off in those seconds keeps its 1 000 000.
-- From this migration on, 1 000 000 means what 0029 says.
--
-- THE APPEND-ONLY TRIGGER. facility_edits refuses every UPDATE
-- (facility_edits_no_update, 0001). This migration lifts exactly that one
-- trigger around one statement and restores it before the transaction ends.
-- ALTER TABLE ... DISABLE TRIGGER is transactional and takes SHARE ROW
-- EXCLUSIVE, so no other session ever sees the trigger disabled, and no other
-- writer can reach the table until the transaction commits. The no_delete and
-- no_truncate triggers are never touched. Each row's audit meaning — who
-- changed which field, from what, to what, and when — is untouched;
-- `distance_m` is a measurement taken alongside it, and is corrected because
-- it was mis-measured. If ANY statement of the batch fails, everything rolls
-- back and the trigger was never off. That atomicity is the MIGRATOR's
-- transaction: never run this file by hand in autocommit psql, where SET LOCAL
-- does nothing and the DISABLE would commit on its own.
--
-- LOCKING. facility_reports goes first, under row locks only, so the
-- facility_edits write lock covers no wait but its own. SHARE ROW EXCLUSIVE on
-- facility_edits conflicts with writers only — not with readers, and not with
-- the nightly pg_dump's ACCESS SHARE — so the map and the admin screens keep
-- reading; a contribution, admin edit or moderation decision that arrives
-- meanwhile waits for the commit, which follows one scan of facility_edits
-- (there is no index on distance_m to use). The COMMENTs take SHARE UPDATE
-- EXCLUSIVE, which conflicts with neither readers nor writers. Every lock
-- request is bounded by a 3 s lock_timeout, as in 0029: a deploy that meets a
-- long writer stops before `up -d`, the previous stack keeps serving, and the
-- deploy can simply be re-run. The migrator runs the whole pending batch in ONE
-- transaction, so a SET LOCAL leaks into the next file; the last statement
-- resets it, as 0020..0036 do.
--
-- CONVERGENT. On an empty database (CI, `pnpm db:reset`) nothing matches and
-- only the comments change.
--
-- Rollback (DESTRUCTIVE in the other direction: it writes the wrong distance
-- back). BY ID ONLY. A created_at window cannot find these rows: the admin
-- editor, moderation decisions, reverts of crowd edits, «вече го няма» claims
-- and 0030/0031's audit rows all have a NULL distance by design (most of them
-- source = 'crowd'), as do the verify path's does_not_exist reports, and a
-- window would stamp «1000 км» on rows nobody ever measured. Take the ids from
-- the last nightly dump before this deploy (on the server, kept 14 days — see
-- deploy/RESTORE.md), restored into a scratch database:
--   SELECT id FROM facility_edits   WHERE distance_m = 1000000 AND source = 'crowd';
--   SELECT id FROM facility_reports WHERE distance_m = 1000000;
-- then, in production:
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   ALTER TABLE facility_edits DISABLE TRIGGER facility_edits_no_update;
--   UPDATE facility_edits SET distance_m = 1000000
--    WHERE id = ANY('{…}'::bigint[]) AND distance_m IS NULL;
--   ALTER TABLE facility_edits ENABLE TRIGGER facility_edits_no_update;
--   UPDATE facility_reports SET distance_m = 1000000
--    WHERE id = ANY('{…}'::uuid[]) AND distance_m IS NULL;
--   COMMIT;
-- Rows written between that dump and this deploy cannot be recovered this way.
-- The column comments may stay: they describe the rows either way.

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
UPDATE "facility_reports"
   SET "distance_m" = NULL
 WHERE "distance_m" = 1000000;--> statement-breakpoint
COMMENT ON COLUMN "facility_reports"."distance_m" IS
  'Metres between the reporter and the facility when the report was filed. NULL = no position offered; never a coordinate. On reports filed before migration 0037, NULL can also be a reading 1 000 km or more away: 0037 cleared the clamp, where a bug had put every missing position, and genuine far readings could not be told apart.';--> statement-breakpoint
ALTER TABLE "facility_edits" DISABLE TRIGGER "facility_edits_no_update";--> statement-breakpoint
UPDATE "facility_edits"
   SET "distance_m" = NULL
 WHERE "distance_m" = 1000000
   AND "source" = 'crowd';--> statement-breakpoint
ALTER TABLE "facility_edits" ENABLE TRIGGER "facility_edits_no_update";--> statement-breakpoint
COMMENT ON COLUMN "facility_edits"."distance_m" IS
  'Metres between the contributor and the facility when the claim was made. NULL = no position offered; never a coordinate. Evidence, not proof — see apps/web/lib/contributions/proximity.ts. On rows written before migration 0037, NULL can also be a reading 1 000 km or more away: 0037 cleared the clamp, where a bug had put every missing position, and genuine far readings could not be told apart.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
