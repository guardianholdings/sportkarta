-- 0009_digest_results: the weekly city digest (opt-in + send ledger) and
-- per-occurrence results v1 (docs/ROADMAP.md §6, Stage 4.4 and 4.6).
-- Three new tables, one trigger, two counters on the GDPR tombstone. No
-- existing row is rewritten and no data is destroyed.
--
-- digest_subscriptions is the opt-in, signed-in members only: the address is
-- already verified by OTP sign-in, so there is no double-opt-in flow to build
-- and no way to subscribe somebody else. The primary key (user, municipality)
-- makes a double-submitted toggle a no-op rather than a duplicate row.
-- unsubscribe_token is what lets one-click unsubscribe work WITHOUT a session —
-- somebody who has lost interest must not have to sign in to make the mail
-- stop. It is random, per subscription, and cancels exactly one city; the shape
-- CHECK makes a truncated or predictable generator fail closed.
--
-- digest_sends is the idempotency ledger, and the argument is points_ledger's:
-- the UNIQUE index is the guarantee, not application logic. The job inserts the
-- row IN THE SAME TRANSACTION AS, AND BEFORE, the send attempt. That gives one
-- send per subscriber per week EXCEPT for a crash landing between the SMTP
-- handoff and COMMIT, which re-sends that week — the honest statement of the
-- trade, and the right way round (send-then-record loses mail silently).
-- Because the send happens inside the transaction, a second worker blocks on
-- the index tuple rather than racing, which makes the SMTP timeout the
-- effective lock duration — the job sets its timeouts accordingly.
-- The key is per (user, municipality): a subscriber to three cities gets three
-- emails a week BY DESIGN. Batching cities into one mail later would make this
-- ledger over-count and needs a different key.
-- week_start is CHECK-constrained to an ISO Monday. A `date` carries no
-- instant, so nothing about it is DST-sensitive once stored — but
-- node-postgres serialises a JS Date using the PROCESS offset, so a Sofia
-- Monday 00:00 sent from a TZ=UTC worker would arrive as the previous Sunday
-- and quietly key the same logical week twice. The job passes 'YYYY-MM-DD'.
-- The table deliberately holds no subject, body or address: it records THAT a
-- send happened, not what was in it. There is no FK to digest_subscriptions,
-- so the evidence survives an unsubscribe.
--
-- play_session_results is one row per participant or side. A pickup football
-- game is two rows (team, positions 1 and 2, scores '3' and '1'); a 5 km run is
-- one row per runner with a position and a typed time. One table and one CSV
-- shape covers every sport in the canonical vocabulary. Duplicate positions are
-- ALLOWED on purpose — ties are real results — so the occurrence index is
-- deliberately not unique.
--
-- NO TIMING HARDWARE. docs/ROADMAP.md §6 ends "No timing hardware", and that is
-- a boundary this migration encodes rather than an omission to be filled in
-- later without a decision: there is no device id, no chip/gun/net time, and no
-- import path for a timing system. `score` is TEXT that an organiser typed —
-- '3:1', '12:34', '21-19, 19-21, 15-12'. A numeric column would fit football
-- and not tennis; an interval column would invite exactly the integration that
-- has been ruled out.
--
-- GDPR, AND THE ONE SUBTLE THING IN THIS FILE. participant_user_id is
-- ON DELETE SET NULL, not CASCADE: a result is a fact about a game other people
-- played in too, so erasing one participant must not delete the other side's
-- record of it. But "a row identifies somebody" therefore CANNOT be a CHECK.
-- A member result is normally (participant_user_id = <id>, participant_label =
-- NULL) — there is no reason to type a label for somebody the app can already
-- name — and SET NULL is performed as an UPDATE that re-evaluates every CHECK
-- on the row. A CHECK would fail, aborting DELETE FROM users permanently, with
-- no retry that could ever succeed. So the rule is a BEFORE INSERT TRIGGER,
-- applied where the row is authored. The anonymised row is still unambiguous:
-- the trigger guarantees a guest always has a label, so (user_id IS NULL AND
-- label IS NULL) means exactly "an erased member" and renders as the same
-- "former user" label the audit trail already uses.
-- Nothing else here can block a DELETE FROM users: both digest tables cascade,
-- recorded_by nulls out and is named in no CHECK, and the results trigger is
-- INSERT-only for precisely this reason (0008 learned the same lesson about
-- UPDATE triggers reachable from an erasure cascade).
-- Note the trigger does NOT copy the erased person's name anywhere: the label
-- stays NULL. team and note remain organiser-typed free text, capped in length,
-- with the same "no personal data here" posture as facility_reports.body.
--
-- Locking: everything is new except the two ADD COLUMN and the drop/re-add of
-- account_deletions_counts_non_negative (a table with a handful of rows), plus
-- the seven ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY, which take SHARE
-- ROW EXCLUSIVE on the REFERENCED tables — users, municipalities and
-- play_session_occurrences — blocking writes to them (reads are unaffected) for
-- the rest of the transaction, since drizzle runs the migration as one. They
-- are therefore placed as late as possible rather than in drizzle's default
-- position. lock_timeout makes queueing behind a long reader fail fast instead
-- of blocking sign-in and erasure.
--
-- rollback (compensating SQL, reverse order; DESTRUCTIVE where noted):
--   ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";
--   ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
--             AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
--             AND "account_deletions"."moderation_decisions_preserved" >= 0 AND "account_deletions"."sessions_cancelled" >= 0
--             AND "account_deletions"."rsvps_erased" >= 0 AND "account_deletions"."checkins_erased" >= 0);
--   ALTER TABLE "account_deletions" DROP COLUMN "results_anonymized";         -- DESTRUCTIVE:
--   ALTER TABLE "account_deletions" DROP COLUMN "digest_subscriptions_erased";-- erasure
--       receipts recorded since this migration. Unrecoverable: the accounts they
--       describe are gone, so the counts cannot be recomputed from anything.
--   DROP TRIGGER "play_session_results_require_participant" ON "play_session_results";
--   DROP FUNCTION play_session_result_requires_participant();
--   DROP TABLE "play_session_results";   -- DESTRUCTIVE: every recorded result
--   DROP TABLE "digest_sends";           -- DESTRUCTIVE: dropping this makes the
--       next run of digest.weekly re-send the current week to everyone, because
--       the evidence that it already went is gone. If this table must go,
--       disable the schedule first.
--   DROP TABLE "digest_subscriptions";   -- DESTRUCTIVE: every opt-in. Consent
--       cannot be reconstructed and must not be assumed — restoring from the
--       nightly backup is the only correct recovery.
SET lock_timeout = '3s';--> statement-breakpoint
CREATE TABLE "digest_sends" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "digest_sends_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"municipality_id" integer NOT NULL,
	"week_start" date NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_sends_week_start_is_monday" CHECK (EXTRACT(isodow FROM "digest_sends"."week_start") = 1)
);
--> statement-breakpoint
CREATE TABLE "digest_subscriptions" (
	"user_id" text NOT NULL,
	"municipality_id" integer NOT NULL,
	"unsubscribe_token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "digest_subscriptions_user_id_municipality_id_pk" PRIMARY KEY("user_id","municipality_id"),
	CONSTRAINT "digest_subscriptions_unsubscribe_token_unique" UNIQUE("unsubscribe_token"),
	CONSTRAINT "digest_subscriptions_token_shape" CHECK ("digest_subscriptions"."unsubscribe_token" ~ '^[A-Za-z0-9_-]{22,}$')
);
--> statement-breakpoint
CREATE TABLE "play_session_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"participant_user_id" text,
	"participant_label" text,
	"team" text,
	"position" integer,
	"score" text,
	"note" text,
	"recorded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "play_session_results_has_content" CHECK ("play_session_results"."position" IS NOT NULL OR "play_session_results"."score" IS NOT NULL OR "play_session_results"."note" IS NOT NULL),
	CONSTRAINT "play_session_results_position_positive" CHECK ("play_session_results"."position" IS NULL OR "play_session_results"."position" > 0),
	CONSTRAINT "play_session_results_text_sane" CHECK (("play_session_results"."participant_label" IS NULL OR (btrim("play_session_results"."participant_label") <> '' AND char_length("play_session_results"."participant_label") <= 80))
          AND ("play_session_results"."team" IS NULL OR (btrim("play_session_results"."team") <> '' AND char_length("play_session_results"."team") <= 80))
          AND ("play_session_results"."score" IS NULL OR (btrim("play_session_results"."score") <> '' AND char_length("play_session_results"."score") <= 40))
          AND ("play_session_results"."note" IS NULL OR (btrim("play_session_results"."note") <> '' AND char_length("play_session_results"."note") <= 300)))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "digest_sends_user_week_unique" ON "digest_sends" USING btree ("user_id","municipality_id","week_start");--> statement-breakpoint
