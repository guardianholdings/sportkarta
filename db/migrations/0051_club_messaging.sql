-- 0051_club_messaging: «Клубове» v2, wave F1 (plan 2026-10-25) — a club
-- talks to its clients by e-mail, SMS and push: the automatic notices it
-- already sends, plus its own messages to a chosen group (1club's bulk
-- messages and email campaigns, anolla's SMS confirmations and reminders) and
-- messages that go out by themselves (1club's marketing automation).
-- Hand-written; do not regenerate.
--
-- WHAT THIS ADDS
--
--   club_notifications.channel / sms_parts
--                          the send ledger (0044) learns WHICH CHANNEL a row
--                          is: e-mail, SMS or push. One message may go by all
--                          three, so the uniqueness that makes a retry safe is
--                          now (club, channel, key) — a reminder that went by
--                          e-mail can still go by SMS, never twice by either.
--                          An SMS row records how many parts (segments) it
--                          was: gateways charge per part, and the parts are
--                          what the operator re-invoices.
--   club_sms_usage         the parts a club sent per Sofia calendar month — a
--                          COUNTER, raised by a trigger on every SMS claim and
--                          never lowered. Not a sum over the ledger: erasing a
--                          client deletes their ledger rows (0044's CASCADE),
--                          and an allowance or an invoice that shrank when a
--                          client was erased would be wrong twice.
--   club_notifications_sms_cap
--                          a club's parts in a month never exceed
--                          `clubs.sms_monthly_cap`, which the operator sets
--                          (0 = no SMS). The counter's upsert locks the club's
--                          month row until commit and is checked after it, so
--                          parallel sends queue on that row and the last part
--                          of the cap goes to one of them — at READ COMMITTED
--                          by waiting, at REPEATABLE READ by a serialization
--                          failure, never by overshooting. The lock is held
--                          across the gateway call (claim, send, commit): an
--                          SMS adapter MUST time out, or one hung request
--                          stalls that club's SMS. A row skipped by ON
--                          CONFLICT DO NOTHING fires no AFTER trigger, so a
--                          re-claim of a sent key is never a refusal. The
--                          month is the claim's own sent_at (now() — no writer
--                          sets it, and club_notifications_fixed keeps it).
--   club_notifications_fixed
--                          a send is a fact: its channel, parts and time are
--                          not changed afterwards (no application path does).
--   clubs.sms_notify       which automatic notices ALSO go by SMS: the 24-hour
--                          reminder, a cancelled class, a place freed from the
--                          waiting list. The club's instruction, empty by
--                          default.
--   club_member_links.notify_push
--                          a member who installed the app may mute one club's
--                          push notifications without muting the others.
--   push_subscriptions     a POPS account's devices that accepted
--                          notifications (Web Push, RFC 8030): the push
--                          service's endpoint and the two public values the
--                          browser hands out for encrypting to it (RFC 8291).
--                          Nothing here can read a notification — the payload
--                          is encrypted to the device. The account's own data:
--                          it CASCADEs with the account and is counted in
--                          account_deletions.push_subscriptions_erased.
--                          THE ENDPOINT IS A URL THE WORKER WILL POST TO, and a
--                          browser — any browser — chooses it. So the CHECK
--                          admits only the push services of the browsers we
--                          know (Google, Mozilla, Microsoft, Apple), over
--                          https; a forged subscription cannot make the worker
--                          call an address inside our network. A new browser's
--                          service needs a migration, deliberately.
--   club_broadcasts        a message from the club to a group: its purpose
--                          (a SERVICE notice — the hall is closed on Monday —
--                          or MARKETING — an offer), the channels, the group
--                          (everyone, a derived segment, a list filter, a
--                          tag, a plan's holders, a class's attendees), the
--                          text, and when it goes. Drafts may be deleted; while
--                          it is scheduled its text is fixed (back to a draft
--                          to edit it), a message being sent can still be
--                          cancelled for those it has not reached, and once it
--                          went out it is kept — what a club sent, to which
--                          group, is what it answers for. Only a draft is ever
--                          inserted. Who receives it is decided
--                          by the worker at send time, by the same rules as
--                          every club mail (0044's memberRecipient) plus:
--                          marketing goes only to records with a consent
--                          timestamp for that channel (0045), never by push,
--                          and every marketing message carries a way out.
--   club_automations       messages that go by themselves: a welcome after the
--                          first visit, a follow-up after a trial, after an
--                          abonnement ended without renewal, and a "we miss
--                          you" after N days without a visit. One row per
--                          trigger and channel; the worker runs them daily and
--                          the ledger keys each by trigger, member and the
--                          event it answers, so editing or re-creating an
--                          automation never re-sends it.
--   club_monthly_activity.sms_parts
--                          the month's SMS parts (from club_sms_usage), frozen
--                          with the other figures the operator invoices from
--                          (0044).
--   account_deletions_counts_non_negative
--                          re-created with the new counter (0040's pattern).
--
--   Vocabulary: notification kinds broadcast, automation; audit actions
--   broadcast_saved, broadcast_scheduled, broadcast_cancelled,
--   automation_saved, sms_settings_changed. The twin lists live in
--   lib/src/clubs/vocab.ts; lib/src/clubs/clubs.test.ts reads the LAST
--   definition of each constraint.
--
-- TENANCY: both new club tables carry club_id; a broadcast's plan and class
-- are composite (club_id, id) keys (NO ACTION — plans and classes are
-- archived, never deleted), so a broadcast can never name another club's
-- group. Both have their own club_id → clubs CASCADE, so the purge empties
-- them in its first round (0049's header). Staff ids (created_by, updated_by,
-- cancelled_by) are kept BY VALUE (0039 rule 5).
--
-- The ledger's old unique index is REPLACED. The application that ran before
-- this file names it in `ON CONFLICT (club_id, dedupe_key)`; between this
-- migration and the new application starting, such a claim fails with
-- "no unique or exclusion constraint matching" and its job is retried by
-- pg-boss — nothing is sent twice, and nothing is lost within the queue's
-- retry budget. Clubs ship switched off (CLUBS_ENABLED), so in production
-- the window is empty.
--
-- Locking: club_staff first (ACCESS EXCLUSIVE), the order 0045–0048 keep for
-- account erasure; then club_member_links, club_audit and account_deletions —
-- the tables erasure writes, in its order — then the rest; the foreign key to
-- users comes LAST (SHARE ROW EXCLUSIVE on users until COMMIT). The new and
-- re-created CHECKs scan club_audit, club_notifications, clubs,
-- club_monthly_activity and account_deletions under ACCESS EXCLUSIVE — only
-- account_deletions has rows in production today (the erasure receipts), and
-- it is small. Do not purge a club while this deploy migrates (0045).
--
-- rollback (ONE explicit transaction, after reverting the application). The
-- reverted application reads none of the new columns. It DOES need 0044's
-- unique index back — until then its claims fail with 42P10 and are retried,
-- the same window as on the way forward — and that needs the e-mail rows to
-- be unique per key:
--   SET LOCAL lock_timeout = '3s';
--   -- Erasure's first lock first, as the forward file does: account erasure
--   -- touches club_staff before clubs and users.
--   LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;
--   -- Removing the key to users takes ACCESS EXCLUSIVE on users, and the two
--   -- club tables' keys take it on clubs, club_plans and club_classes, for
--   -- the rest of the transaction (brief; run at a quiet hour).
--   DROP TABLE "push_subscriptions";            -- every device's notification opt-in
--   DROP TRIGGER "club_notifications_sms_cap" ON "club_notifications";
--   DROP TRIGGER "club_notifications_fixed" ON "club_notifications";
--   DELETE FROM "club_notifications" WHERE "channel" <> 'email';
--                         -- DESTRUCTIVE: SMS/push dedupe state (a re-run could
--                         -- re-send an SMS or a push; 0044's caveat)
--   CREATE UNIQUE INDEX "club_notifications_dedupe_unique" ON "club_notifications" ("club_id", "dedupe_key");
--   DROP INDEX "club_notifications_dedupe_channel_unique";
--   DROP FUNCTION club_notifications_sms_count(), club_notifications_fixed();
--   DROP TABLE "club_automations";
--   DROP TABLE "club_broadcasts";               -- DESTRUCTIVE: what each club sent
--   DROP FUNCTION club_broadcasts_guard();
--   ALTER TABLE "club_notifications" DROP COLUMN "sms_parts", DROP COLUMN "channel";
--   Leave club_sms_usage (and its guard), clubs.sms_monthly_cap / sms_notify,
--   club_member_links.notify_push, club_monthly_activity.sms_parts and
--   account_deletions.push_subscriptions_erased with its CHECK: harmless to the
--   old code, and the counter, the activity and the erasure receipts are
--   invoice and erasure evidence.
--   Keep the widened CHECKs on club_audit (append-only) and club_notifications
--   (narrowing needs deleting the rows of the new kinds — 0044's caveat).
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- Erasure's first club-table lock, taken first (see the header), then the
-- tables erasure writes, in its order.
LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_member_links", "club_audit", "account_deletions" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
-- ─── The send ledger learns its channel ──────────────────────────────────
ALTER TABLE "club_notifications" ADD COLUMN "channel" text DEFAULT 'email' NOT NULL;--> statement-breakpoint
ALTER TABLE "club_notifications" ADD COLUMN "sms_parts" smallint;--> statement-breakpoint
ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_channel_known" CHECK ("club_notifications"."channel" IN ('email', 'sms', 'push')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_notifications" VALIDATE CONSTRAINT "club_notifications_channel_known";--> statement-breakpoint
ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_sms_parts_sane" CHECK (("club_notifications"."channel" = 'sms') = ("club_notifications"."sms_parts" IS NOT NULL)
      AND ("club_notifications"."sms_parts" IS NULL OR "club_notifications"."sms_parts" BETWEEN 1 AND 10)) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_notifications" VALIDATE CONSTRAINT "club_notifications_sms_parts_sane";--> statement-breakpoint
CREATE UNIQUE INDEX "club_notifications_dedupe_channel_unique" ON "club_notifications" USING btree ("club_id","channel","dedupe_key");--> statement-breakpoint
-- The day's bulk e-mail across all clubs, counted on every broadcast sweep.
CREATE INDEX "club_notifications_bulk_email_idx" ON "club_notifications" USING btree ("sent_at") WHERE "club_notifications"."channel" = 'email' AND "club_notifications"."kind" IN ('broadcast', 'automation');--> statement-breakpoint
DROP INDEX "club_notifications_dedupe_unique";--> statement-breakpoint
ALTER TABLE "club_notifications" DROP CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_kind_known" CHECK ("club_notifications"."kind" IN (
	    'member_invite', 'staff_invite',
	    'booking_confirmed', 'booking_promoted', 'booking_cancelled', 'class_cancelled', 'reminder_24h',
	    'membership_expiring', 'membership_expired',
	    'application_received', 'application_approved', 'operator_new_application',
	    'claim_pending', 'erasure_requested',
	    'roster_daily', 'owner_weekly',
	    'membership_renewed', 'fee_charged', 'owner_monthly',
	    'payment_received',
	    'broadcast', 'automation')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_notifications" VALIDATE CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
-- ─── Who receives what, by which channel ─────────────────────────────────
ALTER TABLE "club_member_links" ADD COLUMN "notify_push" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "push_subscriptions_erased" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
          AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
          AND "account_deletions"."moderation_decisions_preserved" >= 0 AND "account_deletions"."sessions_cancelled" >= 0
          AND "account_deletions"."rsvps_erased" >= 0 AND "account_deletions"."checkins_erased" >= 0
          AND "account_deletions"."digest_subscriptions_erased" >= 0 AND "account_deletions"."results_anonymized" >= 0
          AND "account_deletions"."badges_erased" >= 0 AND "account_deletions"."campaign_results_anonymized" >= 0
          AND "account_deletions"."session_notifications_erased" >= 0
          AND "account_deletions"."club_staff_erased" >= 0 AND "account_deletions"."club_member_links_erased" >= 0
          AND "account_deletions"."push_subscriptions_erased" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "account_deletions" VALIDATE CONSTRAINT "account_deletions_counts_non_negative";--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "sms_monthly_cap" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "sms_notify" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_sms_monthly_cap_sane" CHECK ("clubs"."sms_monthly_cap" BETWEEN 0 AND 100000) NOT VALID;--> statement-breakpoint
ALTER TABLE "clubs" VALIDATE CONSTRAINT "clubs_sms_monthly_cap_sane";--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_sms_notify_known" CHECK ("clubs"."sms_notify" <@ ARRAY['reminder_24h', 'class_cancelled', 'booking_promoted']::text[]
      AND club_slug_list_valid("clubs"."sms_notify", 3)
      AND (cardinality("clubs"."sms_notify") = 0 OR array_ndims("clubs"."sms_notify") = 1)) NOT VALID;--> statement-breakpoint
ALTER TABLE "clubs" VALIDATE CONSTRAINT "clubs_sms_notify_known";--> statement-breakpoint
ALTER TABLE "club_monthly_activity" ADD COLUMN "sms_parts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "club_monthly_activity" ADD CONSTRAINT "club_monthly_activity_sms_parts_sane" CHECK ("club_monthly_activity"."sms_parts" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_monthly_activity" VALIDATE CONSTRAINT "club_monthly_activity_sms_parts_sane";--> statement-breakpoint
CREATE TABLE "club_sms_usage" (
	"club_id" uuid NOT NULL,
	"month" date NOT NULL,
	"parts" integer NOT NULL,
	CONSTRAINT "club_sms_usage_pkey" PRIMARY KEY("club_id","month"),
	CONSTRAINT "club_sms_usage_month_is_first" CHECK (extract(day FROM "club_sms_usage"."month") = 1 AND isfinite("club_sms_usage"."month")),
	CONSTRAINT "club_sms_usage_parts_sane" CHECK ("club_sms_usage"."parts" >= 0)
);
--> statement-breakpoint
CREATE FUNCTION club_sms_usage_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.club_id::text = current_setting('pops.purging_club', true) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'club_sms_usage: the SMS a club sent are not unsent'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_sms_usage_kept';
  END IF;
  IF (NEW.club_id, NEW.month) IS DISTINCT FROM (OLD.club_id, OLD.month) OR NEW.parts < OLD.parts THEN
    RAISE EXCEPTION 'club_sms_usage: the count only grows'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_sms_usage_kept';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_sms_usage_guard" BEFORE UPDATE OR DELETE ON "club_sms_usage" FOR EACH ROW EXECUTE FUNCTION club_sms_usage_guard();--> statement-breakpoint
CREATE TRIGGER "club_sms_usage_no_truncate" BEFORE TRUNCATE ON "club_sms_usage" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
CREATE FUNCTION club_notifications_sms_count() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  cap integer;
  used integer;
BEGIN
  -- The club's month row, locked until commit: parallel sends queue here.
  INSERT INTO public.club_sms_usage AS u (club_id, month, parts)
  VALUES (NEW.club_id, date_trunc('month', NEW.sent_at AT TIME ZONE 'Europe/Sofia')::date,
          NEW.sms_parts)
  ON CONFLICT (club_id, month) DO UPDATE SET parts = u.parts + EXCLUDED.parts
  RETURNING u.parts INTO used;
  SELECT c.sms_monthly_cap INTO cap FROM public.clubs c WHERE c.id = NEW.club_id;
  IF used > coalesce(cap, 0) THEN
    RAISE EXCEPTION 'club_notifications: the club''s SMS allowance for this month is used up'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_notifications_sms_cap';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_notifications_sms_cap" AFTER INSERT ON "club_notifications" FOR EACH ROW WHEN (NEW.channel = 'sms') EXECUTE FUNCTION club_notifications_sms_count();--> statement-breakpoint
CREATE FUNCTION club_notifications_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'club_notifications: a send is a fact — its channel, parts and time do not change'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'club_notifications_fixed';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_notifications_fixed" BEFORE UPDATE OF "channel", "sms_parts", "sent_at" ON "club_notifications" FOR EACH ROW EXECUTE FUNCTION club_notifications_fixed();--> statement-breakpoint
-- ─── Push subscriptions (the account's devices) ──────────────────────────
CREATE TABLE "push_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"failure_count" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint"),
	CONSTRAINT "push_subscriptions_endpoint_known" CHECK (char_length("push_subscriptions"."endpoint") <= 1000
	      AND "push_subscriptions"."endpoint" ~ '^https://(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9-]+\.notify\.windows\.com|web\.push\.apple\.com|[a-z0-9-]+\.push\.apple\.com)/[!-~]+$'),
	CONSTRAINT "push_subscriptions_p256dh_shape" CHECK ("push_subscriptions"."p256dh" ~ '^[A-Za-z0-9_-]{87}$'),
	CONSTRAINT "push_subscriptions_auth_shape" CHECK ("push_subscriptions"."auth" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "push_subscriptions_failures_sane" CHECK ("push_subscriptions"."failure_count" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE INDEX "push_subscriptions_user_idx" ON "push_subscriptions" USING btree ("user_id");--> statement-breakpoint
-- ─── Broadcasts ──────────────────────────────────────────────────────────
CREATE TABLE "club_broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"channels" text[] NOT NULL,
	"audience_kind" text NOT NULL,
	"audience_value" text,
	"plan_id" uuid,
	"class_id" uuid,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"sms_body" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"scheduled_for" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"cancelled_by" text,
	"cancelled_at" timestamp with time zone,
	"sent_email" integer,
	"sent_sms" integer,
	"sent_push" integer,
	CONSTRAINT "club_broadcasts_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_broadcasts_purpose_known" CHECK ("club_broadcasts"."purpose" IN ('service', 'marketing')),
	CONSTRAINT "club_broadcasts_channels_known" CHECK ("club_broadcasts"."channels" <@ ARRAY['email', 'sms', 'push']::text[]
	      AND cardinality("club_broadcasts"."channels") BETWEEN 1 AND 3
	      AND array_ndims("club_broadcasts"."channels") = 1
	      AND club_slug_list_valid("club_broadcasts"."channels", 3)),
	-- Marketing never goes by push: a notification on the lock screen is not
	-- a channel anybody consented to for offers (0051's header).
	CONSTRAINT "club_broadcasts_marketing_no_push" CHECK ("club_broadcasts"."purpose" = 'service' OR NOT ('push' = ANY("club_broadcasts"."channels"))),
	CONSTRAINT "club_broadcasts_audience_known" CHECK (
	      ("club_broadcasts"."audience_kind" = 'all' AND "club_broadcasts"."audience_value" IS NULL)
	   OR ("club_broadcasts"."audience_kind" = 'segment' AND "club_broadcasts"."audience_value" IN ('top', 'regular', 'new', 'trial', 'owes', 'at_risk'))
	   OR ("club_broadcasts"."audience_kind" = 'filter' AND "club_broadcasts"."audience_value" IN ('with_membership', 'unpaid', 'overdue', 'expiring', 'leads', 'lapsed'))
	   OR ("club_broadcasts"."audience_kind" = 'tag' AND "club_broadcasts"."audience_value" IS NOT NULL AND club_tags_valid(ARRAY["club_broadcasts"."audience_value"]))
	   OR ("club_broadcasts"."audience_kind" IN ('plan', 'class') AND "club_broadcasts"."audience_value" IS NULL)),
	CONSTRAINT "club_broadcasts_audience_target" CHECK (("club_broadcasts"."audience_kind" = 'plan') = ("club_broadcasts"."plan_id" IS NOT NULL)
	      AND ("club_broadcasts"."audience_kind" = 'class') = ("club_broadcasts"."class_id" IS NOT NULL)),
	CONSTRAINT "club_broadcasts_text_sane" CHECK (btrim("club_broadcasts"."subject") <> '' AND char_length("club_broadcasts"."subject") <= 150
	      AND btrim("club_broadcasts"."body") <> '' AND char_length("club_broadcasts"."body") <= 4000),
	CONSTRAINT "club_broadcasts_sms_body" CHECK (('sms' = ANY("club_broadcasts"."channels")) = ("club_broadcasts"."sms_body" IS NOT NULL)
	      AND ("club_broadcasts"."sms_body" IS NULL OR (btrim("club_broadcasts"."sms_body") <> '' AND char_length("club_broadcasts"."sms_body") <= 320))),
	CONSTRAINT "club_broadcasts_status_known" CHECK ("club_broadcasts"."status" IN ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
	CONSTRAINT "club_broadcasts_scheduled_has_time" CHECK (("club_broadcasts"."status" IN ('draft', 'cancelled') OR "club_broadcasts"."scheduled_for" IS NOT NULL)
	      AND ("club_broadcasts"."scheduled_for" IS NULL OR isfinite("club_broadcasts"."scheduled_for"))),
	-- A cancelled message may have started (cancelled while being sent).
	CONSTRAINT "club_broadcasts_started_pair" CHECK (("club_broadcasts"."status" IN ('draft', 'scheduled') AND "club_broadcasts"."started_at" IS NULL)
	      OR ("club_broadcasts"."status" IN ('sending', 'sent') AND "club_broadcasts"."started_at" IS NOT NULL)
	      OR "club_broadcasts"."status" = 'cancelled'),
	-- Counts are written when it finishes — or when a message being sent is
	-- cancelled, so the office still sees how many it reached.
	CONSTRAINT "club_broadcasts_finished_pair" CHECK (("club_broadcasts"."status" = 'sent') = ("club_broadcasts"."finished_at" IS NOT NULL)
	      AND num_nonnulls("club_broadcasts"."sent_email", "club_broadcasts"."sent_sms", "club_broadcasts"."sent_push") IN (0, 3)
	      AND ("club_broadcasts"."status" <> 'sent' OR "club_broadcasts"."sent_email" IS NOT NULL)
	      AND ("club_broadcasts"."status" IN ('sent', 'cancelled') OR "club_broadcasts"."sent_email" IS NULL)),
	CONSTRAINT "club_broadcasts_counts_sane" CHECK (coalesce("club_broadcasts"."sent_email", 0) >= 0 AND coalesce("club_broadcasts"."sent_sms", 0) >= 0
	      AND coalesce("club_broadcasts"."sent_push", 0) >= 0),
	CONSTRAINT "club_broadcasts_cancelled_pair" CHECK (("club_broadcasts"."status" = 'cancelled') = ("club_broadcasts"."cancelled_at" IS NOT NULL)
	      AND ("club_broadcasts"."cancelled_by" IS NULL OR "club_broadcasts"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "club_broadcasts_club_idx" ON "club_broadcasts" USING btree ("club_id","created_at");--> statement-breakpoint
CREATE INDEX "club_broadcasts_due_idx" ON "club_broadcasts" USING btree ("scheduled_for") WHERE "club_broadcasts"."status" IN ('scheduled', 'sending');--> statement-breakpoint
CREATE INDEX "club_broadcasts_plan_idx" ON "club_broadcasts" USING btree ("club_id","plan_id") WHERE "club_broadcasts"."plan_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_broadcasts_class_idx" ON "club_broadcasts" USING btree ("club_id","class_id") WHERE "club_broadcasts"."class_id" IS NOT NULL;--> statement-breakpoint
CREATE FUNCTION club_broadcasts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Only a draft is ever inserted: a "sent" row with made-up counts is not a
  -- record of anything.
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.started_at IS NOT NULL OR NEW.finished_at IS NOT NULL
       OR NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL
       OR num_nonnulls(NEW.sent_email, NEW.sent_sms, NEW.sent_push) > 0 THEN
      RAISE EXCEPTION 'club_broadcasts: a message begins as a draft'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_broadcasts_transition';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'draft' OR OLD.club_id::text = current_setting('pops.purging_club', true) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'club_broadcasts: only a draft is deleted; a message that was scheduled is kept'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_broadcasts_kept';
  END IF;
  -- What it says, to whom and why is fixed once it leaves the draft (from
  -- `scheduled` it may go back to a draft and be edited there).
  IF OLD.status <> 'draft' AND (NEW.club_id, NEW.purpose, NEW.channels, NEW.audience_kind, NEW.audience_value,
        NEW.plan_id, NEW.class_id, NEW.subject, NEW.body, NEW.sms_body, NEW.created_by, NEW.created_at)
      IS DISTINCT FROM (OLD.club_id, OLD.purpose, OLD.channels, OLD.audience_kind, OLD.audience_value,
        OLD.plan_id, OLD.class_id, OLD.subject, OLD.body, OLD.sms_body, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'club_broadcasts: a scheduled message is not edited — return it to a draft first'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_broadcasts_frozen';
  END IF;
  IF NEW.club_id <> OLD.club_id THEN
    RAISE EXCEPTION 'club_broadcasts: a message stays with its club'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_broadcasts_frozen';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
        (OLD.status = 'draft' AND NEW.status IN ('scheduled', 'cancelled'))
     OR (OLD.status = 'scheduled' AND NEW.status IN ('draft', 'sending', 'cancelled'))
     OR (OLD.status = 'sending' AND NEW.status IN ('sent', 'cancelled'))) THEN
    RAISE EXCEPTION 'club_broadcasts: % cannot become %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_broadcasts_transition';
  END IF;
  -- A sent or cancelled message is a record: its times and counts stay.
  IF OLD.status IN ('sent', 'cancelled') AND (NEW.status, NEW.sent_email, NEW.sent_sms, NEW.sent_push,
        NEW.started_at, NEW.finished_at, NEW.scheduled_for, NEW.cancelled_at, NEW.cancelled_by)
      IS DISTINCT FROM (OLD.status, OLD.sent_email, OLD.sent_sms, OLD.sent_push,
        OLD.started_at, OLD.finished_at, OLD.scheduled_for, OLD.cancelled_at, OLD.cancelled_by) THEN
    RAISE EXCEPTION 'club_broadcasts: a sent or cancelled message is a record'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_broadcasts_frozen';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_broadcasts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "club_broadcasts" FOR EACH ROW EXECUTE FUNCTION club_broadcasts_guard();--> statement-breakpoint
CREATE TRIGGER "club_broadcasts_no_truncate" BEFORE TRUNCATE ON "club_broadcasts" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
CREATE TRIGGER "club_broadcasts_set_updated_at" BEFORE UPDATE ON "club_broadcasts" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- ─── Automations ─────────────────────────────────────────────────────────
CREATE TABLE "club_automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"channel" text NOT NULL,
	"delay_days" smallint NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_automations_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_automations_one_per_trigger" UNIQUE("club_id", "trigger", "channel"),
	CONSTRAINT "club_automations_trigger_known" CHECK ("club_automations"."trigger" IN ('welcome', 'trial_follow_up', 'expired_follow_up', 'win_back')),
	CONSTRAINT "club_automations_channel_known" CHECK ("club_automations"."channel" IN ('email', 'sms')),
	CONSTRAINT "club_automations_delay_sane" CHECK ("club_automations"."delay_days" BETWEEN 0 AND 365
	      AND ("club_automations"."trigger" <> 'win_back' OR "club_automations"."delay_days" >= 14)),
	CONSTRAINT "club_automations_text_sane" CHECK (btrim("club_automations"."body") <> ''
	      AND (("club_automations"."channel" = 'email' AND "club_automations"."subject" IS NOT NULL
	            AND btrim("club_automations"."subject") <> '' AND char_length("club_automations"."subject") <= 150
	            AND char_length("club_automations"."body") <= 4000)
	        OR ("club_automations"."channel" = 'sms' AND "club_automations"."subject" IS NULL
	            AND char_length("club_automations"."body") <= 320)))
);
--> statement-breakpoint
CREATE TRIGGER "club_automations_set_updated_at" BEFORE UPDATE ON "club_automations" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- ─── Vocabulary ──────────────────────────────────────────────────────────
ALTER TABLE "club_audit" DROP CONSTRAINT "club_audit_action_known";--> statement-breakpoint
ALTER TABLE "club_audit" ADD CONSTRAINT "club_audit_action_known" CHECK ("club_audit"."action" IN (
	    'club_applied', 'settings_changed', 'location_saved', 'location_archived',
	    'kiosk_created', 'kiosk_paired', 'kiosk_revoked',
	    'staff_invited', 'staff_invite_revoked', 'staff_joined', 'staff_role_changed', 'staff_removed',
	    'member_created', 'member_updated', 'member_archived', 'member_restored', 'member_erased',
	    'link_invited', 'link_claimed', 'link_approved', 'link_declined', 'link_removed',
	    'erasure_requested', 'owner_erased',
	    'plan_saved', 'plan_archived',
	    'membership_sold', 'membership_paused', 'membership_resumed', 'membership_cancelled',
	    'charge_created', 'charge_voided', 'payment_recorded', 'refund_recorded',
	    'class_saved', 'class_cancelled', 'occurrence_cancelled',
	    'booking_created', 'booking_cancelled', 'checkin_recorded',
	    'import_committed', 'export_downloaded', 'ngo_admin_viewed',
	    'membership_renewed', 'renewal_stopped', 'fee_charged',
	    'time_off_saved', 'time_off_removed', 'faq_saved', 'faq_removed',
	    'staff_profile_changed', 'preferences_changed',
	    'payment_account_connected', 'payment_account_disconnected', 'checkout_started',
	    'online_payment_received', 'online_refund_issued',
	    'resource_saved', 'resource_archived', 'hours_saved', 'service_saved', 'service_archived',
	    'reservation_created', 'reservation_cancelled',
	    'product_saved', 'product_archived', 'stock_moved', 'sale_recorded', 'sale_reversed',
	    'promotion_saved', 'promotion_archived',
	    'wallet_topped_up', 'invoice_issued', 'credit_note_issued',
	    'broadcast_saved', 'broadcast_scheduled', 'broadcast_cancelled', 'automation_saved',
	    'sms_settings_changed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_audit" VALIDATE CONSTRAINT "club_audit_action_known";--> statement-breakpoint
-- ─── Keys ────────────────────────────────────────────────────────────────
ALTER TABLE "club_broadcasts" ADD CONSTRAINT "club_broadcasts_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_broadcasts" ADD CONSTRAINT "club_broadcasts_plan_fk" FOREIGN KEY ("club_id","plan_id") REFERENCES "public"."club_plans"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_broadcasts" ADD CONSTRAINT "club_broadcasts_class_fk" FOREIGN KEY ("club_id","class_id") REFERENCES "public"."club_classes"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_automations" ADD CONSTRAINT "club_automations_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_sms_usage" ADD CONSTRAINT "club_sms_usage_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
COMMENT ON TABLE "club_notifications" IS 'Idempotency ledger for club mail, SMS and push, sent only by the worker: claim-then-send in one transaction, UNIQUE (club_id, channel, dedupe_key) with keys built by lib/src/clubs/vocab.ts (0051). Exactly one recipient: member_id (a club client, perhaps without a POPS account) or user_id (staff). Both CASCADE — the row is the recipient''s own data; what an SMS cost is counted in club_sms_usage, which erasure does not touch.';--> statement-breakpoint
COMMENT ON TABLE "club_sms_usage" IS 'SMS parts a club sent per Sofia calendar month (0051): raised by club_notifications_sms_count on every SMS claim, never lowered (erasing a client gives no parts back), capped by clubs.sms_monthly_cap, and the source of club_monthly_activity.sms_parts.';--> statement-breakpoint
COMMENT ON COLUMN "club_notifications"."channel" IS 'Which channel this send was (0051): email, sms or push. Uniqueness is (club_id, channel, dedupe_key): one message may go by every channel, never twice by one.';--> statement-breakpoint
COMMENT ON COLUMN "club_notifications"."sms_parts" IS 'SMS only: how many parts (segments) the message was — what the gateway charges. Counted into club_sms_usage, which clubs.sms_monthly_cap caps (trigger club_notifications_sms_cap).';--> statement-breakpoint
COMMENT ON COLUMN "clubs"."sms_monthly_cap" IS 'SMS parts the club may send per Sofia calendar month, set by the operator (0 = no SMS). Enforced on every claim against club_sms_usage by club_notifications_sms_cap.';--> statement-breakpoint
COMMENT ON COLUMN "clubs"."sms_notify" IS 'The automatic notices the club also sends by SMS (0051): reminder_24h, class_cancelled, booking_promoted.';--> statement-breakpoint
COMMENT ON TABLE "push_subscriptions" IS 'A POPS account''s devices that accepted notifications (Web Push): the push service endpoint and the browser''s public encryption values. The endpoint CHECK admits only known browser push services over https, so the worker never posts to an address a forged subscription chose. CASCADEs with the account.';--> statement-breakpoint
COMMENT ON TABLE "club_broadcasts" IS 'A club''s message to a group (0051): purpose, channels, audience, text, schedule. Inserted as a draft; fixed while scheduled; cancellable until sent; kept once it went out. Recipients are resolved by the worker at send time (marketing: consent per channel, never push).';--> statement-breakpoint
COMMENT ON TABLE "club_automations" IS 'Messages that go by themselves (0051): a closed list of triggers, one row per trigger and channel; deduplicated by trigger, member and the event answered, so edits never re-send.';--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
