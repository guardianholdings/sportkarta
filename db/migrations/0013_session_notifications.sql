-- 0013_session_notifications: RSVP mail, reminders and the private calendar
-- feed (docs/ROADMAP.md §6, Stage 4.2). Two new tables, one new enum, one
-- counter on the GDPR tombstone. No existing row is rewritten and no data is
-- destroyed.
--
-- play_session_notifications is the IDEMPOTENCY LEDGER, and the argument is
-- digest_sends' and points_ledger's before it: the UNIQUE index is the
-- guarantee, not application logic. The row is inserted IN THE SAME TRANSACTION
-- AS, AND BEFORE, the send attempt, so a retried job, an overlapping schedule
-- or a second worker cannot mail anybody twice. The one hole is a crash landing
-- between the SMTP handoff and COMMIT, which re-sends — the right way round,
-- since send-then-record loses mail silently instead.
--
-- WHY A LEDGER RATHER THAN A TIME WINDOW. The obvious reminder job is "every
-- ten minutes, mail everyone whose session starts in 24 h ± 5 min". That job
-- mails NOBODY for any session whose window it slept through — a deploy, a
-- restart, a slow queue — and leaves no evidence that it did not. With this
-- table the query becomes "starting within 24 hours and not yet told", which is
-- idempotent, self-healing after downtime, and cannot double-send however often
-- it runs. The cost is one row per member per notification, which is the
-- cheapest thing in this schema.
--
-- The kinds are notification EVENTS, not attendance states: `promoted` records
-- that we told somebody a spot opened, and says nothing about whether they are
-- still going. "Am I going?" has exactly one answer in this system and it comes
-- from play_session_rsvp_positions (migration 0008), which this table
-- deliberately does not duplicate.
--
-- TWO KEYS, BECAUSE THREE OF THE SIX KINDS ARE RE-ENTRANT. Migration 0008
-- supports withdrawing and re-joining, which draws a FRESH arrival ticket
-- (play_session_rsvp_seq). A single UNIQUE (occurrence, member, kind) would
-- therefore suppress the second confirmation — and, far worse, the second
-- `promoted` mail: a member who withdrew, re-joined the waitlist and was let in
-- again would never be told, would believe they were still queued, and would
-- not turn up. Silently, with the ledger insisting they had been told.
-- So the file carries two partial unique indexes:
--   * rsvp_seq IS NULL     — facts about the OCCURRENCE (both reminders and the
--                            cancellation): once per member, whatever they do
--                            with their RSVP afterwards. Keying reminders by
--                            ticket would instead re-send "24 hours to go" to
--                            anyone who withdrew and re-joined, since their
--                            created_at — and so their eligibility — never moved.
--   * rsvp_seq IS NOT NULL — facts about ONE SIGN-UP (confirmed, waitlisted,
--                            promoted): once per arrival ticket.
-- play_session_notifications_seq_matches_kind binds the two, so no writer can
-- file a row under the wrong rule. Both sides of that equality are total (kind
-- is NOT NULL, `IS NOT NULL` never yields NULL), so it cannot evaluate to NULL
-- and be accepted by default — the trap 0012's campaigns_rules_shaped needed a
-- CASE to avoid. rsvp_seq is deliberately NOT a foreign key: the ledger must
-- outlive the RSVP row it describes, or withdrawing would erase the evidence
-- that we already wrote to somebody.
--
-- ADDING A SEVENTH KIND takes two DEPLOYS, not merely two files. ALTER TYPE ...
-- ADD VALUE runs inside drizzle's transaction, but the new value cannot be USED
-- in that same transaction — and `drizzle-kit migrate` wraps the loop over ALL
-- PENDING migrations in ONE transaction, so splitting the value and its use
-- across two files buys nothing if both are pending in the same
-- `pnpm db:migrate`. It would also pass CI and `pnpm db:reset`, because on a
-- from-scratch database the type is CREATEd in that same transaction and
-- PostgreSQL then permits the new value — green everywhere except production.
-- So: the value ships in one deploy, the CHECK rewrite and any backfill in the
-- next. (Corrected in 0014; this header originally said "two migrations".)
--
-- RETENTION is deliberately deferred. The table only grows, and there is no
-- index on sent_at, so the eventual prune is a seq-scan — acceptable for a
-- once-a-year maintenance job and not worth an index that every insert would
-- pay for. The only safe cutoff is occurrences that are already in the PAST:
-- deleting a row for an upcoming session re-arms every notification for it.
--
-- calendar_tokens exists because A CALENDAR CLIENT CANNOT SIGN IN. It fetches
-- one URL, forever, unauthenticated — so the URL IS the credential:
--   * One row per member (user_id is the primary key), so revoking is an UPDATE
--     that mints a new token and instantly kills every copy of the old URL.
--     Once a feed URL has leaked into a shared calendar that is the only
--     recovery there is, so it must be one click and not a support request.
--   * The shape CHECK refuses anything outside 22..64 base64url characters —
--     digest_subscriptions.unsubscribe_token's rule with an upper bound added,
--     so a truncated or predictable generator fails closed at the database
--     instead of quietly issuing a four-character calendar URL, and a runaway
--     one cannot put a multi-kilobyte token into a URL.
--   * It is NOT the account id and not derived from it. users.id is the
--     better-auth session subject; putting it in a feed URL would hand a live
--     identifier to every calendar server that ever polls us. That sentence is
--     a CHECK (calendar_tokens_token_is_not_the_account_id), not a hope:
--     better-auth ids satisfy the shape rule too, so a regression assigning
--     token = user_id would otherwise pass.
--
-- GDPR. Both tables CASCADE with the account. A "we emailed this person about
-- this session on this evening" row that outlived them would be a small,
-- pointless archive of somebody's week, and a calendar token that outlived them
-- would be a live credential belonging to nobody. Neither table can block a
-- DELETE FROM users: there is no CHECK naming a user column, no trigger, and no
-- RESTRICT anywhere in this file. The tombstone gains one counter so the
-- erasure receipt can evidence the notifications that went.
--
-- Locking: everything is new except the ADD COLUMN and the drop/re-add of
-- account_deletions_counts_non_negative (a table with a handful of rows), plus
-- the three ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY, which take SHARE
-- ROW EXCLUSIVE on the REFERENCED tables — `users` (twice) and
-- play_session_occurrences — blocking writes to them (reads are unaffected) for
-- the rest of the transaction, since drizzle runs the migration as one. They
-- are therefore placed as late as possible rather than in drizzle's default
-- position. lock_timeout makes queueing behind a long reader fail fast instead
-- of blocking sign-in and erasure; statement_timeout bounds the hold once the
-- lock has been taken. The ordering is deadlock-safe because this file and
-- apps/web/lib/account-deletion.ts both touch account_deletions BEFORE users,
-- in that order, so they serialise instead of deadlocking — which is why the
-- tombstone block below comes first and the users FKs come last, as 0012 does.
-- Reversing those two (0008's and 0009's order) makes a deploy overlapping a
-- GDPR erasure abort one of them on deadlock_timeout, which at 1s fires before
-- lock_timeout ever would.
--
-- rollback (compensating SQL, reverse order; DESTRUCTIVE where noted):
--   ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";
--   ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
--             AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
--             AND "account_deletions"."moderation_decisions_preserved" >= 0 AND "account_deletions"."sessions_cancelled" >= 0
--             AND "account_deletions"."rsvps_erased" >= 0 AND "account_deletions"."checkins_erased" >= 0
--             AND "account_deletions"."digest_subscriptions_erased" >= 0 AND "account_deletions"."results_anonymized" >= 0
--             AND "account_deletions"."badges_erased" >= 0 AND "account_deletions"."campaign_results_anonymized" >= 0);
--   ALTER TABLE "account_deletions" DROP COLUMN "session_notifications_erased";  -- DESTRUCTIVE:
--       erasure receipts recorded since this migration. Unrecoverable: the
--       accounts they describe are gone, so the count cannot be recomputed.
--   DROP TABLE "calendar_tokens";              -- DESTRUCTIVE, AND WIDER THAN IT
--       LOOKS. PRECONDITION: roll the APPLICATION back first. The shared
--       recipient projection in db/src/sessions/notifications.ts LEFT JOINs this
--       table on EVERY session-mail path, so dropping it under the current build
--       does not merely break the feed route — it makes reminders, promotions,
--       confirmations and cancellation notices all throw
--       `relation "calendar_tokens" does not exist`, i.e. nobody is told their
--       session was cancelled. Re-creating the table also issues NEW tokens, so
--       every member has to re-subscribe; the old URLs are gone for good.
--   DROP TABLE "play_session_notifications";   -- DESTRUCTIVE, AND LOUDLY SO:
--       dropping this makes the next run of session.reminders re-send every
--       pending reminder to everybody, because the evidence that they already
--       went IS this table. If it must go, disable the schedule FIRST.
--   DROP TYPE "play_session_notification_kind";
SET lock_timeout = '3s';--> statement-breakpoint
SET statement_timeout = '30s';--> statement-breakpoint
CREATE TYPE "public"."play_session_notification_kind" AS ENUM('rsvp_confirmed', 'rsvp_waitlisted', 'promoted', 'reminder_24h', 'reminder_2h', 'occurrence_cancelled');--> statement-breakpoint
CREATE TABLE "calendar_tokens" (
	"user_id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_tokens_token_unique" UNIQUE("token"),
	CONSTRAINT "calendar_tokens_token_shape" CHECK ("calendar_tokens"."token" ~ '^[A-Za-z0-9_-]{22,64}$'),
	-- The header says the token is not the account id. This is that sentence in
	-- SQL: better-auth ids match the shape rule too, so without it a regression
	-- setting token = user_id would pass, and put a live session subject into the
	-- logs of every third-party calendar server that polls the feed. CASCADE on
	-- the FK means there is no SET NULL update to re-evaluate this, so it cannot
	-- block an erasure (the 0009 trap does not apply).
	CONSTRAINT "calendar_tokens_token_is_not_the_account_id" CHECK ("calendar_tokens"."token" <> "calendar_tokens"."user_id")
);
--> statement-breakpoint
CREATE TABLE "play_session_notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "play_session_notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurrence_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"kind" "play_session_notification_kind" NOT NULL,
	"rsvp_seq" bigint,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "play_session_notifications_seq_matches_kind" CHECK (("play_session_notifications"."kind" IN ('rsvp_confirmed', 'rsvp_waitlisted', 'promoted')) = ("play_session_notifications"."rsvp_seq" IS NOT NULL))
);
--> statement-breakpoint
-- Facts about the OCCURRENCE — both reminders and the cancellation. Told once
-- per member, whatever they do with their RSVP afterwards.
CREATE UNIQUE INDEX "play_session_notifications_once_unique" ON "play_session_notifications" USING btree ("occurrence_id","user_id","kind") WHERE "play_session_notifications"."rsvp_seq" IS NULL;--> statement-breakpoint
-- Facts about ONE SIGN-UP — confirmed, waitlisted, promoted. Told once per
-- arrival ticket, so re-joining after a withdrawal is confirmed again and can
-- be promoted again. See the header for why a flat key loses somebody a game.
CREATE UNIQUE INDEX "play_session_notifications_attempt_unique" ON "play_session_notifications" USING btree ("occurrence_id","user_id","kind","rsvp_seq") WHERE "play_session_notifications"."rsvp_seq" IS NOT NULL;--> statement-breakpoint
-- Covers the user_id FK. Erasure counts and cascades by user_id, and this is
-- the fastest-growing table in the schema, so without this a legally
-- time-bound operation seq-scans it and gets slower every week. NOT for the
-- reminder anti-join, which the two unique indexes above already satisfy —
-- do not drop this as unused on that reading.
CREATE INDEX "play_session_notifications_user_idx" ON "play_session_notifications" USING btree ("user_id");--> statement-breakpoint
COMMENT ON TABLE "play_session_notifications" IS 'Idempotency ledger for session mail: the UNIQUE index is the guarantee, and the row goes in before the send, in the same transaction. It exists so the reminder job can ask "starting within 24 hours and not yet told" instead of "starting in 24 h ± 5 min" — the second mails nobody at all for any window the job slept through. Holds no subject, body or address.';--> statement-breakpoint
COMMENT ON COLUMN "play_session_notifications"."kind" IS 'A notification EVENT, not an attendance state. `promoted` records that we told somebody a spot opened; whether they are still going comes from play_session_rsvp_positions, which is the single definition of that and is deliberately not duplicated here.';--> statement-breakpoint
COMMENT ON COLUMN "play_session_notifications"."rsvp_seq" IS 'The arrival ticket a sign-up notification was about; NULL for the ones that are facts about the occurrence. Withdrawing and re-joining draws a fresh ticket, so keying the RSVP-scoped kinds by it is what lets a member who was let back in off the waitlist actually be told. Not a foreign key: the ledger must outlive the RSVP row it describes.';--> statement-breakpoint
COMMENT ON TABLE "calendar_tokens" IS 'Private calendar-feed credential. A calendar client cannot sign in, so the URL IS the credential: one row per member so revocation is an UPDATE that kills every copy of the old URL at once; random and >=128 bits by CHECK; and deliberately not the account id — users.id is the better-auth session subject and must not travel in a URL polled by third-party calendar servers.';--> statement-breakpoint
ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "session_notifications_erased" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
          AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
          AND "account_deletions"."moderation_decisions_preserved" >= 0 AND "account_deletions"."sessions_cancelled" >= 0
          AND "account_deletions"."rsvps_erased" >= 0 AND "account_deletions"."checkins_erased" >= 0
          AND "account_deletions"."digest_subscriptions_erased" >= 0 AND "account_deletions"."results_anonymized" >= 0
          AND "account_deletions"."badges_erased" >= 0 AND "account_deletions"."campaign_results_anonymized" >= 0
          AND "account_deletions"."session_notifications_erased" >= 0);--> statement-breakpoint
-- Last: the three FKs that take SHARE ROW EXCLUSIVE on `users` and
-- play_session_occurrences, blocking every WRITE to them (sign-in upserts,
-- profile saves, GDPR erasure) until COMMIT. Kept to the final milliseconds of
-- the transaction, AFTER the account_deletions work above — that order is what
-- makes this file and apps/web/lib/account-deletion.ts serialise rather than
-- deadlock, as 0012 established.
ALTER TABLE "calendar_tokens" ADD CONSTRAINT "calendar_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_session_notifications" ADD CONSTRAINT "play_session_notifications_occurrence_id_play_session_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."play_session_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_session_notifications" ADD CONSTRAINT "play_session_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