CREATE INDEX "digest_sends_week_idx" ON "digest_sends" USING btree ("week_start");--> statement-breakpoint
CREATE INDEX "digest_sends_municipality_idx" ON "digest_sends" USING btree ("municipality_id");--> statement-breakpoint
CREATE INDEX "digest_subscriptions_municipality_idx" ON "digest_subscriptions" USING btree ("municipality_id");--> statement-breakpoint
CREATE INDEX "play_session_results_occurrence_idx" ON "play_session_results" USING btree ("occurrence_id","position");--> statement-breakpoint
CREATE INDEX "play_session_results_participant_idx" ON "play_session_results" USING btree ("participant_user_id") WHERE "play_session_results"."participant_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "play_session_results_recorded_by_idx" ON "play_session_results" USING btree ("recorded_by") WHERE "play_session_results"."recorded_by" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "play_session_results_occurrence_member_unique" ON "play_session_results" USING btree ("occurrence_id","participant_user_id") WHERE "play_session_results"."participant_user_id" IS NOT NULL;--> statement-breakpoint
-- "A result identifies somebody" — INSERT ONLY. See the GDPR paragraph in the
-- header: as a CHECK this would make erasing a participant abort DELETE FROM
-- users forever. search_path is pinned so the function cannot be steered by the
-- caller's session.
CREATE FUNCTION play_session_result_requires_participant() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.participant_user_id IS NULL
     AND btrim(coalesce(NEW.participant_label, '')) = '' THEN
    RAISE EXCEPTION 'a result must name a member or carry a participant label';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "play_session_results_require_participant"
