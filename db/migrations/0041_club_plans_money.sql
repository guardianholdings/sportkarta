-- 0041_club_plans_money: what a club sells and the record of who paid
-- (operator decision 2026-10-24: "records first, online later").
--
-- POPS RECORDS MONEY; IT NEVER MOVES IT. In v1 the club takes cash, a card on
-- its own terminal or a bank transfer, and the desk writes down that it did.
-- There is no card data, no payer bank detail, no fiscal receipt number and no
-- VAT arithmetic anywhere here: the club's fiscal device (Наредба Н-18) and its
-- accountant remain the club's. Phase 2 lets a club connect ITS OWN Stripe
-- account and send a client to a Stripe-HOSTED page — never a payment script on
-- pops.bg — and the seam for that is two columns on club_payments (provider,
-- provider_ref) that v1 never fills.
--
-- THE CHAIN:
--   club_plans        what is for sale (an abonnement: unlimited for a period, a
--                     card of N visits, or a trial). Never deleted once sold —
--                     archived_at hides it from sale.
--   club_memberships  one sale to one member, with a SNAPSHOT of the plan (name,
--                     kind, price, visits) so editing a plan never rewrites what
--                     somebody already bought. Visits used are NOT a counter:
--                     a visit is consumed by the existence of a club_checkins
--                     row (0043) pointing at the membership, so two desks
--                     checking the same person in cannot race a decrement.
--                     visits_used_offset carries visits already used before a
--                     CSV import.
--   club_membership_pauses
--                     date ranges that extend validity. EXCLUDE (btree_gist)
--                     makes overlapping pauses of one membership impossible.
--   club_charges      what is owed. Never deleted; VOIDED instead
--                     (club_charges_guard admits exactly: voiding once, and the
--                     anonymising SET NULLs of an erasure).
--   club_payments     what was received. APPEND-ONLY: a refund is a new row
--                     with a negative amount, never an edit. The guard admits
--                     one UPDATE — member_id to NULL when the club erases the
--                     client — so the books survive anonymised.
--   club_charge_balances (view)
--                     paid, due and status (void / paid / overdue / partial /
--                     open) — derived, never stored, so a payment can never
--                     disagree with a status column.
--
-- club_payments_within_charge is a trigger, not application code, because it
-- is about money: the running total of a charge's payments stays between 0 and
-- its amount, and a voided charge accepts refunds only. It locks the charge row
-- FOR UPDATE, which serialises two desks recording against one charge. It
-- reports with SQLSTATE 23514 and CONSTRAINT 'club_payments_within_charge', so
-- the application maps it like any CHECK.
--
-- Prices are integer EURO CENTS (clubs.currency is pinned to EUR; Bulgaria's
-- dual display ended 2026-08-08).
--
-- Locking: every object is new; nothing existing is touched.
--
-- rollback (ONE explicit transaction, after 0042–0044 and the application):
--   DROP VIEW "club_charge_balances";
--   DROP TABLE "club_payments", "club_charges", "club_membership_pauses",
--              "club_memberships", "club_plans";      -- DESTRUCTIVE: the books
--   DROP FUNCTION club_payments_guard(); DROP FUNCTION club_charges_guard();
--   DROP FUNCTION club_payments_within_charge();
--   DROP FUNCTION club_membership_pause_within_membership();
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "club_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name_bg" text NOT NULL,
	"name_en" text,
	"description_bg" text,
	"description_en" text,
	"kind" text NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"price_cents" integer NOT NULL,
	"validity_days" integer,
	"validity_months" integer,
	"visits_count" integer,
	"visibility" text DEFAULT 'public' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_plans_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_plans_names_sane" CHECK (btrim("club_plans"."name_bg") <> '' AND char_length("club_plans"."name_bg") <= 80
	      AND ("club_plans"."name_en" IS NULL OR (btrim("club_plans"."name_en") <> '' AND char_length("club_plans"."name_en") <= 80))),
	CONSTRAINT "club_plans_descriptions_sane" CHECK (("club_plans"."description_bg" IS NULL OR (btrim("club_plans"."description_bg") <> '' AND char_length("club_plans"."description_bg") <= 500))
	      AND ("club_plans"."description_en" IS NULL OR (btrim("club_plans"."description_en") <> '' AND char_length("club_plans"."description_en") <= 500))),
	CONSTRAINT "club_plans_kind_known" CHECK ("club_plans"."kind" IN ('unlimited', 'visits', 'trial')),
	CONSTRAINT "club_plans_audience_known" CHECK ("club_plans"."audience" IN ('all', 'adults', 'minors')),
	CONSTRAINT "club_plans_price_sane" CHECK ("club_plans"."price_cents" BETWEEN 0 AND 10000000),
	CONSTRAINT "club_plans_one_validity" CHECK (num_nonnulls("club_plans"."validity_days", "club_plans"."validity_months") = 1),
	CONSTRAINT "club_plans_validity_sane" CHECK (("club_plans"."validity_days" IS NULL OR "club_plans"."validity_days" BETWEEN 1 AND 366)
	      AND ("club_plans"."validity_months" IS NULL OR "club_plans"."validity_months" BETWEEN 1 AND 24)),
	CONSTRAINT "club_plans_visits_match_kind" CHECK (("club_plans"."kind" <> 'visits' OR "club_plans"."visits_count" IS NOT NULL)
	      AND ("club_plans"."kind" <> 'unlimited' OR "club_plans"."visits_count" IS NULL)),
	CONSTRAINT "club_plans_visits_sane" CHECK ("club_plans"."visits_count" IS NULL OR "club_plans"."visits_count" BETWEEN 1 AND 500),
	CONSTRAINT "club_plans_visibility_known" CHECK ("club_plans"."visibility" IN ('public', 'private'))
);
--> statement-breakpoint
CREATE TABLE "club_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"plan_name" text NOT NULL,
	"kind" text NOT NULL,
	"audience" text NOT NULL,
	"price_cents" integer NOT NULL,
	"visits_total" integer,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"visits_used_offset" integer DEFAULT 0 NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"sold_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_memberships_club_id_unique" UNIQUE("club_id", "id"),
	-- The target of club_checkins' consumption key (0043): a visit can only be
	-- counted against an abonnement of the SAME client.
	CONSTRAINT "club_memberships_member_unique" UNIQUE("club_id", "member_id", "id"),
	CONSTRAINT "club_memberships_plan_name_sane" CHECK (btrim("club_memberships"."plan_name") <> '' AND char_length("club_memberships"."plan_name") <= 80),
	CONSTRAINT "club_memberships_kind_known" CHECK ("club_memberships"."kind" IN ('unlimited', 'visits', 'trial')),
	CONSTRAINT "club_memberships_audience_known" CHECK ("club_memberships"."audience" IN ('all', 'adults', 'minors')),
	CONSTRAINT "club_memberships_price_sane" CHECK ("club_memberships"."price_cents" BETWEEN 0 AND 10000000),
	CONSTRAINT "club_memberships_visits_match_kind" CHECK (("club_memberships"."kind" <> 'visits' OR "club_memberships"."visits_total" IS NOT NULL)
	      AND ("club_memberships"."kind" <> 'unlimited' OR "club_memberships"."visits_total" IS NULL)),
	CONSTRAINT "club_memberships_visits_sane" CHECK ("club_memberships"."visits_total" IS NULL OR "club_memberships"."visits_total" BETWEEN 1 AND 500),
	CONSTRAINT "club_memberships_window_sane" CHECK (isfinite("club_memberships"."starts_on") AND isfinite("club_memberships"."ends_on")
	      AND "club_memberships"."ends_on" >= "club_memberships"."starts_on"
	      AND "club_memberships"."ends_on" - "club_memberships"."starts_on" <= 800),
	CONSTRAINT "club_memberships_offset_sane" CHECK ("club_memberships"."visits_used_offset" >= 0
	      AND ("club_memberships"."visits_total" IS NULL OR "club_memberships"."visits_used_offset" <= "club_memberships"."visits_total")),
	CONSTRAINT "club_memberships_cancel_pair" CHECK (("club_memberships"."cancelled_at" IS NULL) = ("club_memberships"."cancel_reason" IS NULL)),
	CONSTRAINT "club_memberships_cancel_reason_known" CHECK ("club_memberships"."cancel_reason" IS NULL OR "club_memberships"."cancel_reason" IN ('member_request', 'non_payment', 'mistake', 'other'))
);
--> statement-breakpoint
CREATE TABLE "club_membership_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_membership_pauses_window_sane" CHECK (isfinite("club_membership_pauses"."starts_on") AND isfinite("club_membership_pauses"."ends_on")
	      AND "club_membership_pauses"."ends_on" >= "club_membership_pauses"."starts_on"
	      AND "club_membership_pauses"."ends_on" - "club_membership_pauses"."starts_on" < 180)
);
--> statement-breakpoint
CREATE TABLE "club_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"member_id" uuid,
	"membership_id" uuid,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"issued_on" date NOT NULL,
	"due_on" date NOT NULL,
	"voided_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_charges_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_charges_kind_known" CHECK ("club_charges"."kind" IN ('membership', 'drop_in', 'product', 'fee', 'other')),
	CONSTRAINT "club_charges_label_sane" CHECK (btrim("club_charges"."label") <> '' AND char_length("club_charges"."label") <= 120),
	CONSTRAINT "club_charges_amount_sane" CHECK ("club_charges"."amount_cents" BETWEEN 1 AND 10000000),
	CONSTRAINT "club_charges_dates_sane" CHECK (isfinite("club_charges"."issued_on") AND isfinite("club_charges"."due_on") AND "club_charges"."due_on" >= "club_charges"."issued_on")
);
--> statement-breakpoint
CREATE TABLE "club_payments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "club_payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"club_id" uuid NOT NULL,
	"charge_id" uuid NOT NULL,
	"member_id" uuid,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"method" text NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_ref" text,
	"received_on" date NOT NULL,
	"recorded_by" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_payments_kind_known" CHECK ("club_payments"."kind" IN ('payment', 'refund')),
	CONSTRAINT "club_payments_sign_matches_kind" CHECK (("club_payments"."kind" = 'refund') = ("club_payments"."amount_cents" < 0) AND "club_payments"."amount_cents" <> 0),
	CONSTRAINT "club_payments_amount_sane" CHECK (abs("club_payments"."amount_cents") <= 10000000),
	CONSTRAINT "club_payments_method_known" CHECK ("club_payments"."method" IN ('cash', 'card_desk', 'bank', 'card_online', 'other')),
	CONSTRAINT "club_payments_provider_known" CHECK ("club_payments"."provider" IN ('manual', 'stripe')),
	CONSTRAINT "club_payments_provider_ref_pair" CHECK (("club_payments"."provider" = 'manual') = ("club_payments"."provider_ref" IS NULL)),
	CONSTRAINT "club_payments_online_is_provider" CHECK (("club_payments"."method" = 'card_online') = ("club_payments"."provider" <> 'manual')),
	CONSTRAINT "club_payments_provider_ref_shape" CHECK ("club_payments"."provider_ref" IS NULL OR "club_payments"."provider_ref" ~ '^[A-Za-z0-9_-]{1,255}$'),
	CONSTRAINT "club_payments_received_sane" CHECK (isfinite("club_payments"."received_on"))
);
--> statement-breakpoint
CREATE INDEX "club_plans_club_idx" ON "club_plans" USING btree ("club_id","sort_order") WHERE "club_plans"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "club_memberships_member_idx" ON "club_memberships" USING btree ("club_id","member_id");--> statement-breakpoint
CREATE INDEX "club_memberships_plan_idx" ON "club_memberships" USING btree ("club_id","plan_id");--> statement-breakpoint
-- The expiry job and the "Изтичащи" panel: live memberships by end date.
CREATE INDEX "club_memberships_ends_idx" ON "club_memberships" USING btree ("club_id","ends_on") WHERE "club_memberships"."cancelled_at" IS NULL;--> statement-breakpoint
-- One trial per member, EVER. Only a sale cancelled as a 'mistake' is as if it
-- never happened (the same rule club_member_status applies in 0043); a trial
-- cancelled for any other reason still counts, or a desk could cancel a used
-- trial and sell the same client another free one.
CREATE UNIQUE INDEX "club_memberships_one_trial" ON "club_memberships" USING btree ("member_id") WHERE "club_memberships"."kind" = 'trial' AND "club_memberships"."cancel_reason" IS DISTINCT FROM 'mistake';--> statement-breakpoint
CREATE INDEX "club_membership_pauses_membership_idx" ON "club_membership_pauses" USING btree ("club_id","membership_id");--> statement-breakpoint
CREATE INDEX "club_charges_member_idx" ON "club_charges" USING btree ("club_id","member_id") WHERE "club_charges"."member_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_charges_membership_idx" ON "club_charges" USING btree ("club_id","membership_id") WHERE "club_charges"."membership_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_charges_open_due_idx" ON "club_charges" USING btree ("club_id","due_on") WHERE "club_charges"."voided_at" IS NULL;--> statement-breakpoint
CREATE INDEX "club_payments_charge_idx" ON "club_payments" USING btree ("charge_id");--> statement-breakpoint
CREATE INDEX "club_payments_club_received_idx" ON "club_payments" USING btree ("club_id","received_on" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "club_payments_member_idx" ON "club_payments" USING btree ("club_id","member_id") WHERE "club_payments"."member_id" IS NOT NULL;--> statement-breakpoint
-- Phase-2 webhook idempotency: one row per provider reference per club.
CREATE UNIQUE INDEX "club_payments_provider_ref_unique" ON "club_payments" USING btree ("club_id","provider","provider_ref") WHERE "club_payments"."provider_ref" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "club_membership_pauses" ADD CONSTRAINT "club_membership_pauses_no_overlap" EXCLUDE USING gist ("membership_id" WITH =, daterange("starts_on", "ends_on", '[]') WITH &&);--> statement-breakpoint
-- A pause must START inside the membership's validity (as already extended by
-- its other pauses) and the membership must be live. Without this, a pause
-- entered after expiry would extend effective_ends_on and turn an expired
-- abonnement back into an active one — changing coverage, the member's status
-- and the members_active invoice basis. Every pause extends validity by its
-- full length, so where it ENDS is free. Raised as a named check violation.
CREATE FUNCTION club_membership_pause_within_membership() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  m_starts date;
  m_ends date;
  m_cancelled timestamptz;
  other_days integer;
