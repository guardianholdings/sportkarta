-- 0010_passport: the sports passport — public-profile visibility controls and
-- the badge notification ledger (docs/ROADMAP.md §7, Stage 5.1). One new table,
-- three new columns on users, one counter on the GDPR tombstone. No existing
-- row is rewritten and no data is destroyed.
--
-- WHAT IS NOT HERE, AND WHY THAT IS THE POINT. There is no badges table, no
-- badge enum, no per-badge column and no threshold column. Badges are DERIVED
-- by folding a member's event stream (points_ledger + play_session_checkins)
-- through a catalogue that lives in TypeScript — lib/src/badges/catalog.ts.
-- The roadmap's requirement is "declarative badge engine (config, not schema
-- changes)", and the way to keep that true a year from now is to give the
-- database no opinion about which badges exist. Adding a badge is one config
-- entry and two i18n keys; it needs no migration, and it is awarded
-- retroactively with the date it would really have been earned, because the
-- fold walks history rather than watching for new events.
--
-- user_badges therefore records only whether the member has been TOLD. One row
-- per (member, badge), inserted ON CONFLICT DO NOTHING, so two concurrent page
-- loads congratulate somebody once. badge_slug is TEXT with a shape CHECK and
-- no foreign key, because there is nothing to point at. That CHECK is the ONLY
-- bound on the column — no enum, no FK — so it constrains length as well as
-- alphabet, matching moderation_flags.reason and play_sessions.sport: without a
-- ceiling, a slug-construction bug surfaces as "index row size exceeds maximum"
-- from the unique index rather than as a clean constraint violation. The honest
-- cost of slugs-as-text: a slug renamed in config orphans its row and
-- re-announces the badge once. That is the cheapest failure mode on offer, and
-- it is a notification, not data loss.
--
-- THE MINOR BOUNDARY IS A CONSTRAINT, NOT A CODE PATH. CLAUDE.md: "Minors: no
-- individual public leaderboards". A publicly readable page of one named
-- child's sporting habits — where they play, how often, how recently — is that
-- same exposure reached by a different route, so users_minor_profile_not_public
-- makes it impossible with the application bypassed.
--
-- IT IS WRITTEN AS AN ALLOWLIST — "private, or not a minor" — and NOT as
-- `NOT (is_minor AND visibility = 'public')`. The two are equivalent today and
-- diverge the moment somebody adds an enum value. This schema's enum policy
-- (db/migrations/0001 header) is that new values arrive later via ALTER TYPE …
-- ADD VALUE: a no-lock, low-ceremony change that nobody will think to review
-- against a CHECK in a year-old migration. The play layer already ships the
-- value that would do it — play_session_visibility is ('public','unlisted') —
-- and under a denylist an 'unlisted' passport would be legal for a minor, with
-- the rule enforced nowhere. The allowlist form fails CLOSED for every value
-- that has not been considered: a new visibility is forbidden to minors until
-- somebody deliberately permits it.
--
-- The application demotes a newly-minor member to 'private' in the same UPDATE
-- that sets is_minor (apps/web/lib/profile.ts), so correcting a birth date
-- gives a demotion instead of a failed save. This constraint is the backstop
-- for every path that forgets to — including a future admin screen.
--
-- WHY THESE CHECKS ARE SAFE DURING GDPR ERASURE, AND WHAT WOULD BREAK THAT.
-- 0009's trap was a CHECK that had to re-validate during an FK's ON DELETE SET
-- NULL, which would have aborted DELETE FROM users permanently. It does not
-- recur here: `users` is never the referencing side of any FK, so no delete
-- action ever produces an UPDATE on a users row, and erasure is a bare DELETE
-- (apps/web/lib/account-deletion.ts). THAT IS AN INVARIANT, NOT A COINCIDENCE,
-- and the obvious future change breaks it: adding "release the handle before
-- deleting" — UPDATE users SET public_handle = NULL — aborts
-- users_public_needs_handle for every member who was public, and erasure fails
-- with no retry that could succeed. If a handle ever needs releasing, clear it
-- and profile_visibility in the SAME statement.
--
-- public_handle is the URL segment for a public passport, and it is
-- deliberately NOT the account id. That id is the subject better-auth signs
-- into session tokens; publishing it in a shareable URL would hand it to every
-- recipient of a shared link and to every Referer header leaving the page.
-- Random, minted on first opt-in, then stable so shared links keep working. The
-- shape CHECK (24 lowercase hex, 96 bits) exists so a truncated or predictable
-- generator fails closed rather than storing something a scraper can enumerate:
-- opting in must publish the passport to people the member sends the link to,
-- not to a crawler walking the id space. NULL passes the CHECK, which is what
-- a private member's row looks like.
--
-- users_public_needs_handle forbids the one incoherent state: public with no
-- URL, which would be "public" and unreachable.
--
-- LOCKING, STATED PRECISELY. Every ADD COLUMN here has a non-volatile default,
-- so it is catalog-only (PG11+) rather than a rewrite. But the first ALTER
-- TABLE on `users` takes ACCESS EXCLUSIVE — which blocks READS, i.e. every
-- signed-in request — and holds it until COMMIT, because drizzle runs the
-- migration as one transaction. lock_timeout bounds only the WAIT to acquire
-- that lock (failing fast instead of queueing behind a long reader); it does
-- nothing about the hold. statement_timeout bounds the hold. So every `users`
-- statement is placed at the END of this file rather than in drizzle's default
-- position, as 0008 and 0009 did for the same reason, keeping the window to
-- the last few milliseconds of the transaction.
--
-- (ADD CONSTRAINT … NOT VALID + VALIDATE CONSTRAINT would be the pattern for a
-- large table, and is deliberately NOT used: inside a single transaction the
-- ACCESS EXCLUSIVE from the ADD is held to COMMIT anyway, so the split buys
-- nothing here. It becomes worth doing when these constraints are added to a
-- `users` big enough to need its own migration.)
--
-- rollback (compensating SQL, reverse order; DESTRUCTIVE where noted):
--   DROP TABLE "user_badges";                          -- destroys only the record of
--       which badges have been ANNOUNCED. The badges themselves are derived and
--       survive untouched, so the sole consequence is that members are told once
--       more about badges they already hold. This one is genuinely reversible.
--   ALTER TABLE "users" DROP CONSTRAINT "users_public_handle_shape";
--   ALTER TABLE "users" DROP CONSTRAINT "users_public_needs_handle";
--   ALTER TABLE "users" DROP CONSTRAINT "users_minor_profile_not_public";
--   ALTER TABLE "users" DROP CONSTRAINT "users_public_handle_unique";
--   ALTER TABLE "users" DROP COLUMN "public_show_activity";  -- DESTRUCTIVE:
--   ALTER TABLE "users" DROP COLUMN "public_handle";         -- DESTRUCTIVE:
--   ALTER TABLE "users" DROP COLUMN "profile_visibility";    -- DESTRUCTIVE:
--       profile_visibility is a CONSENT RECORD and public_handle is the URL the
--       member has already shared. Dropping them destroys every member's
--       decision to publish, and because the handle is regenerated on the next
--       opt-in, every link they have given anyone stays permanently dead.
--       Consent cannot be reconstructed and must not be assumed: if these
--       columns have to come back, RESTORE FROM THE NIGHTLY BACKUP rather than
--       re-adding the columns, which would silently republish nobody and
--       quietly lose who had chosen what.
--   DROP TYPE "profile_visibility";
--   ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";
--   ALTER TABLE "account_deletions" DROP COLUMN "badges_erased";               -- DESTRUCTIVE:
--       erasure receipts recorded since this migration lose their badge count.
--   ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
--             AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
--             AND "account_deletions"."moderation_decisions_preserved" >= 0 AND "account_deletions"."sessions_cancelled" >= 0
--             AND "account_deletions"."rsvps_erased" >= 0 AND "account_deletions"."checkins_erased" >= 0
--             AND "account_deletions"."digest_subscriptions_erased" >= 0 AND "account_deletions"."results_anonymized" >= 0);
SET lock_timeout = '3s';--> statement-breakpoint
-- Bounds how long `users` can stay ACCESS EXCLUSIVE once acquired — lock_timeout
-- cannot. Generous for statements that are catalog-only or scan a small table.
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TYPE "public"."profile_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "user_badges" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "user_badges_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"badge_slug" text NOT NULL,
	"earned_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone,
	CONSTRAINT "user_badges_slug_shape" CHECK ("user_badges"."badge_slug" ~ '^[a-z][a-z0-9_]{2,39}$'),
	CONSTRAINT "user_badges_earned_before_seen" CHECK ("user_badges"."earned_at" <= "user_badges"."first_seen_at"),
	CONSTRAINT "user_badges_seen_order" CHECK ("user_badges"."seen_at" IS NULL OR "user_badges"."seen_at" >= "user_badges"."first_seen_at")
);
--> statement-breakpoint
ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "badges_erased" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_badges" ADD CONSTRAINT "user_badges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "user_badges_user_slug_unique" ON "user_badges" USING btree ("user_id","badge_slug");--> statement-breakpoint
CREATE INDEX "user_badges_user_unseen_idx" ON "user_badges" USING btree ("user_id") WHERE "user_badges"."seen_at" IS NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
          AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
          AND "account_deletions"."moderation_decisions_preserved" >= 0 AND "account_deletions"."sessions_cancelled" >= 0
          AND "account_deletions"."rsvps_erased" >= 0 AND "account_deletions"."checkins_erased" >= 0
          AND "account_deletions"."digest_subscriptions_erased" >= 0 AND "account_deletions"."results_anonymized" >= 0
          AND "account_deletions"."badges_erased" >= 0);--> statement-breakpoint
