-- 0046_club_online_payments: «Клубове» v2, wave E — online payments through
-- each club's OWN Stripe account (operator decision 2026-10-25, which
-- supersedes 0041's "records only"; plan "Wave E").
--
-- THE SHAPE OF IT (Stripe Connect Standard, direct charges):
--   - the club connects its own Stripe account (OAuth); the platform stores
--     only the account id — no key, no bank detail, no card data;
--   - a member pays on Stripe's HOSTED Checkout page, reached by redirect —
--     no payment script on pops.bg;
--   - the money lands in the club's balance: the club is the merchant of
--     record and the NGO never holds funds;
--   - what we learn back comes by signature-verified webhook, and the worker
--     RE-FETCHES the object from Stripe before acting — a webhook body is a
--     notification, never an authority.
--
-- TABLES
--   club_payment_accounts  one live connection per club, and one live club per
--                          Stripe account (two partial UNIQUEs — deauthorising
--                          is per platform-account pair, so a shared account
--                          would let one club's disconnect cut off another's).
--                          History kept: "who was connected when". A guard
--                          trigger keeps the account id, provider and club
--                          fixed and makes a disconnect final.
--   club_checkouts         one row per Checkout Session we create: what it
--                          is FOR (an open charge, or a plan to buy from a
--                          start date), the amount, and its outcome. The
--                          row exists BEFORE Stripe is called, so its id is
--                          the Idempotency-Key and the session's
--                          client_reference_id. Applying a paid session is a
--                          single `UPDATE … WHERE status = 'open'`, so two
--                          deliveries of the same event apply it once. One
--                          open checkout per charge (a second click replaces
--                          the first). Statuses:
--                            open       waiting for the member at Stripe;
--                            paid       applied to the books;
--                            expired    ended without payment;
--                            unapplied  MONEY WAS TAKEN but could not be
--                                       applied (the charge was settled at
--                                       the desk meanwhile) — the office
--                                       refunds it; its own status, so the
--                                       office screen finds it by index.
--                          A guard trigger makes every non-open state final
--                          and the amount, purpose and targets immutable.
--   club_payment_events    the webhook ledger: event id (UNIQUE — Stripe
--                          retries deliver the same id), type and the object
--                          it names. No payload is stored: the worker
--                          fetches the object itself. Platform-level, so no
--                          club_id; nothing in it names a person. Processed
--                          rows are pruned after 90 days by the worker's
--                          sweep (Stripe retries for about three).
--
-- COLUMNS
--   clubs.terms_url        the club's own terms, linked before the redirect
--                          (the consumer-information duty is the club's as
--                          the merchant).
--   club_memberships.provider_subscription_ref
--                          a membership paid by a Stripe subscription; the
--                          club.renewals job skips it (Stripe renews it and
--                          invoice.paid appends the next period).
--   club_payments.provider gains 'fake' — the local stand-in (/dev/plashtane)
--                          that resolvePaymentProvider can never select in
--                          production; labelling its rows honestly beats
--                          dressing them as Stripe in a development database.
--
-- VOCABULARY: audit actions and notification kinds widened (the twin lists in
-- lib/src/clubs/vocab.ts).
--
-- Locking: club_staff first (0039's order — see 0045's header); the new tables
-- are created empty; the widened CHECKs scan small tables under the ACCESS
-- EXCLUSIVE their DROP CONSTRAINT already took. Operator note, as for 0045:
-- do not purge a club (/admin/klubove) while this deploy's migrate step runs —
-- purge locks clubs and then club_staff, the reverse of this file. A worker
-- job that inserts a child row before reading clubs may also meet this file
-- head-on; Postgres aborts one side after ~1 s with no data lost, and pg-boss
-- retries the job.
--
-- rollback — ORDER MATTERS, because Stripe keeps billing after a revert:
--   1. BEFORE reverting the application: in each connected club's Stripe
--      dashboard (or by API), cancel the live subscriptions and expire the
--      open Checkout Sessions. The reverted application has no webhook
--      handler; anything Stripe charges afterwards is recorded nowhere.
--   2. Before the old worker starts:
--        UPDATE club_memberships SET renews = false
--         WHERE provider_subscription_ref IS NOT NULL AND renews;
--      otherwise the 0045-era club.renewals job (which has no
--      provider_subscription_ref filter) appends desk-charged successors to
--      chains Stripe is already billing — the member pays twice.
--   3. Only then, ONE explicit transaction, if the objects must go at all
--      (leaving them is harmless once 1 and 2 are done):
--        DROP TABLE "club_checkouts";   -- DESTRUCTIVE: after a member's
--          -- erasure, its subscription_ref is the only remaining link to a
--          -- subscription at Stripe
--        DROP TABLE "club_payment_events", "club_payment_accounts";
--          -- DESTRUCTIVE: which accounts were connected, and when
--        DROP FUNCTION club_checkouts_guard(); DROP FUNCTION club_payment_accounts_guard();
--        ALTER TABLE "club_memberships" DROP COLUMN "provider_subscription_ref";
--        ALTER TABLE "clubs" DROP COLUMN "terms_url";
--      club_payments_provider_known may be narrowed back only if no row has
--      provider 'fake'; keep the widened audit CHECK (club_audit is
--      append-only). Narrowing club_notifications_kind_known means deleting
--      the payment_received rows, which loses receipt dedupe: a roll-forward
--      within three days re-sends those receipts (receiptCandidates' window).
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "terms_url" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_terms_url_sane" CHECK ("clubs"."terms_url" IS NULL OR ("clubs"."terms_url" ~ '^https://[^\s]+$' AND char_length("clubs"."terms_url") <= 300)) NOT VALID;--> statement-breakpoint
ALTER TABLE "clubs" VALIDATE CONSTRAINT "clubs_terms_url_sane";--> statement-breakpoint
CREATE TABLE "club_payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"account_ref" text NOT NULL,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"connected_by" text,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_payment_accounts_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_payment_accounts_provider_known" CHECK ("club_payment_accounts"."provider" IN ('stripe', 'fake')),
	CONSTRAINT "club_payment_accounts_ref_shape" CHECK ("club_payment_accounts"."account_ref" ~ '^acct_[A-Za-z0-9_]{4,64}$'),
	CONSTRAINT "club_payment_accounts_live_enabled" CHECK ("club_payment_accounts"."disconnected_at" IS NULL OR NOT "club_payment_accounts"."charges_enabled")
);
--> statement-breakpoint
ALTER TABLE "club_payment_accounts" ADD CONSTRAINT "club_payment_accounts_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- One live connection per club; a reconnect first marks the old one gone.
CREATE UNIQUE INDEX "club_payment_accounts_one_live" ON "club_payment_accounts" USING btree ("club_id") WHERE "club_payment_accounts"."disconnected_at" IS NULL;--> statement-breakpoint
-- One live club per Stripe account; also how account.* events find the club.
CREATE UNIQUE INDEX "club_payment_accounts_ref_live" ON "club_payment_accounts" USING btree ("account_ref") WHERE "club_payment_accounts"."disconnected_at" IS NULL;--> statement-breakpoint
CREATE TRIGGER "club_payment_accounts_set_updated_at" BEFORE UPDATE ON "club_payment_accounts" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- Which account, for which club, connected by whom and when, are facts; a
-- disconnect is final (a reconnect is a new row). Only charges_enabled moves
-- while live, and the disconnect itself.
CREATE FUNCTION club_payment_accounts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.club_id IS DISTINCT FROM OLD.club_id OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.account_ref IS DISTINCT FROM OLD.account_ref
     OR NEW.connected_by IS DISTINCT FROM OLD.connected_by
     OR NEW.connected_at IS DISTINCT FROM OLD.connected_at THEN
    RAISE EXCEPTION 'club_payment_accounts: only charges_enabled and the disconnect may change';
  END IF;
  IF OLD.disconnected_at IS NOT NULL AND NEW.disconnected_at IS DISTINCT FROM OLD.disconnected_at THEN
    RAISE EXCEPTION 'club_payment_accounts: a disconnect is final';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_payment_accounts_guard" BEFORE UPDATE ON "club_payment_accounts" FOR EACH ROW EXECUTE FUNCTION club_payment_accounts_guard();--> statement-breakpoint