BEGIN
  SELECT m.starts_on, m.ends_on, m.cancelled_at INTO m_starts, m_ends, m_cancelled
    FROM public.club_memberships m
   WHERE m.club_id = NEW.club_id AND m.id = NEW.membership_id;
  IF m_starts IS NULL THEN
    RETURN NEW;  -- the foreign key reports it as 23503
  END IF;
  SELECT coalesce(sum(p.ends_on - p.starts_on + 1), 0)::integer INTO other_days
    FROM public.club_membership_pauses p
   WHERE p.club_id = NEW.club_id AND p.membership_id = NEW.membership_id AND p.id <> NEW.id;
  IF m_cancelled IS NOT NULL
     OR NEW.starts_on < m_starts
     OR NEW.starts_on > m_ends + other_days THEN
    RAISE EXCEPTION 'a pause must start inside a live membership''s validity'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_membership_pauses_within_membership';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_membership_pauses_within_membership" BEFORE INSERT OR UPDATE ON "club_membership_pauses" FOR EACH ROW EXECUTE FUNCTION club_membership_pause_within_membership();--> statement-breakpoint
-- club_charges: never deleted (outside a purge of the club); the only updates
-- are voiding — once, irreversibly — and the SET NULLs that a member's or a
-- membership's erasure cascades. Everything else about a charge is a fact.
CREATE FUNCTION club_charges_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  probe public.club_charges%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.club_id::text = current_setting('pops.purging_club', true) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'club_charges rows are voided, never deleted';
  END IF;
  probe := NEW;
  probe.voided_at := OLD.voided_at;
  probe.member_id := OLD.member_id;
  probe.membership_id := OLD.membership_id;
  IF probe IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'club_charges: only voiding and anonymisation may change a charge';
  END IF;
  IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS DISTINCT FROM OLD.voided_at THEN
    RAISE EXCEPTION 'club_charges: a void is final';
  END IF;
  IF NEW.member_id IS DISTINCT FROM OLD.member_id AND NEW.member_id IS NOT NULL THEN
    RAISE EXCEPTION 'club_charges: member_id may only be cleared';
  END IF;
  IF NEW.membership_id IS DISTINCT FROM OLD.membership_id AND NEW.membership_id IS NOT NULL THEN
    RAISE EXCEPTION 'club_charges: membership_id may only be cleared';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_charges_guard_update" BEFORE UPDATE ON "club_charges" FOR EACH ROW EXECUTE FUNCTION club_charges_guard();--> statement-breakpoint