BEFORE INSERT ON "play_session_results"
FOR EACH ROW EXECUTE FUNCTION play_session_result_requires_participant();--> statement-breakpoint
COMMENT ON TABLE "digest_subscriptions" IS 'Opt-in to the weekly city digest. Signed-in members only, so the address is already OTP-verified and nobody can subscribe somebody else. unsubscribe_token makes one-click unsubscribe work without a session, and cancels exactly one city.';--> statement-breakpoint
COMMENT ON TABLE "digest_sends" IS 'Idempotency ledger for the weekly digest, the same argument as points_ledger: the UNIQUE index is the guarantee. The row is inserted in the same transaction as, and before, the send — one mail per subscriber per week, except for a crash between the SMTP handoff and COMMIT. Holds no subject, body or address. Keyed per (user, municipality): three cities means three emails by design.';--> statement-breakpoint
COMMENT ON TABLE "play_session_results" IS 'Results v1: one row per participant or side. NO TIMING HARDWARE (docs/ROADMAP.md §6) — no device id, no chip/gun/net time, no timing-system import. score is operator-typed text so it fits football, tennis and a 5 km run alike. Duplicate positions are allowed: ties are real.';--> statement-breakpoint
COMMENT ON COLUMN "play_session_results"."participant_user_id" IS 'ON DELETE SET NULL, never CASCADE: a result is a fact about a game other people played in too, so erasing one participant must not delete the other side''s record of it. Both this and participant_label NULL means "an erased member" — the guest case always carries a label, enforced on INSERT by play_session_results_require_participant.';--> statement-breakpoint
COMMENT ON COLUMN "play_session_results"."score" IS 'Free text on purpose: ''3:1'', ''12:34'', ''21-19, 19-21, 15-12''. A numeric column would fit one sport and break the others, and an interval column would invite the timing-hardware integration this stage has ruled out.';--> statement-breakpoint
ALTER TABLE "digest_sends" ADD CONSTRAINT "digest_sends_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_sends" ADD CONSTRAINT "digest_sends_municipality_id_municipalities_id_fk" FOREIGN KEY ("municipality_id") REFERENCES "public"."municipalities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_subscriptions" ADD CONSTRAINT "digest_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "digest_subscriptions" ADD CONSTRAINT "digest_subscriptions_municipality_id_municipalities_id_fk" FOREIGN KEY ("municipality_id") REFERENCES "public"."municipalities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_session_results" ADD CONSTRAINT "play_session_results_occurrence_id_play_session_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."play_session_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_session_results" ADD CONSTRAINT "play_session_results_participant_user_id_users_id_fk" FOREIGN KEY ("participant_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_session_results" ADD CONSTRAINT "play_session_results_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "digest_subscriptions_erased" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "results_anonymized" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
          AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
          AND "account_deletions"."moderation_decisions_preserved" >= 0 AND "account_deletions"."sessions_cancelled" >= 0
          AND "account_deletions"."rsvps_erased" >= 0 AND "account_deletions"."checkins_erased" >= 0
          AND "account_deletions"."digest_subscriptions_erased" >= 0 AND "account_deletions"."results_anonymized" >= 0);