COMMENT ON TABLE "club_payment_accounts" IS 'A club''s own connected Stripe account (0046). Only the account id is stored — never a key, bank detail or card. connected_by is a staff id by value (0039 rule 5).';--> statement-breakpoint
CREATE TABLE "club_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"member_id" uuid,
	"charge_id" uuid,
	"plan_id" uuid,
	"starts_on" date,
	"membership_id" uuid,
	"amount_cents" integer NOT NULL,
	"mode" text DEFAULT 'payment' NOT NULL,
	"provider" text NOT NULL,
	"account_ref" text NOT NULL,
	"session_ref" text,
	"status" text DEFAULT 'open' NOT NULL,
	"payment_ref" text,
	"subscription_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "club_checkouts_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_checkouts_purpose_known" CHECK ("club_checkouts"."purpose" IN ('charge', 'membership')),
	-- charge_id is never cleared by a cascade (charges are voided, not
	-- deleted), and plan_id/starts_on are never cleared at all, so this CHECK
	-- names no column a delete nulls.
	CONSTRAINT "club_checkouts_purpose_target" CHECK (("club_checkouts"."purpose" <> 'charge' OR ("club_checkouts"."charge_id" IS NOT NULL AND "club_checkouts"."plan_id" IS NULL AND "club_checkouts"."starts_on" IS NULL))
	      AND ("club_checkouts"."purpose" <> 'membership' OR ("club_checkouts"."plan_id" IS NOT NULL AND "club_checkouts"."starts_on" IS NOT NULL))),
	CONSTRAINT "club_checkouts_subscription_is_membership" CHECK ("club_checkouts"."mode" <> 'subscription' OR "club_checkouts"."purpose" = 'membership'),
	CONSTRAINT "club_checkouts_starts_finite" CHECK ("club_checkouts"."starts_on" IS NULL OR isfinite("club_checkouts"."starts_on")),
	CONSTRAINT "club_checkouts_amount_sane" CHECK ("club_checkouts"."amount_cents" BETWEEN 50 AND 10000000),
	CONSTRAINT "club_checkouts_mode_known" CHECK ("club_checkouts"."mode" IN ('payment', 'subscription')),
	CONSTRAINT "club_checkouts_provider_known" CHECK ("club_checkouts"."provider" IN ('stripe', 'fake')),
	CONSTRAINT "club_checkouts_account_shape" CHECK ("club_checkouts"."account_ref" ~ '^acct_[A-Za-z0-9_]{4,64}$'),
	CONSTRAINT "club_checkouts_status_known" CHECK ("club_checkouts"."status" IN ('open', 'paid', 'expired', 'unapplied')),
	CONSTRAINT "club_checkouts_completed_pair" CHECK (("club_checkouts"."status" = 'open') = ("club_checkouts"."completed_at" IS NULL)),
	CONSTRAINT "club_checkouts_money_has_ref" CHECK ("club_checkouts"."status" NOT IN ('paid', 'unapplied') OR "club_checkouts"."payment_ref" IS NOT NULL),
	CONSTRAINT "club_checkouts_refs_shape" CHECK (("club_checkouts"."session_ref" IS NULL OR "club_checkouts"."session_ref" ~ '^[A-Za-z0-9_-]{1,255}$')
	      AND ("club_checkouts"."payment_ref" IS NULL OR "club_checkouts"."payment_ref" ~ '^[A-Za-z0-9_-]{1,255}$')
	      AND ("club_checkouts"."subscription_ref" IS NULL OR "club_checkouts"."subscription_ref" ~ '^[A-Za-z0-9_-]{1,255}$'))
);
--> statement-breakpoint
ALTER TABLE "club_checkouts" ADD CONSTRAINT "club_checkouts_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The member it is for; erasing the client keeps the attempt, anonymised.
ALTER TABLE "club_checkouts" ADD CONSTRAINT "club_checkouts_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE set null ("member_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_checkouts" ADD CONSTRAINT "club_checkouts_charge_fk" FOREIGN KEY ("club_id","charge_id") REFERENCES "public"."club_charges"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_checkouts" ADD CONSTRAINT "club_checkouts_plan_fk" FOREIGN KEY ("club_id","plan_id") REFERENCES "public"."club_plans"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The membership it bought is the SAME client's (the 0043/0045 pattern on
-- club_memberships_member_unique); once an erasure nulls member_id, MATCH
-- SIMPLE leaves the key unchecked, and the membership is gone anyway.
ALTER TABLE "club_checkouts" ADD CONSTRAINT "club_checkouts_membership_fk" FOREIGN KEY ("club_id","member_id","membership_id") REFERENCES "public"."club_memberships"("club_id","member_id","id") ON DELETE set null ("membership_id") ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_checkouts_session_unique" ON "club_checkouts" USING btree ("session_ref") WHERE "club_checkouts"."session_ref" IS NOT NULL;--> statement-breakpoint
-- One open checkout per charge: a second click replaces the first, so a
-- member cannot pay one charge twice through two tabs.
CREATE UNIQUE INDEX "club_checkouts_one_open_per_charge" ON "club_checkouts" USING btree ("charge_id") WHERE "club_checkouts"."purpose" = 'charge' AND "club_checkouts"."status" = 'open';--> statement-breakpoint
CREATE INDEX "club_checkouts_member_idx" ON "club_checkouts" USING btree ("club_id","member_id") WHERE "club_checkouts"."member_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_checkouts_charge_idx" ON "club_checkouts" USING btree ("club_id","charge_id") WHERE "club_checkouts"."charge_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_checkouts_plan_idx" ON "club_checkouts" USING btree ("club_id","plan_id") WHERE "club_checkouts"."plan_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_checkouts_membership_idx" ON "club_checkouts" USING btree ("club_id","member_id","membership_id") WHERE "club_checkouts"."membership_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_checkouts_subscription_idx" ON "club_checkouts" USING btree ("subscription_ref") WHERE "club_checkouts"."subscription_ref" IS NOT NULL;--> statement-breakpoint
-- The office's "refund owed" list.
CREATE INDEX "club_checkouts_unapplied_idx" ON "club_checkouts" USING btree ("club_id","completed_at") WHERE "club_checkouts"."status" = 'unapplied';--> statement-breakpoint
-- An open checkout may settle once; after that it is a fact. What it was FOR
-- never changes. The only later updates are the SET NULLs an erasure cascades,
-- and one late fact: money paid on a session already expired here (expired →
-- unapplied, with its payment reference).
CREATE FUNCTION club_checkouts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.club_id IS DISTINCT FROM OLD.club_id OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.starts_on IS DISTINCT FROM OLD.starts_on
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.account_ref IS DISTINCT FROM OLD.account_ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'club_checkouts: what a checkout is for never changes';
  END IF;
  IF NEW.member_id IS DISTINCT FROM OLD.member_id AND NEW.member_id IS NOT NULL THEN
    RAISE EXCEPTION 'club_checkouts: member_id may only be cleared';
  END IF;
  IF OLD.charge_id IS NOT NULL AND NEW.charge_id IS DISTINCT FROM OLD.charge_id THEN
    RAISE EXCEPTION 'club_checkouts: charge_id is fixed once set';
  END IF;
  IF OLD.status = 'expired' AND NEW.status = 'unapplied' THEN
    -- Money arrived on a session this side had already closed (a second
    -- click replaced it, or an erasure expired it): it is recorded for the
    -- office to refund, never applied. Only the payment's references move.
    IF NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.session_ref IS DISTINCT FROM OLD.session_ref
       OR NEW.charge_id IS DISTINCT FROM OLD.charge_id
       OR NEW.payment_ref IS NULL
       OR (NEW.membership_id IS DISTINCT FROM OLD.membership_id AND NEW.membership_id IS NOT NULL) THEN
      RAISE EXCEPTION 'club_checkouts: a settled checkout is final';
    END IF;
  ELSIF OLD.status <> 'open' THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
       OR NEW.session_ref IS DISTINCT FROM OLD.session_ref
       OR NEW.payment_ref IS DISTINCT FROM OLD.payment_ref
       OR NEW.subscription_ref IS DISTINCT FROM OLD.subscription_ref
       OR NEW.charge_id IS DISTINCT FROM OLD.charge_id
       OR (NEW.membership_id IS DISTINCT FROM OLD.membership_id AND NEW.membership_id IS NOT NULL) THEN
      RAISE EXCEPTION 'club_checkouts: a settled checkout is final';
    END IF;
  ELSIF OLD.session_ref IS NOT NULL AND NEW.session_ref IS DISTINCT FROM OLD.session_ref THEN
    RAISE EXCEPTION 'club_checkouts: session_ref is fixed once set';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_checkouts_guard" BEFORE UPDATE ON "club_checkouts" FOR EACH ROW EXECUTE FUNCTION club_checkouts_guard();--> statement-breakpoint