CREATE TRIGGER "club_charges_guard_delete" BEFORE DELETE ON "club_charges" FOR EACH ROW EXECUTE FUNCTION club_charges_guard();--> statement-breakpoint
CREATE TRIGGER "club_charges_no_truncate" BEFORE TRUNCATE ON "club_charges" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
-- club_payments: append-only. The one UPDATE admitted is member_id → NULL,
-- which is what the club erasing its client cascades; the amount, the charge
-- and the dates never change. DELETE only during a purge of the club.
CREATE FUNCTION club_payments_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  probe public.club_payments%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.club_id::text = current_setting('pops.purging_club', true) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'club_payments is append-only (record a refund instead)';
  END IF;
  probe := NEW;
  probe.member_id := OLD.member_id;
  IF probe IS DISTINCT FROM OLD OR NEW.member_id IS NOT NULL THEN
    RAISE EXCEPTION 'club_payments is append-only (record a refund instead)';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_payments_guard_update" BEFORE UPDATE ON "club_payments" FOR EACH ROW EXECUTE FUNCTION club_payments_guard();--> statement-breakpoint
CREATE TRIGGER "club_payments_guard_delete" BEFORE DELETE ON "club_payments" FOR EACH ROW EXECUTE FUNCTION club_payments_guard();--> statement-breakpoint
CREATE TRIGGER "club_payments_no_truncate" BEFORE TRUNCATE ON "club_payments" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
-- The running total of a charge's payments stays within [0, amount], and a
-- voided charge accepts only refunds. The charge row is locked first, so two
-- desks recording against one charge are serialised rather than both passing.
-- FOR NO KEY UPDATE, not FOR UPDATE: it serialises payments against each
-- other and against a void (an UPDATE) while staying compatible with the FK
-- checks of concurrent inserts that merely reference the charge (a drop-in
-- check-in). The sum below is correct under READ COMMITTED, the application's
-- isolation level: after the lock is granted, the statement sees every payment
-- committed by the transaction it waited for.
CREATE FUNCTION club_payments_within_charge() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  charge_amount integer;
  charge_voided timestamptz;
  paid bigint;
