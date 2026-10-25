-- 0050_club_wallet_invoices: «Клубове» v2, wave B2 (plan 2026-10-25) — a
-- client's prepaid CREDIT (1club's wallet) and the club's INVOICES and credit
-- notes (1club's invoices). Hand-written; do not regenerate.
--
-- THE WALLET is not a new ledger. It is derived from the 0041 books, so the
-- club has one record of money:
--   * a TOP-UP is a charge of kind 'wallet', created already paid — at the
--     desk together with its payment, or online when the money arrives (a
--     checkout of purpose 'wallet' carries the amount and the charge's label);
--     a wallet charge always names its client (club_charges_wallet_client);
--   * SPENDING credit is a payment with method 'wallet' against any other
--     charge of the same client; a 'wallet' refund gives spent credit back on
--     that charge, never more than was spent on it (a reversed till sale, a
--     refunded booking) — so cash paid for a charge cannot turn into credit;
--   * the BALANCE is club_wallet_balances: what was loaded (net payments on
--     the client's wallet charges) minus what was spent (net 'wallet'
--     payments on the client's charges). club_payments_wallet refuses any
--     row the CLUB writes that would take it below zero, under a lock on the
--     charge and then the client, so two desks cannot spend the same euro.
--     A refund the PROVIDER reports (Stripe, provider <> 'manual') is a fact
--     — the money has already left — and is recorded whatever the balance; a
--     balance below zero is then what the client owes back, and spending
--     stops until it is settled;
--   * a top-up is never OWED: club_charge_balances gives a wallet charge no
--     due amount, so paying credit back in cash lowers what was loaded rather
--     than reopening a debt — and a wallet charge with money on it is never
--     voided (club_charges_wallet_void: refund the credit instead);
--   * a client is never erased with credit left (the application refuses:
--     it is the client's money, paid back first), so a wallet charge without
--     a client holds none.
--   Revenue reports count money RECEIVED and leave 'wallet' payments out: the
--   money came in once, as the top-up.
--
-- INVOICES
--   club_invoice_settings  what an invoice prints about the club beyond the
--                          0039 legal_name and eik: its address, VAT number,
--                          IBAN, the VAT rate for what is not a product (a
--                          product line carries its own, 0049), and the legal
--                          basis it prints for a 0 % line. A club without a
--                          VAT number invoices without VAT. A table of its
--                          own, so this file never locks `clubs` exclusively.
--   club_invoices, club_invoice_lines
--                          an invoice or a credit note: a number from the
--                          club's gapless counter (kind 'invoice', ONE series
--                          for both, printed as 10 digits), never issued on a
--                          date before the previous number's; the tax event
--                          date; SNAPSHOTS of the club and of the buyer (a
--                          person, or a company with its EIK or VAT number);
--                          the payment method; the lines with their VAT split,
--                          which must ADD UP to the totals (checked at commit)
--                          and can only be written with their document; the
--                          totals. Never edited, never deleted: a mistake is
--                          corrected by a credit note, which carries the
--                          corrected invoice's charge and parties unchanged
--                          and never exceeds what is left of it. An invoice is
--                          issued for one live charge of its own client, at
--                          most one live invoice per charge, and never for a
--                          wallet top-up: prepaid credit is invoiced when it
--                          is SPENT (where the VAT falls), not when loaded.
--   A number is drawn only for a document: a counter row that commits without
--   the sale or invoice that took its number is refused at commit
--   (club_number_sequences_used — a gap in an invoice series is a legal
--   defect), and a new document takes the number its own transaction drew
--   (the 0049 sales rule).
--
-- PERSONAL DATA: an invoice is an accounting document the club must keep (the
-- Accounting Act's retention period), so erasing the client clears member_id
-- but keeps the buyer's name and address printed on it — the club's legal
-- obligation, not consent. No contact-person column (CLAUDE.md: a company's
-- contact is a natural person and lives in the club's own records), and never
-- a personal identification number: a person buyer is a name and, if they
-- give one, an address.
--
--   Vocabulary: charge kind 'wallet'; payment method 'wallet'; checkout
--   purpose 'wallet'; counter kind 'invoice'; audit actions wallet_topped_up,
--   invoice_issued, credit_note_issued.
--
-- TENANCY and DELETES as 0049: composite (club_id, id) keys; references inside
-- a club are NO ACTION, purge-safe because each new table has its OWN
-- club_id → clubs CASCADE (club_invoice_lines included), so the purge empties
-- them in the first round of referential actions. A credit note's reference to
-- its invoice is never cleared (invoices are never deleted); issued_by is a
-- staff id by value (0039 rule 5).
--
-- Locking: LOCK TABLE first, in the order of the club tables' foreign keys:
-- SHARE ROW EXCLUSIVE on clubs and club_members (the new keys), then ACCESS
-- EXCLUSIVE on what is altered — club_charge_balances (replaced; a lock on a
-- view takes its tables too), club_charges and club_payments (a CHECK swap
-- and a trigger), club_checkouts (a column, CHECKs, the guard),
-- club_number_sequences and club_audit (a CHECK swap — VALIDATE scans them).
-- A payment, a sale or an erasure in flight takes some of these in another
-- order (row locks run charge → client in the new trigger, while an erasure
-- locks the client first — a collision that already existed through the
-- payment's key check); Postgres aborts one side after ~1 s, pg-boss retries
-- a job and the office re-submits. Deploy at a quiet hour, never during a
-- club purge; a red deploy is simply re-run. The application keeps its own
-- orders: one charge per payment transaction, and an invoice locks its
-- charge before it draws a number (charge → invoice counter → invoice).
--
-- rollback (after reverting the application), in ONE explicit transaction, at
-- a quiet hour. Most of this file STAYS, on purpose: issued invoices are
-- statutory records (never dropped — the reverted application simply never
-- reads them); the wallet guards and the replaced club_charge_balances keep
-- the widened 'wallet' method and the top-ups safe and never read as debt.
--   SET LOCAL lock_timeout = '3s';
--   FIRST re-create 0049's club_checkouts_guard() exactly as 0049 defines it
--   (it does not name `label`, so it is valid before and after the drop);
--   DROP TRIGGER "club_checkouts_wallet_insert" ON "club_checkouts";
--   ALTER TABLE "club_checkouts" DROP COLUMN "label";   -- only once every
--     'wallet' checkout is settled; DESTRUCTIVE: each online top-up's label
--   DROP FUNCTION club_checkouts_wallet_insert();
--   optionally DROP TABLE "club_invoice_settings";      -- DESTRUCTIVE: settings
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "clubs", "club_members" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_charge_balances", "club_charges", "club_payments", "club_checkouts", "club_number_sequences", "club_audit" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
-- ─── What an invoice prints about the club ────────────────────────────────
CREATE TABLE "club_invoice_settings" (
	"club_id" uuid PRIMARY KEY NOT NULL,
	"legal_address" text,
	"vat_number" text,
	"iban" text,
	"invoice_vat_bp" integer DEFAULT 2000 NOT NULL,
	"zero_vat_basis" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_invoice_settings_sane" CHECK (("club_invoice_settings"."legal_address" IS NULL OR (btrim("club_invoice_settings"."legal_address") <> '' AND char_length("club_invoice_settings"."legal_address") <= 300))
      AND ("club_invoice_settings"."zero_vat_basis" IS NULL OR (btrim("club_invoice_settings"."zero_vat_basis") <> '' AND char_length("club_invoice_settings"."zero_vat_basis") <= 200))
      AND ("club_invoice_settings"."vat_number" IS NULL OR "club_invoice_settings"."vat_number" ~ '^BG[0-9]{9,10}$')
      AND ("club_invoice_settings"."iban" IS NULL OR "club_invoice_settings"."iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$')
      AND "club_invoice_settings"."invoice_vat_bp" IN (0, 900, 2000))
);
--> statement-breakpoint
ALTER TABLE "club_invoice_settings" ADD CONSTRAINT "club_invoice_settings_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER "club_invoice_settings_set_updated_at" BEFORE UPDATE ON "club_invoice_settings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- ─── The wallet ───────────────────────────────────────────────────────────
ALTER TABLE "club_charges" DROP CONSTRAINT "club_charges_kind_known";--> statement-breakpoint
ALTER TABLE "club_charges" ADD CONSTRAINT "club_charges_kind_known" CHECK ("club_charges"."kind" IN ('membership', 'drop_in', 'product', 'fee', 'reservation', 'wallet', 'other')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_charges" VALIDATE CONSTRAINT "club_charges_kind_known";--> statement-breakpoint
ALTER TABLE "club_payments" DROP CONSTRAINT "club_payments_method_known";--> statement-breakpoint
ALTER TABLE "club_payments" ADD CONSTRAINT "club_payments_method_known" CHECK ("club_payments"."method" IN ('cash', 'card_desk', 'bank', 'card_online', 'wallet', 'other')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_payments" VALIDATE CONSTRAINT "club_payments_method_known";--> statement-breakpoint
-- A top-up names its client when written (not a CHECK: an erasure later
-- nulls member_id — by then with no credit left on it).
CREATE FUNCTION club_charges_wallet_client() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.kind = 'wallet' AND NEW.member_id IS NULL THEN
    RAISE EXCEPTION 'club_charges: credit is loaded for a client'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_charges_wallet_client';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_charges_wallet_client" BEFORE INSERT ON "club_charges" FOR EACH ROW EXECUTE FUNCTION club_charges_wallet_client();--> statement-breakpoint
-- The single definition of a client's credit. Grouped over the client's
-- charges only (club_charges_member_idx), so a query for one client reads
-- that client's rows.
CREATE VIEW "club_wallet_balances" WITH (security_invoker = true) AS
SELECT
  ch.club_id,
  ch.member_id,
  sum(CASE WHEN ch.kind = 'wallet' THEN p.amount_cents ELSE 0 END)::bigint AS loaded_cents,
  sum(CASE WHEN p.method = 'wallet' THEN p.amount_cents ELSE 0 END)::bigint AS spent_cents,
  sum(CASE WHEN ch.kind = 'wallet' THEN p.amount_cents ELSE 0 END
      - CASE WHEN p.method = 'wallet' THEN p.amount_cents ELSE 0 END)::bigint AS balance_cents
FROM public.club_charges ch
JOIN public.club_payments p ON p.charge_id = ch.id
WHERE ch.member_id IS NOT NULL AND (ch.kind = 'wallet' OR p.method = 'wallet')
GROUP BY ch.club_id, ch.member_id;--> statement-breakpoint
-- Credit is the charge's own client's, never paid with credit, given back on a
-- charge no more than was spent on it, and — for every row the club writes —
-- never taken below zero. Named to fire BEFORE club_payments_within_charge
-- (triggers fire in name order); it locks the charge first, as every money
-- path does, then the client, so two desks spending one client's credit are
-- serialised and the sums below see every payment committed before the locks
-- were granted. A refund the provider reports is recorded whatever the
-- balance: the money has already left.
CREATE FUNCTION club_payments_wallet() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  charge_kind text;
  charge_member uuid;
  balance bigint;
  spent_here bigint;
  delta bigint;
BEGIN
  SELECT c.kind, c.member_id INTO charge_kind, charge_member
    FROM public.club_charges c
   WHERE c.club_id = NEW.club_id AND c.id = NEW.charge_id
   FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN NEW; -- left to the foreign key (23503)
  END IF;
  IF NEW.method <> 'wallet' AND charge_kind <> 'wallet' THEN
    RETURN NEW;
  END IF;
  IF charge_kind = 'wallet' AND NEW.method = 'wallet' THEN
    RAISE EXCEPTION 'club_payments: credit is not paid with credit'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_payments_wallet_not_circular';
  END IF;
  IF NEW.method = 'wallet' AND NEW.kind = 'refund' THEN
    SELECT coalesce(sum(p.amount_cents), 0) INTO spent_here
      FROM public.club_payments p
     WHERE p.charge_id = NEW.charge_id AND p.method = 'wallet';
    IF spent_here + NEW.amount_cents < 0 THEN
      RAISE EXCEPTION 'club_payments: credit goes back only as far as it was spent here'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_payments_wallet_refund';
    END IF;
  END IF;
  IF charge_member IS NULL THEN
    -- An erased client's charge: giving spent credit back to a wallet that no
    -- longer exists changes no balance (the view counts named clients only),
    -- and a refund the provider reports on a top-up is a fact. Anything else
    -- would move credit that belongs to nobody.
    IF NEW.kind = 'refund' AND (charge_kind <> 'wallet' OR NEW.provider <> 'manual') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'club_payments: credit is the charge''s own client''s'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_payments_wallet_member';
  END IF;
  IF NEW.method = 'wallet' AND NEW.member_id IS DISTINCT FROM charge_member THEN
    RAISE EXCEPTION 'club_payments: credit is the charge''s own client''s'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_payments_wallet_member';
  END IF;
  PERFORM 1 FROM public.club_members m
   WHERE m.club_id = NEW.club_id AND m.id = charge_member
   FOR NO KEY UPDATE;
  IF NEW.kind = 'refund' AND NEW.provider <> 'manual' THEN
    RETURN NEW;
  END IF;
  delta := CASE WHEN NEW.method = 'wallet' THEN -NEW.amount_cents ELSE NEW.amount_cents END;
  IF delta < 0 THEN
    SELECT coalesce(sum(w.balance_cents), 0) INTO balance
      FROM public.club_wallet_balances w
     WHERE w.club_id = NEW.club_id AND w.member_id = charge_member;
    IF balance + delta < 0 THEN
      RAISE EXCEPTION 'club_payments: not enough credit'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_payments_wallet_balance';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_payments_wallet" BEFORE INSERT ON "club_payments" FOR EACH ROW EXECUTE FUNCTION club_payments_wallet();--> statement-breakpoint
-- 0041's view, with one rule added: a wallet charge is never owed.
CREATE OR REPLACE VIEW "club_charge_balances" WITH (security_invoker = true) AS
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
  -- club owes, which the office reads from paid_cents on a 'void' row. A
  -- wallet top-up (0050) is owed by nobody either: it exists because money
  -- came in, and credit paid back lowers what was loaded.
  CASE WHEN ch.voided_at IS NOT NULL OR ch.kind = 'wallet' THEN 0
       ELSE (ch.amount_cents - coalesce(p.paid_cents, 0))::integer
  END AS due_cents,
  CASE
    WHEN ch.voided_at IS NOT NULL THEN 'void'
    WHEN ch.kind = 'wallet' OR coalesce(p.paid_cents, 0) >= ch.amount_cents THEN 'paid'
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
-- Credit with money on it is refunded, never voided: a void row with money on
-- it would read as a refund the club owes, on top of the credit itself.
CREATE FUNCTION club_charges_wallet_void() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.kind = 'wallet' AND OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
     AND coalesce((SELECT sum(p.amount_cents) FROM public.club_payments p
                    WHERE p.charge_id = OLD.id), 0) <> 0 THEN
    RAISE EXCEPTION 'club_charges: credit is refunded, never voided'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_charges_wallet_void';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_charges_wallet_void" BEFORE UPDATE OF "voided_at" ON "club_charges" FOR EACH ROW EXECUTE FUNCTION club_charges_wallet_void();--> statement-breakpoint
-- An online top-up: the checkout carries the charge's label (the web app's
-- words, in the club's language), and the charge is created when the money
-- arrives — an abandoned top-up leaves nothing behind.
ALTER TABLE "club_checkouts" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "club_checkouts" DROP CONSTRAINT "club_checkouts_purpose_known";--> statement-breakpoint
ALTER TABLE "club_checkouts" ADD CONSTRAINT "club_checkouts_purpose_known" CHECK ("club_checkouts"."purpose" IN ('charge', 'membership', 'wallet')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_checkouts" VALIDATE CONSTRAINT "club_checkouts_purpose_known";--> statement-breakpoint
ALTER TABLE "club_checkouts" ADD CONSTRAINT "club_checkouts_label_sane" CHECK ("club_checkouts"."label" IS NULL OR (btrim("club_checkouts"."label") <> '' AND char_length("club_checkouts"."label") <= 120));--> statement-breakpoint
-- A label exactly for a top-up. charge_id is SET once the money creates the
-- charge (the guard allows a NULL charge_id to be set), so only what is fixed
-- from the start is named here.
ALTER TABLE "club_checkouts" ADD CONSTRAINT "club_checkouts_wallet_target" CHECK (("club_checkouts"."purpose" = 'wallet') = ("club_checkouts"."label" IS NOT NULL)
      AND ("club_checkouts"."purpose" <> 'wallet' OR ("club_checkouts"."plan_id" IS NULL AND "club_checkouts"."starts_on" IS NULL)));--> statement-breakpoint
-- A top-up checkout is opened for a client, with no charge yet (not CHECKs:
-- an erasure later nulls member_id, and the money later sets charge_id).
CREATE FUNCTION club_checkouts_wallet_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.purpose = 'wallet' AND (NEW.member_id IS NULL OR NEW.charge_id IS NOT NULL) THEN
    RAISE EXCEPTION 'club_checkouts: a top-up is opened for a client, before its charge exists'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_checkouts_wallet_insert';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_checkouts_wallet_insert" BEFORE INSERT ON "club_checkouts" FOR EACH ROW EXECUTE FUNCTION club_checkouts_wallet_insert();--> statement-breakpoint
-- 0049's guard, with the label joining what a checkout is for.
CREATE OR REPLACE FUNCTION club_checkouts_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.club_id IS DISTINCT FROM OLD.club_id OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.starts_on IS DISTINCT FROM OLD.starts_on
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.account_ref IS DISTINCT FROM OLD.account_ref
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.promotion_id IS DISTINCT FROM OLD.promotion_id
     OR NEW.discount_cents IS DISTINCT FROM OLD.discount_cents
     OR NEW.label IS DISTINCT FROM OLD.label THEN
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
-- ─── Invoices and credit notes ────────────────────────────────────────────
ALTER TABLE "club_number_sequences" DROP CONSTRAINT "club_number_sequences_kind_known";--> statement-breakpoint
ALTER TABLE "club_number_sequences" ADD CONSTRAINT "club_number_sequences_kind_known" CHECK ("club_number_sequences"."kind" IN ('sale', 'invoice')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_number_sequences" VALIDATE CONSTRAINT "club_number_sequences_kind_known";--> statement-breakpoint
CREATE TABLE "club_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"number" bigint NOT NULL,
	"issued_on" date NOT NULL,
	"tax_event_on" date NOT NULL,
	"corrects_id" uuid,
	"reason" text,
	"charge_id" uuid NOT NULL,
	"member_id" uuid,
	"supplier_name" text NOT NULL,
	"supplier_eik" text NOT NULL,
	"supplier_vat_number" text,
	"supplier_address" text NOT NULL,
	"supplier_iban" text,
	"buyer_kind" text NOT NULL,
	"buyer_name" text NOT NULL,
	"buyer_eik" text,
	"buyer_vat_number" text,
	"buyer_address" text,
	"payment_method" text NOT NULL,
	"zero_vat_basis" text,
	"base_cents" integer NOT NULL,
	"vat_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	"issued_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_invoices_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_invoices_number_unique" UNIQUE("club_id", "number"),
	CONSTRAINT "club_invoices_kind_known" CHECK ("club_invoices"."kind" IN ('invoice', 'credit_note')),
	CONSTRAINT "club_invoices_number_sane" CHECK ("club_invoices"."number" BETWEEN 1 AND 9999999999),
	CONSTRAINT "club_invoices_dates_sane" CHECK (isfinite("club_invoices"."issued_on") AND isfinite("club_invoices"."tax_event_on")
      AND "club_invoices"."tax_event_on" <= "club_invoices"."issued_on"),
	-- corrects_id is never cleared: invoices are never deleted.
	CONSTRAINT "club_invoices_correction_pair" CHECK (("club_invoices"."kind" = 'credit_note') = ("club_invoices"."corrects_id" IS NOT NULL)
      AND ("club_invoices"."kind" = 'credit_note') = ("club_invoices"."reason" IS NOT NULL)),
	CONSTRAINT "club_invoices_reason_sane" CHECK ("club_invoices"."reason" IS NULL OR (btrim("club_invoices"."reason") <> '' AND char_length("club_invoices"."reason") <= 200)),
	CONSTRAINT "club_invoices_supplier_sane" CHECK (btrim("club_invoices"."supplier_name") <> '' AND char_length("club_invoices"."supplier_name") <= 200
      AND "club_invoices"."supplier_eik" ~ '^([0-9]{9}|[0-9]{13})$'
      AND ("club_invoices"."supplier_vat_number" IS NULL OR "club_invoices"."supplier_vat_number" ~ '^BG[0-9]{9,10}$')
      AND btrim("club_invoices"."supplier_address") <> '' AND char_length("club_invoices"."supplier_address") <= 300
      AND ("club_invoices"."supplier_iban" IS NULL OR "club_invoices"."supplier_iban" ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$')),
	CONSTRAINT "club_invoices_buyer_kind_known" CHECK ("club_invoices"."buyer_kind" IN ('person', 'company')),
	CONSTRAINT "club_invoices_buyer_sane" CHECK (btrim("club_invoices"."buyer_name") <> '' AND char_length("club_invoices"."buyer_name") <= 200
      AND ("club_invoices"."buyer_address" IS NULL OR (btrim("club_invoices"."buyer_address") <> '' AND char_length("club_invoices"."buyer_address") <= 300))
      AND ("club_invoices"."buyer_eik" IS NULL OR "club_invoices"."buyer_eik" ~ '^([0-9]{9}|[0-9]{13})$')
      AND ("club_invoices"."buyer_vat_number" IS NULL OR "club_invoices"."buyer_vat_number" ~ '^[A-Z]{2}[A-Z0-9]{2,13}$')),
	-- A company is identified by its EIK or (a foreign one) its VAT number,
	-- and an address; a person by a name only (never an identification number).
	CONSTRAINT "club_invoices_buyer_identified" CHECK (("club_invoices"."buyer_kind" = 'company'
          AND ("club_invoices"."buyer_eik" IS NOT NULL OR "club_invoices"."buyer_vat_number" IS NOT NULL)
          AND "club_invoices"."buyer_address" IS NOT NULL)
      OR ("club_invoices"."buyer_kind" = 'person'
          AND "club_invoices"."buyer_eik" IS NULL AND "club_invoices"."buyer_vat_number" IS NULL)),
	-- The legal basis a VAT-registered club prints for its 0 % lines (the
	-- club's own words, snapshotted; the application requires it for such a
	-- line).
	CONSTRAINT "club_invoices_zero_basis_sane" CHECK ("club_invoices"."zero_vat_basis" IS NULL
      OR (btrim("club_invoices"."zero_vat_basis") <> '' AND char_length("club_invoices"."zero_vat_basis") <= 200)),
	CONSTRAINT "club_invoices_payment_known" CHECK ("club_invoices"."payment_method" IN ('cash', 'card', 'bank', 'online', 'wallet', 'other', 'unpaid')),
	CONSTRAINT "club_invoices_money_sane" CHECK ("club_invoices"."total_cents" BETWEEN 1 AND 10000000
      AND "club_invoices"."base_cents" BETWEEN 0 AND "club_invoices"."total_cents"
      AND "club_invoices"."vat_cents" = "club_invoices"."total_cents" - "club_invoices"."base_cents"),
	-- VAT only from a registered supplier.
	CONSTRAINT "club_invoices_vat_needs_number" CHECK ("club_invoices"."vat_cents" = 0 OR "club_invoices"."supplier_vat_number" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "club_invoices" ADD CONSTRAINT "club_invoices_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_invoices" ADD CONSTRAINT "club_invoices_corrects_fk" FOREIGN KEY ("club_id","corrects_id") REFERENCES "public"."club_invoices"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_invoices" ADD CONSTRAINT "club_invoices_charge_fk" FOREIGN KEY ("club_id","charge_id") REFERENCES "public"."club_charges"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Erasing the client keeps the document (the club's legal obligation).
ALTER TABLE "club_invoices" ADD CONSTRAINT "club_invoices_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE set null ("member_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_invoices_club_idx" ON "club_invoices" USING btree ("club_id","issued_on" DESC, "number" DESC);--> statement-breakpoint
CREATE INDEX "club_invoices_charge_idx" ON "club_invoices" USING btree ("club_id","charge_id");--> statement-breakpoint
CREATE INDEX "club_invoices_member_idx" ON "club_invoices" USING btree ("club_id","member_id") WHERE "club_invoices"."member_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_invoices_corrects_idx" ON "club_invoices" USING btree ("club_id","corrects_id") WHERE "club_invoices"."corrects_id" IS NOT NULL;--> statement-breakpoint
-- A document, decided at INSERT; after that never changed (an erasure may clear
-- member_id) and never deleted outside a purge.
--   * it takes the number its own transaction just drew, on a date no earlier
--     than the previous number's, and is stamped with the transaction's start
--     (its lines must carry the same stamp: club_invoice_lines_guard);
--   * a credit note corrects an INVOICE of the same club, by no more than is
--     left of it, with the invoice's charge and parties unchanged — locking
--     the invoice first, so two credit notes cannot both pass;
--   * an invoice is for a live charge of its own client, never a wallet
--     top-up, and the charge has no other live invoice — locking the charge
--     first, the lock every money path takes.
CREATE FUNCTION club_invoices_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  probe public.club_invoices%ROWTYPE;
  corrected public.club_invoices%ROWTYPE;
  left_cents bigint;
  charge_kind text;
  charge_member uuid;
  charge_voided timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
    IF NEW.number IS DISTINCT FROM (SELECT q.last_value FROM public.club_number_sequences q
                                     WHERE q.club_id = NEW.club_id AND q.kind = 'invoice') THEN
      RAISE EXCEPTION 'club_invoices: a document takes the number just drawn from its counter'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_invoices_number_drawn';
    END IF;
    IF EXISTS (SELECT 1 FROM public.club_invoices p
                WHERE p.club_id = NEW.club_id AND p.number = NEW.number - 1
                  AND p.issued_on > NEW.issued_on) THEN
      RAISE EXCEPTION 'club_invoices: a document is never dated before the previous number'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_invoices_chronology';
    END IF;
    IF NEW.kind = 'credit_note' THEN
      SELECT * INTO corrected FROM public.club_invoices i
       WHERE i.club_id = NEW.club_id AND i.id = NEW.corrects_id
       FOR NO KEY UPDATE;
      IF NOT FOUND THEN
        RETURN NEW; -- left to the foreign key (23503)
      END IF;
      SELECT corrected.total_cents - coalesce(sum(c.total_cents), 0) INTO left_cents
        FROM public.club_invoices c
       WHERE c.club_id = NEW.club_id AND c.corrects_id = corrected.id;
      IF corrected.kind <> 'invoice' OR NEW.total_cents > left_cents
         OR (NEW.charge_id, NEW.supplier_name, NEW.supplier_eik, NEW.supplier_vat_number,
             NEW.supplier_address, NEW.supplier_iban, NEW.buyer_kind, NEW.buyer_name,
             NEW.buyer_eik, NEW.buyer_vat_number, NEW.buyer_address, NEW.zero_vat_basis)
            IS DISTINCT FROM
            (corrected.charge_id, corrected.supplier_name, corrected.supplier_eik,
             corrected.supplier_vat_number, corrected.supplier_address, corrected.supplier_iban,
             corrected.buyer_kind, corrected.buyer_name, corrected.buyer_eik,
             corrected.buyer_vat_number, corrected.buyer_address, corrected.zero_vat_basis) THEN
        RAISE EXCEPTION 'club_invoices: a credit note corrects its invoice, as issued, by no more than is left of it'
          USING ERRCODE = 'check_violation', CONSTRAINT = 'club_invoices_credit_within_invoice';
      END IF;
      RETURN NEW;
    END IF;
    SELECT ch.kind, ch.member_id, ch.voided_at INTO charge_kind, charge_member, charge_voided
      FROM public.club_charges ch
     WHERE ch.club_id = NEW.club_id AND ch.id = NEW.charge_id
     FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RETURN NEW; -- left to the foreign key (23503)
    END IF;
    IF charge_voided IS NOT NULL OR charge_kind = 'wallet'
       OR NEW.member_id IS DISTINCT FROM charge_member THEN
      RAISE EXCEPTION 'club_invoices: an invoice is for a live charge of its own client, never a top-up'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_invoices_charge_invoiceable';
    END IF;
    IF EXISTS (SELECT 1 FROM public.club_invoices i
                WHERE i.club_id = NEW.club_id AND i.charge_id = NEW.charge_id
                  AND i.kind = 'invoice'
                  AND i.total_cents > coalesce((SELECT sum(c.total_cents) FROM public.club_invoices c
                                                 WHERE c.club_id = i.club_id AND c.corrects_id = i.id), 0)) THEN
      RAISE EXCEPTION 'club_invoices: the charge already has a live invoice'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_invoices_one_per_charge';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.club_id::text = current_setting('pops.purging_club', true) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'club_invoices: an invoice is corrected by a credit note, never deleted';
  END IF;
  probe := NEW;
  probe.member_id := OLD.member_id;
  IF probe IS DISTINCT FROM OLD OR NEW.member_id IS NOT NULL THEN
    RAISE EXCEPTION 'club_invoices: an invoice is never changed (issue a credit note)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_invoices_fact';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_invoices_guard" BEFORE INSERT OR UPDATE OR DELETE ON "club_invoices" FOR EACH ROW EXECUTE FUNCTION club_invoices_guard();--> statement-breakpoint
CREATE TRIGGER "club_invoices_no_truncate" BEFORE TRUNCATE ON "club_invoices" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
CREATE TABLE "club_invoice_lines" (
	"club_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"vat_rate_bp" integer,
	"base_cents" integer NOT NULL,
	"vat_cents" integer NOT NULL,
	"total_cents" integer NOT NULL,
	CONSTRAINT "club_invoice_lines_pkey" PRIMARY KEY("invoice_id", "line_no"),
	CONSTRAINT "club_invoice_lines_line_sane" CHECK ("club_invoice_lines"."line_no" BETWEEN 1 AND 200),
	CONSTRAINT "club_invoice_lines_description_sane" CHECK (btrim("club_invoice_lines"."description") <> '' AND char_length("club_invoice_lines"."description") <= 200),
	CONSTRAINT "club_invoice_lines_quantity_sane" CHECK ("club_invoice_lines"."quantity" BETWEEN 1 AND 1000),
	-- Gross, as charged: the line total is what the client paid for it, split
	-- into its tax base and VAT. In bigint: 10 000 000 cents × 1000.
	CONSTRAINT "club_invoice_lines_money_sane" CHECK ("club_invoice_lines"."unit_price_cents" BETWEEN 0 AND 10000000
      AND "club_invoice_lines"."discount_cents"::bigint BETWEEN 0 AND "club_invoice_lines"."unit_price_cents"::bigint * "club_invoice_lines"."quantity"
      AND "club_invoice_lines"."total_cents"::bigint = "club_invoice_lines"."unit_price_cents"::bigint * "club_invoice_lines"."quantity" - "club_invoice_lines"."discount_cents"
      AND "club_invoice_lines"."total_cents" <= 10000000
      AND "club_invoice_lines"."base_cents" >= 0 AND "club_invoice_lines"."vat_cents" >= 0
      AND "club_invoice_lines"."total_cents" = "club_invoice_lines"."base_cents" + "club_invoice_lines"."vat_cents"),
	-- The split is the rate's, to the cent (lib/src/clubs/invoices.ts
	-- splitVat: base = round(total × 10000 / (10000 + rate))); no rate (a
	-- supplier without VAT registration) and a zero rate mean no VAT.
	CONSTRAINT "club_invoice_lines_vat_known" CHECK (("club_invoice_lines"."vat_rate_bp" IS NULL OR "club_invoice_lines"."vat_rate_bp" IN (0, 900, 2000))
      AND (coalesce("club_invoice_lines"."vat_rate_bp", 0) <> 0 OR "club_invoice_lines"."vat_cents" = 0)
      AND (coalesce("club_invoice_lines"."vat_rate_bp", 0) = 0
           OR "club_invoice_lines"."base_cents" = round("club_invoice_lines"."total_cents" * 10000.0 / (10000 + "club_invoice_lines"."vat_rate_bp"))))
);
--> statement-breakpoint
-- Its own key to clubs: the purge empties it in the first round (0049 rule).
ALTER TABLE "club_invoice_lines" ADD CONSTRAINT "club_invoice_lines_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_invoice_lines" ADD CONSTRAINT "club_invoice_lines_invoice_fk" FOREIGN KEY ("club_id","invoice_id") REFERENCES "public"."club_invoices"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_invoice_lines_club_idx" ON "club_invoice_lines" USING btree ("club_id");--> statement-breakpoint
-- What an invoice says is written WITH it — in the transaction that issued it
-- (now() is the transaction's start, which the invoice was stamped with) —
-- and never changed after.
CREATE FUNCTION club_invoice_lines_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  stamped timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT i.created_at INTO stamped FROM public.club_invoices i
     WHERE i.club_id = NEW.club_id AND i.id = NEW.invoice_id;
    IF NOT FOUND THEN
      RETURN NEW; -- left to the foreign key (23503)
    END IF;
    IF stamped <> now() THEN
      RAISE EXCEPTION 'club_invoice_lines: lines are written with their invoice'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_invoice_lines_with_invoice';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND OLD.club_id::text = current_setting('pops.purging_club', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'club_invoice_lines: what an invoice says never changes';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_invoice_lines_guard" BEFORE INSERT OR UPDATE OR DELETE ON "club_invoice_lines" FOR EACH ROW EXECUTE FUNCTION club_invoice_lines_guard();--> statement-breakpoint
CREATE TRIGGER "club_invoice_lines_no_truncate" BEFORE TRUNCATE ON "club_invoice_lines" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
-- At COMMIT: a document has at least one line, and its lines add up to its
-- totals. Deferred, so the invoice and its lines are written in either order
-- within the transaction; fired by a row of either table.
CREATE FUNCTION club_invoices_add_up() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target uuid;
  head public.club_invoices%ROWTYPE;
  lines_n bigint;
  lines_total bigint;
  lines_base bigint;
  lines_vat bigint;
BEGIN
  IF TG_TABLE_NAME = 'club_invoices' THEN
    target := NEW.id;
  ELSE
    target := NEW.invoice_id;
  END IF;
  SELECT * INTO head FROM public.club_invoices i
   WHERE i.club_id = NEW.club_id AND i.id = target;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT count(*), coalesce(sum(l.total_cents), 0), coalesce(sum(l.base_cents), 0),
         coalesce(sum(l.vat_cents), 0)
    INTO lines_n, lines_total, lines_base, lines_vat
    FROM public.club_invoice_lines l
   WHERE l.club_id = head.club_id AND l.invoice_id = head.id;
  IF lines_n = 0 OR lines_total <> head.total_cents OR lines_base <> head.base_cents
     OR lines_vat <> head.vat_cents THEN
    RAISE EXCEPTION 'club_invoices: a document''s lines add up to its totals'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_invoices_lines_add_up';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "club_invoices_add_up" AFTER INSERT ON "club_invoices" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION club_invoices_add_up();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "club_invoice_lines_add_up" AFTER INSERT ON "club_invoice_lines" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION club_invoices_add_up();--> statement-breakpoint
-- At COMMIT: every number drawn from a counter belongs to the document of its
-- kind that took it — a transaction that draws and commits without one is
-- refused, so no series has a gap.
CREATE FUNCTION club_number_sequences_used() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (NEW.kind = 'sale' AND NOT EXISTS (SELECT 1 FROM public.club_sales s
                                         WHERE s.club_id = NEW.club_id AND s.number = NEW.last_value))
     OR (NEW.kind = 'invoice' AND NOT EXISTS (SELECT 1 FROM public.club_invoices i
                                               WHERE i.club_id = NEW.club_id AND i.number = NEW.last_value)) THEN
    RAISE EXCEPTION 'club_number_sequences: a number is drawn only for its document'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_number_sequences_used';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "club_number_sequences_used" AFTER INSERT OR UPDATE ON "club_number_sequences" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION club_number_sequences_used();--> statement-breakpoint
-- ─── Vocabulary ───────────────────────────────────────────────────────────
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
	    'wallet_topped_up', 'invoice_issued', 'credit_note_issued')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_audit" VALIDATE CONSTRAINT "club_audit_action_known";--> statement-breakpoint
COMMENT ON TABLE "club_invoice_settings" IS 'What an invoice prints about a club (0050) beyond clubs.legal_name and eik: address, VAT number (none: invoices without VAT), IBAN, the default VAT rate.';--> statement-breakpoint
COMMENT ON VIEW "club_wallet_balances" IS 'The single definition of a client''s prepaid credit (0050): net payments on their wallet charges minus net wallet payments. club_payments_wallet keeps it at zero or above for every row the club writes; a provider-reported refund may take it below (what the client owes back).';--> statement-breakpoint
COMMENT ON TABLE "club_invoices" IS 'Invoices and credit notes (0050): one gapless, chronological series per club, snapshots of supplier and buyer, never changed or deleted (a credit note corrects). Kept for the Accounting Act''s period: an erasure clears member_id only.';--> statement-breakpoint
COMMENT ON TABLE "club_invoice_lines" IS 'The lines of an invoice or credit note (0050): gross as charged, split into tax base and VAT to the cent; written with their document and adding up to it.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