COMMENT ON TABLE "club_checkouts" IS 'One online payment attempt (0046): what it is for and how it ended. Applied once, by UPDATE … WHERE status = ''open''; status unapplied = money taken that the office must refund.';--> statement-breakpoint
CREATE TABLE "club_payment_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"account_ref" text,
	"object_ref" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"outcome" text,
	CONSTRAINT "club_payment_events_event_unique" UNIQUE("event_id"),
	CONSTRAINT "club_payment_events_provider_known" CHECK ("club_payment_events"."provider" IN ('stripe')),
	CONSTRAINT "club_payment_events_shape" CHECK ("club_payment_events"."event_id" ~ '^evt_[A-Za-z0-9_]{4,255}$'
	      AND "club_payment_events"."type" ~ '^[a-z_.]{3,100}$'
	      AND ("club_payment_events"."account_ref" IS NULL OR "club_payment_events"."account_ref" ~ '^acct_[A-Za-z0-9_]{4,64}$')
	      AND ("club_payment_events"."object_ref" IS NULL OR "club_payment_events"."object_ref" ~ '^[A-Za-z0-9_-]{1,255}$')),
	CONSTRAINT "club_payment_events_outcome_known" CHECK ("club_payment_events"."outcome" IS NULL OR "club_payment_events"."outcome" IN ('applied', 'ignored', 'failed')),
	CONSTRAINT "club_payment_events_processed_pair" CHECK (("club_payment_events"."processed_at" IS NULL) = ("club_payment_events"."outcome" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "club_payment_events_pending_idx" ON "club_payment_events" USING btree ("received_at") WHERE "club_payment_events"."processed_at" IS NULL;--> statement-breakpoint
-- The retention sweep: processed rows by age.
CREATE INDEX "club_payment_events_processed_idx" ON "club_payment_events" USING btree ("processed_at") WHERE "club_payment_events"."processed_at" IS NOT NULL;--> statement-breakpoint
COMMENT ON TABLE "club_payment_events" IS 'Stripe webhook ledger (0046): event id, type and the object it names — never the payload; the worker re-fetches the object. Names no person. Processed rows are pruned after 90 days.';--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "provider_subscription_ref" text;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_subscription_ref_shape" CHECK ("club_memberships"."provider_subscription_ref" IS NULL OR "club_memberships"."provider_subscription_ref" ~ '^[A-Za-z0-9_-]{1,255}$') NOT VALID;--> statement-breakpoint
ALTER TABLE "club_memberships" VALIDATE CONSTRAINT "club_memberships_subscription_ref_shape";--> statement-breakpoint
-- The subscription's memberships, by reference (invoice.paid finds the chain).
CREATE INDEX "club_memberships_subscription_idx" ON "club_memberships" USING btree ("provider_subscription_ref") WHERE "club_memberships"."provider_subscription_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "club_payments" DROP CONSTRAINT "club_payments_provider_known";--> statement-breakpoint
ALTER TABLE "club_payments" ADD CONSTRAINT "club_payments_provider_known" CHECK ("club_payments"."provider" IN ('manual', 'stripe', 'fake')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_payments" VALIDATE CONSTRAINT "club_payments_provider_known";--> statement-breakpoint
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
	    'online_payment_received', 'online_refund_issued')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_audit" VALIDATE CONSTRAINT "club_audit_action_known";--> statement-breakpoint
ALTER TABLE "club_notifications" DROP CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_kind_known" CHECK ("club_notifications"."kind" IN (
	    'member_invite', 'staff_invite',
	    'booking_confirmed', 'booking_promoted', 'booking_cancelled', 'class_cancelled', 'reminder_24h',
	    'membership_expiring', 'membership_expired',
	    'application_received', 'application_approved', 'operator_new_application',
	    'claim_pending', 'erasure_requested',
	    'roster_daily', 'owner_weekly',
	    'membership_renewed', 'fee_charged', 'owner_monthly',
	    'payment_received')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_notifications" VALIDATE CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