BEGIN
  SELECT c.amount_cents, c.voided_at INTO charge_amount, charge_voided
    FROM public.club_charges c
   WHERE c.club_id = NEW.club_id AND c.id = NEW.charge_id
   FOR NO KEY UPDATE;
  IF charge_amount IS NULL THEN
    -- Left to the foreign key, which reports it properly as 23503.
    RETURN NEW;
  END IF;
  IF charge_voided IS NOT NULL AND NEW.kind = 'payment' THEN
    RAISE EXCEPTION 'club_payments: the charge is void'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_payments_charge_not_void';
  END IF;
  SELECT coalesce(sum(p.amount_cents), 0) INTO paid
    FROM public.club_payments p
   WHERE p.charge_id = NEW.charge_id;
  IF paid + NEW.amount_cents > charge_amount OR paid + NEW.amount_cents < 0 THEN
    RAISE EXCEPTION 'club_payments: total would leave [0, %]', charge_amount
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_payments_within_charge';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_payments_within_charge" BEFORE INSERT ON "club_payments" FOR EACH ROW EXECUTE FUNCTION club_payments_within_charge();--> statement-breakpoint
CREATE TRIGGER "club_plans_set_updated_at" BEFORE UPDATE ON "club_plans" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER "club_memberships_set_updated_at" BEFORE UPDATE ON "club_memberships" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- The single definition of what a charge's status is. LATERAL so a query for
-- one club reads only that club's payments through club_payments_charge_idx.
-- security_invoker, as every view in this schema (0008).
CREATE VIEW "club_charge_balances" WITH (security_invoker = true) AS
SELECT
  ch.id AS charge_id,
  ch.club_id,
  ch.member_id,
  ch.membership_id,
  ch.kind,
  ch.label,
  ch.amount_cents,
  ch.issued_on,
  ch.due_on,
  ch.voided_at,
  ch.created_at,
  coalesce(p.paid_cents, 0)::integer AS paid_cents,
  -- A void charge is owed by nobody; any money still on it is a refund the
  -- club owes, which the office reads from paid_cents on a 'void' row.
  CASE WHEN ch.voided_at IS NOT NULL THEN 0
       ELSE (ch.amount_cents - coalesce(p.paid_cents, 0))::integer
  END AS due_cents,
  CASE
    WHEN ch.voided_at IS NOT NULL THEN 'void'
    WHEN coalesce(p.paid_cents, 0) >= ch.amount_cents THEN 'paid'
    WHEN ch.due_on < (now() AT TIME ZONE 'Europe/Sofia')::date THEN 'overdue'
    WHEN coalesce(p.paid_cents, 0) > 0 THEN 'partial'
    ELSE 'open'
  END AS status
