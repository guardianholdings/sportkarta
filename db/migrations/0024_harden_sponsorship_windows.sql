-- 0024_harden_sponsorship_windows: two constraint corrections on the tables 0021
-- and 0023 created, from the db-migration-reviewer pass on those files.
--
-- WHY A NEW MIGRATION RATHER THAN AN EDIT. 0021 and 0023 had already been applied
-- to a live (dev) database when the review landed. Editing an applied file makes
-- the file and the database disagree while the journal claims otherwise, which is
-- exactly the class of drift 0020's header warns about — so the correction goes
-- forward, the house rule, even though the tables are days old.
--
-- 1. `isfinite()` ON BOTH WINDOWS. Both tables were documented as "always
--    bounded", enforced with NOT NULL plus `ends_on >= starts_on`. That is not
--    bounded: `date 'infinity'` satisfies it, and then reaches
--    `daterange(starts_on, ends_on, '[]')` in the exclusion constraints, whose
--    INCLUSIVE upper bound cannot be canonicalised — so an infinite window would
--    fail as a range error rather than a constraint violation, and a
--    '2999-12-31' window would quietly become the standing claim over public
--    infrastructure that the bounded-window rule exists to prevent. A calendar
--    cap (say three years) was considered and NOT added: how long a sponsorship
--    may run is the operator's commercial decision, not the schema's.
--
-- 2. `btrim()` ON `ad_placements.creative_path`. It read `creative_path <> ''`,
--    so a whitespace-only storage key passed while the alt-text checks beside it
--    rejected one — 0019's `partners_logo_path_sane` parity, and a key that is
--    all spaces is a 404 on a paid surface.
--
-- NO DATA REPAIR NEEDED, and this is checked rather than assumed: the tables are
-- new, and both are empty or hold only rows the application wrote through
-- `buildAdPlacementInput` / `buildFacilitySponsorshipInput`, which reject a
-- non-ISO date and a blank path before any SQL runs. If a hand-inserted row ever
-- violated one of these, ADD CONSTRAINT would fail and the run would roll back —
-- the correct outcome. To check first:
--   SELECT id FROM ad_placements WHERE NOT (isfinite(starts_on) AND isfinite(ends_on)) OR btrim(creative_path) = '';
--   SELECT id FROM facility_sponsorships WHERE NOT (isfinite(starts_on) AND isfinite(ends_on));
--
-- LOCKING. Each DROP is catalog-only; each ADD CONSTRAINT … CHECK takes ACCESS
-- EXCLUSIVE and full-scans its table — both hold single-digit rows. The DROPs
-- come first so no table is ever locked twice, and the guards bracket the file
-- (0020's corrected pattern: SET LOCAL first, explicit reset last, because
-- drizzle wraps the whole run in one transaction).
--
-- rollback (compensating SQL — restores the weaker checks; ONE explicit
-- transaction, since `SET LOCAL` outside a transaction block is a no-op):
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   ALTER TABLE "ad_placements" DROP CONSTRAINT "ad_placements_creative_path_sane";
--   ALTER TABLE "ad_placements" DROP CONSTRAINT "ad_placements_window_order";
--   ALTER TABLE "facility_sponsorships" DROP CONSTRAINT "facility_sponsorships_window_order";
--   ALTER TABLE "ad_placements" ADD CONSTRAINT "ad_placements_creative_path_sane"
--     CHECK ("ad_placements"."creative_path" <> '' AND "ad_placements"."creative_path" !~ '^/' AND "ad_placements"."creative_path" !~ '(^|/)\.\.(/|$)');
--   ALTER TABLE "ad_placements" ADD CONSTRAINT "ad_placements_window_order"
--     CHECK ("ad_placements"."ends_on" >= "ad_placements"."starts_on");
--   ALTER TABLE "facility_sponsorships" ADD CONSTRAINT "facility_sponsorships_window_order"
--     CHECK ("facility_sponsorships"."ends_on" >= "facility_sponsorships"."starts_on");
--   COMMIT;
--
-- JOURNAL: idx 24 is hand-stamped 1785084000000 — one hour past 0023. See 0020's
-- header for why the generated real-clock value is too low to be applied, and
-- db/src/journal.test.ts, added with this migration, for the mechanical gate that
-- now catches it.

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "ad_placements" DROP CONSTRAINT "ad_placements_creative_path_sane";--> statement-breakpoint
ALTER TABLE "ad_placements" DROP CONSTRAINT "ad_placements_window_order";--> statement-breakpoint
ALTER TABLE "facility_sponsorships" DROP CONSTRAINT "facility_sponsorships_window_order";--> statement-breakpoint
ALTER TABLE "ad_placements" ADD CONSTRAINT "ad_placements_creative_path_sane" CHECK (btrim("ad_placements"."creative_path") <> '' AND "ad_placements"."creative_path" !~ '^/' AND "ad_placements"."creative_path" !~ '(^|/)\.\.(/|$)');--> statement-breakpoint
ALTER TABLE "ad_placements" ADD CONSTRAINT "ad_placements_window_order" CHECK (isfinite("ad_placements"."starts_on") AND isfinite("ad_placements"."ends_on") AND "ad_placements"."ends_on" >= "ad_placements"."starts_on");--> statement-breakpoint
ALTER TABLE "facility_sponsorships" ADD CONSTRAINT "facility_sponsorships_window_order" CHECK (isfinite("facility_sponsorships"."starts_on") AND isfinite("facility_sponsorships"."ends_on") AND "facility_sponsorships"."ends_on" >= "facility_sponsorships"."starts_on");--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