COMMENT ON TABLE "user_badges" IS 'Badge NOTIFICATION ledger, not badge state. Badges are derived by folding points_ledger + play_session_checkins through the catalogue in lib/src/badges — adding one is config, not a migration. This table only records whether the member has been told. badge_slug is TEXT with no FK because there is no badges table to point at.';--> statement-breakpoint
COMMENT ON COLUMN "user_badges"."earned_at" IS 'The instant of the event that crossed the threshold, per the engine — not when we noticed. If a threshold changes in config, the engine wins and this row may disagree.';--> statement-breakpoint
-- Everything touching `users` is last: the first statement here takes ACCESS
-- EXCLUSIVE (blocking reads on the table every signed-in request needs) and
-- holds it until COMMIT, so the window is kept to the end of the transaction.
ALTER TABLE "users" ADD COLUMN "profile_visibility" "profile_visibility" DEFAULT 'private' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "public_handle" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "public_show_activity" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_public_handle_unique" UNIQUE("public_handle");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_minor_profile_not_public" CHECK ("users"."profile_visibility" = 'private' OR NOT "users"."is_minor");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_public_needs_handle" CHECK ("users"."profile_visibility" = 'private' OR "users"."public_handle" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_public_handle_shape" CHECK ("users"."public_handle" ~ '^[0-9a-f]{24}$');--> statement-breakpoint
COMMENT ON COLUMN "users"."profile_visibility" IS 'Opt-in only: DEFAULT private. A minor can never be non-private (users_minor_profile_not_public, written as an allowlist so a future enum value stays forbidden until deliberately permitted) — CLAUDE.md, no individual public exposure of minors.';--> statement-breakpoint
COMMENT ON COLUMN "users"."public_handle" IS 'URL segment for the public passport. Random and deliberately NOT the account id, which is the better-auth session subject and must not travel in a shareable URL or a Referer header.';--> statement-breakpoint
COMMENT ON COLUMN "users"."public_show_activity" IS 'Whether the public passport shows a coarse activity history. Even when true it carries no facility name and no timestamp: a public, timestamped record of where a named person reliably is would be a pattern-of-life disclosure.';