FROM public.club_charges ch
LEFT JOIN LATERAL (
  SELECT sum(pay.amount_cents) AS paid_cents
    FROM public.club_payments pay
   WHERE pay.charge_id = ch.id
) p ON true;--> statement-breakpoint
ALTER TABLE "club_plans" ADD CONSTRAINT "club_plans_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_plan_fk" FOREIGN KEY ("club_id","plan_id") REFERENCES "public"."club_plans"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_membership_pauses" ADD CONSTRAINT "club_membership_pauses_membership_fk" FOREIGN KEY ("club_id","membership_id") REFERENCES "public"."club_memberships"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_charges" ADD CONSTRAINT "club_charges_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_charges" ADD CONSTRAINT "club_charges_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE set null ("member_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_charges" ADD CONSTRAINT "club_charges_membership_fk" FOREIGN KEY ("club_id","membership_id") REFERENCES "public"."club_memberships"("club_id","id") ON DELETE set null ("membership_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_payments" ADD CONSTRAINT "club_payments_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_payments" ADD CONSTRAINT "club_payments_charge_fk" FOREIGN KEY ("club_id","charge_id") REFERENCES "public"."club_charges"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_payments" ADD CONSTRAINT "club_payments_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE set null ("member_id") ON UPDATE no action;--> statement-breakpoint
COMMENT ON TABLE "club_plans" IS 'What a club sells: unlimited for a period, a card of N visits, or a trial. Prices in EUR cents. Archived, never deleted, once sold (club_memberships references it with NO ACTION).';--> statement-breakpoint
COMMENT ON TABLE "club_memberships" IS 'One sale of a plan to a member, with a SNAPSHOT of the plan so later plan edits never rewrite a purchase. Visits used are derived from club_checkins (0043), never a counter; visits_used_offset carries usage from before a CSV import.';--> statement-breakpoint
COMMENT ON TABLE "club_charges" IS 'What a member owes. Voided, never deleted; the guard admits only voiding (once) and the SET NULLs of an erasure. Status is derived in club_charge_balances.';--> statement-breakpoint
COMMENT ON TABLE "club_payments" IS 'Money a club RECORDS as received — POPS never moves money in v1. Append-only: a refund is a new negative row. No card data, payer bank details, fiscal receipt numbers or VAT: those stay with the club''s fiscal device and accountant. provider/provider_ref are the phase-2 Stripe seam (the club''s own account, hosted page by redirect).';--> statement-breakpoint
COMMENT ON VIEW "club_charge_balances" IS 'The single definition of a charge''s paid, due and status (void, paid, overdue, partial, open), against the civil Sofia date. Everything that says "unpaid" or "overdue" reads this.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
