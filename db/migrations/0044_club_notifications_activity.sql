-- 0044_club_notifications_activity: the club mail ledger and the monthly
-- activity figures the operator invoices from.
--
-- club_notifications — "we sent this mail", the idempotency ledger for every
-- club mail the worker sends (apps/worker/src/club-mail-job.ts). Same design as
-- play_session_notifications (0013): mail is sent ONLY by the worker, the web
-- app enqueues ids (never an address, since a job row outlives the account it
-- names), and the worker CLAIMS the ledger row and sends in one transaction, so
-- a retried job cannot mail twice. The difference is the key: one
-- `dedupe_key` per club, built by ONE typed function
-- (lib/src/clubs/notifications.ts), because club mail has more shapes than
-- session mail — a booking confirmation is keyed by its arrival ticket so a
-- member who re-books after cancelling is confirmed again, a reminder by
-- occurrence and member, an expiry warning by membership, a digest by
-- recipient and day or week.
-- Exactly one recipient column is set: member_id for a club client (who may
-- have no POPS account), user_id for staff. Both CASCADE: the row is the
-- recipient's own data — the club erasing the client, or the person erasing
-- their account, takes it.
--
-- club_monthly_activity — one row per club per closed calendar month, written
-- by the club.activity job on the 1st (db/src/clubs/activity.ts). The INVOICE
-- BASIS for paid tiers is members_active: a client who held a valid membership
-- on any day of the month OR checked in at least three times (operator
-- decision pending with the pilot — docs/MONETISATION.md S7). Append-only: a
-- month, once computed, is a fact the invoice cites; the job inserts ON
-- CONFLICT DO NOTHING. Counts only — no member id, no name.
--
-- Locking: both tables are new; the FK to users takes SHARE ROW EXCLUSIVE on
-- users until COMMIT, placed last.
--
-- rollback (ONE explicit transaction, after the application):
--   DROP TABLE "club_monthly_activity";   -- DESTRUCTIVE: invoice evidence
--   DROP TABLE "club_notifications";      -- loses only dedupe state: a re-run
--       -- of a job could then re-send a reminder already sent
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "club_notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "club_notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"club_id" uuid NOT NULL,
	"member_id" uuid,
	"user_id" text,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_notifications_one_recipient" CHECK (num_nonnulls("club_notifications"."member_id", "club_notifications"."user_id") = 1),
	CONSTRAINT "club_notifications_kind_known" CHECK ("club_notifications"."kind" IN (
	    'member_invite', 'staff_invite',
	    'booking_confirmed', 'booking_promoted', 'booking_cancelled', 'class_cancelled', 'reminder_24h',
	    'membership_expiring', 'membership_expired',
	    'application_received', 'application_approved', 'operator_new_application',
	    'claim_pending', 'erasure_requested',
	    'roster_daily', 'owner_weekly')),
	CONSTRAINT "club_notifications_dedupe_key_shape" CHECK ("club_notifications"."dedupe_key" ~ '^[a-z0-9_]+(:[A-Za-z0-9_-]+)*$' AND char_length("club_notifications"."dedupe_key") <= 200)
);
--> statement-breakpoint
CREATE TABLE "club_monthly_activity" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "club_monthly_activity_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"club_id" uuid NOT NULL,
	"month" date NOT NULL,
	"members_with_membership" integer NOT NULL,
	"members_with_visits" integer NOT NULL,
	"members_active" integer NOT NULL,
	"checkins" integer NOT NULL,
	"bookings" integer NOT NULL,
	"revenue_cents" bigint NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_monthly_activity_month_is_first" CHECK (extract(day FROM "club_monthly_activity"."month") = 1 AND isfinite("club_monthly_activity"."month")),
	CONSTRAINT "club_monthly_activity_counts_sane" CHECK ("club_monthly_activity"."members_with_membership" >= 0 AND "club_monthly_activity"."members_with_visits" >= 0
	      AND "club_monthly_activity"."members_active" >= 0 AND "club_monthly_activity"."checkins" >= 0 AND "club_monthly_activity"."bookings" >= 0),
	CONSTRAINT "club_monthly_activity_active_is_union" CHECK ("club_monthly_activity"."members_active" >= greatest("club_monthly_activity"."members_with_membership", "club_monthly_activity"."members_with_visits")
	      AND "club_monthly_activity"."members_active" <= "club_monthly_activity"."members_with_membership" + "club_monthly_activity"."members_with_visits")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "club_notifications_dedupe_unique" ON "club_notifications" USING btree ("club_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "club_notifications_member_idx" ON "club_notifications" USING btree ("club_id","member_id") WHERE "club_notifications"."member_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_notifications_user_idx" ON "club_notifications" USING btree ("user_id") WHERE "club_notifications"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "club_monthly_activity_club_month_unique" ON "club_monthly_activity" USING btree ("club_id","month");--> statement-breakpoint
CREATE TRIGGER "club_monthly_activity_no_update" BEFORE UPDATE ON "club_monthly_activity" FOR EACH ROW EXECUTE FUNCTION club_ledger_append_only();--> statement-breakpoint
CREATE TRIGGER "club_monthly_activity_no_delete" BEFORE DELETE ON "club_monthly_activity" FOR EACH ROW EXECUTE FUNCTION club_ledger_append_only();--> statement-breakpoint
CREATE TRIGGER "club_monthly_activity_no_truncate" BEFORE TRUNCATE ON "club_monthly_activity" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_monthly_activity" ADD CONSTRAINT "club_monthly_activity_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
COMMENT ON TABLE "club_notifications" IS 'Idempotency ledger for club mail, sent only by the worker: claim-then-send in one transaction, UNIQUE (club_id, dedupe_key) with keys built by lib/src/clubs/notifications.ts. Exactly one recipient: member_id (a club client, perhaps without a POPS account) or user_id (staff). Both CASCADE — the row is the recipient''s own data.';--> statement-breakpoint
COMMENT ON TABLE "club_monthly_activity" IS 'Per club, per closed calendar month: counts only. members_active (valid membership on any day OR >= 3 check-ins) is the invoice basis for paid tiers. Append-only; written once by the club.activity job, ON CONFLICT DO NOTHING.';--> statement-breakpoint
ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
