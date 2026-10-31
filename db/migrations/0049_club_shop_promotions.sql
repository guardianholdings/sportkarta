-- 0049_club_shop_promotions: «Клубове» v2, wave B1 (plan 2026-10-25) — a
-- club's shop (products, stock, a till) and its promotions (codes, automatic
-- offers shown struck through, gift vouchers, loyalty tiers). vedro's fitness
-- bar with stock and best sellers; 1club's POS, products and promotions;
-- anolla's promo prices. Hand-written; do not regenerate.
--
-- WHAT THIS ADDS
--
--   club_products          what a club sells over the counter: a name, an
--                          optional SKU (a barcode scanner types it), a
--                          category from a closed list, a price, the VAT rate
--                          an invoice will carry (wave B2), whether stock is
--                          counted and a low-stock mark. Archived, never
--                          deleted, once sold or counted.
--   club_stock_movements   the stock LEDGER, append-only: received, sold,
--                          returned, adjusted, written off. A product's stock
--                          on hand is their sum (club_product_stock). A sale
--                          may take stock below zero: the till never refuses a
--                          sale over a count somebody forgot to update — the
--                          products screen shows it instead.
--   club_number_sequences  one gapless counter per club and kind (sales here,
--                          invoices in B2), taken by an upsert that holds the
--                          row until commit, so a rolled-back sale gives its
--                          number back. It only ever moves up by one.
--   club_sales, club_sale_lines
--                          one till sale: its number, the client (optional — a
--                          walk-in pays on the spot), the lines as SNAPSHOTS
--                          (name, unit price, quantity, discount, VAT rate),
--                          the totals, and the ONE `product` charge it raised
--                          (none when the total is zero). A sale is a fact:
--                          its lines never change; the only later acts are
--                          reversing it (once, «сторно») and the anonymisation
--                          an erasure cascades.
--   club_promotions        an offer: a CODE typed at the desk or online, or
--                          none — AUTOMATIC, applied without asking and shown
--                          struck through on the club page; percent off, an
--                          amount off or a fixed price; for plans, products or
--                          both, optionally only named ones; a validity window
--                          (civil Sofia dates, ends_on inclusive); a cap on
--                          uses overall and per client; new clients only; a
--                          loyalty threshold (visits in the last 90 days). A
--                          single-use amount code is a gift voucher.
--   club_promotion_redemptions
--                          each use, against the membership or the till sale it
--                          discounted, append-only. Uses are DERIVED: one whose
--                          sale was reversed, or whose membership was cancelled
--                          as a mistake, no longer counts. `subject` keeps what
--                          it was for once an erasure has cleared the target.
--   club_checkouts.promotion_id / discount_cents
--                          an online purchase carries the offer it was opened
--                          with, so its use is recorded when the money arrives.
--                          Fixed with the rest of what a checkout is for.
--
--   Vocabulary: audit actions product_saved, product_archived, stock_moved,
--   sale_recorded, sale_reversed, promotion_saved, promotion_archived.
--
-- TENANCY: every table carries club_id and every reference between them is a
-- composite (club_id, id) key, so a row can never point into another club.
--
-- DELETES: references inside a club are NO ACTION (0039), so a product, a
-- location, a charge, a sale or an offer that has history cannot be deleted —
-- the key itself refuses (23503). The purge's single `DELETE FROM clubs` still
-- works because Postgres runs referential actions in rounds: the first round
-- is every cascade from `clubs`, and EVERY table here has its own club_id →
-- clubs CASCADE, so all of them are emptied in that round; the NO ACTION
-- checks those deletes queue run in the next round and find no child left.
-- That holds only for a child with its OWN key to clubs: one reached solely
-- through another table is still there when the check runs, and refuses the
-- purge. club_sale_lines carries a club_id → clubs key for exactly that
-- reason. The member and the membership are SET NULL (an erasure keeps the
-- club's books, anonymised).
-- Staff ids (sold_by, reversed_by, recorded_by) are kept BY VALUE (0039 rule
-- 5): a deleted account leaves its name off the record, not the record.
--
-- Assumptions: nothing here moves money — a till sale raises an ordinary
-- charge, paid by an ordinary club_payments row (or left open on the
-- client's account), so the 0041 books, balances and reports see it like any
-- other. «Не е фискален бон»: POPS is not a fiscal device (Наредба Н-18); the
-- whole shop stays behind CLUB_SHOP_ENABLED until the operator's accountant
-- has confirmed that (plan, manual step 4).
--
-- Locking: SHARE ROW EXCLUSIVE on clubs, club_members, club_memberships,
-- club_locations and club_charges for the new foreign keys; ACCESS EXCLUSIVE
-- on club_checkouts (two columns, a CHECK and the guard replaced) and on
-- club_audit (the CHECK swap; VALIDATE scans it). Small tables, one
-- transaction: deploy at a quiet hour, never during a club purge; a red
-- deploy is simply re-run. A payment applied by the worker at that moment
-- may meet this file over club_checkouts; Postgres aborts one side after
-- ~1 s and pg-boss retries the job (no order of statements here removes
-- that: club_checkouts first would collide with the hold sweep instead). A
-- desk erasure at that moment (it writes club_audit, then deletes from
-- club_members — the reverse of this file) may be aborted the same way and is
-- simply re-submitted. club_staff is not touched, so unlike 0045–0048 it is
-- not locked first: account erasure writes club_audit and cascades only into
-- tables this file does not hold.
--
-- rollback (after reverting the application), in ONE explicit transaction, at
-- a quiet hour. Dropping these tables' keys takes ACCESS EXCLUSIVE on clubs,
-- club_members, club_memberships, club_locations and club_charges for the rest
-- of that transaction:
--   SET LOCAL lock_timeout = '3s';
--   FIRST re-create 0046's club_checkouts_guard() exactly as 0046 defines it
--   (0046_club_online_payments.sql, CREATE FUNCTION club_checkouts_guard): it
--   does not name the two columns, so it is valid before and after the drop,
--   whereas this file's guard fails every UPDATE once they are gone;
--   ALTER TABLE "club_checkouts" DROP CONSTRAINT "club_checkouts_promotion_fk",
--     DROP CONSTRAINT "club_checkouts_promotion_pair",
--     DROP CONSTRAINT "club_checkouts_promotion_membership",
--     DROP COLUMN "promotion_id", DROP COLUMN "discount_cents";
--                         -- DESTRUCTIVE: which offer each online purchase carried
--   DROP TABLE "club_promotion_redemptions";       -- DESTRUCTIVE: every use
--   DROP TABLE "club_promotions";
--   DROP VIEW "club_product_stock";
--   DROP TABLE "club_stock_movements";             -- DESTRUCTIVE: the stock ledger
--   DROP TABLE "club_sale_lines", "club_sales";    -- DESTRUCTIVE: every till sale
--   DROP TABLE "club_number_sequences";
--   DROP TABLE "club_products";
--   -- Functions last: the tables' triggers depend on them.
--   DROP FUNCTION club_sales_guard(), club_sale_lines_guard(), club_stock_movements_guard(),
--     club_number_sequences_guard(), club_promotion_redemptions_guard(), club_promotions_guard();
--   The widened club_audit_action_known STAYS (a superset is harmless; the
--   audit log is append-only). The sales' `product` charges remain as
--   ordinary money the reverted application still displays and settles.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- ─── Products and stock ───────────────────────────────────────────────────
CREATE TABLE "club_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sku" text,
	"category" text DEFAULT 'other' NOT NULL,
	"price_cents" integer NOT NULL,
	"vat_rate_bp" integer DEFAULT 2000 NOT NULL,
	"track_stock" boolean DEFAULT true NOT NULL,
	"low_stock_at" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_products_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_products_name_sane" CHECK (btrim("club_products"."name") <> '' AND char_length("club_products"."name") <= 80),
	CONSTRAINT "club_products_sku_shape" CHECK ("club_products"."sku" IS NULL OR "club_products"."sku" ~ '^[A-Za-z0-9._-]{1,40}$'),
	CONSTRAINT "club_products_category_known" CHECK ("club_products"."category" IN ('drink', 'food', 'supplement', 'apparel', 'equipment', 'other')),
	CONSTRAINT "club_products_price_sane" CHECK ("club_products"."price_cents" BETWEEN 0 AND 10000000),
	-- The Bulgarian rates a club's counter sales carry: 20 %, 9 %, 0 %.
	CONSTRAINT "club_products_vat_known" CHECK ("club_products"."vat_rate_bp" IN (0, 900, 2000)),
	CONSTRAINT "club_products_low_stock_sane" CHECK ("club_products"."low_stock_at" IS NULL OR "club_products"."low_stock_at" BETWEEN 0 AND 100000)
);
--> statement-breakpoint
ALTER TABLE "club_products" ADD CONSTRAINT "club_products_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_products_sku_unique" ON "club_products" USING btree ("club_id","sku") WHERE "club_products"."sku" IS NOT NULL AND "club_products"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "club_products_club_idx" ON "club_products" USING btree ("club_id","sort_order") WHERE "club_products"."archived_at" IS NULL;--> statement-breakpoint
CREATE TRIGGER "club_products_set_updated_at" BEFORE UPDATE ON "club_products" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- ─── Gapless numbers ──────────────────────────────────────────────────────
CREATE TABLE "club_number_sequences" (
	"club_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"last_value" bigint NOT NULL,
	CONSTRAINT "club_number_sequences_pkey" PRIMARY KEY("club_id", "kind"),
	CONSTRAINT "club_number_sequences_kind_known" CHECK ("club_number_sequences"."kind" IN ('sale')),
	CONSTRAINT "club_number_sequences_value_sane" CHECK ("club_number_sequences"."last_value" BETWEEN 1 AND 9999999999)
);
--> statement-breakpoint
ALTER TABLE "club_number_sequences" ADD CONSTRAINT "club_number_sequences_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Up by exactly one, never back: a counter that could be rewound would hand
-- out a number twice (the sales' UNIQUE would then refuse the sale, but an
-- invoice number reused is a legal problem, not a constraint error).
CREATE FUNCTION club_number_sequences_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.club_id::text = current_setting('pops.purging_club', true) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'club_number_sequences: a counter is never removed';
  END IF;
  IF NEW.club_id IS DISTINCT FROM OLD.club_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.last_value IS DISTINCT FROM OLD.last_value + 1 THEN
    RAISE EXCEPTION 'club_number_sequences: a counter only moves up by one';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_number_sequences_guard" BEFORE UPDATE OR DELETE ON "club_number_sequences" FOR EACH ROW EXECUTE FUNCTION club_number_sequences_guard();--> statement-breakpoint
CREATE TRIGGER "club_number_sequences_no_truncate" BEFORE TRUNCATE ON "club_number_sequences" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
-- ─── Till sales ───────────────────────────────────────────────────────────
CREATE TABLE "club_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"number" bigint NOT NULL,
	"member_id" uuid,
	"location_id" uuid,
	"charge_id" uuid,
	"subtotal_cents" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"sold_by" text NOT NULL,
	"sold_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reversed_at" timestamp with time zone,
	"reversed_by" text,
	CONSTRAINT "club_sales_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_sales_number_unique" UNIQUE("club_id", "number"),
	CONSTRAINT "club_sales_charge_unique" UNIQUE("charge_id"),
	CONSTRAINT "club_sales_number_sane" CHECK ("club_sales"."number" BETWEEN 1 AND 9999999999),
	CONSTRAINT "club_sales_totals_sane" CHECK ("club_sales"."subtotal_cents" BETWEEN 0 AND 10000000
	      AND "club_sales"."discount_cents" BETWEEN 0 AND "club_sales"."subtotal_cents"
	      AND "club_sales"."total_cents" = "club_sales"."subtotal_cents" - "club_sales"."discount_cents"),
	-- A charge is voided, never deleted, so charge_id is never cleared.
	CONSTRAINT "club_sales_charge_iff_total" CHECK (("club_sales"."total_cents" > 0) = ("club_sales"."charge_id" IS NOT NULL)),
	CONSTRAINT "club_sales_reversal_pair" CHECK (("club_sales"."reversed_at" IS NULL) = ("club_sales"."reversed_by" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "club_sales" ADD CONSTRAINT "club_sales_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Erasing the client keeps the sale (the club's books), anonymised.
ALTER TABLE "club_sales" ADD CONSTRAINT "club_sales_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE set null ("member_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_sales" ADD CONSTRAINT "club_sales_location_fk" FOREIGN KEY ("club_id","location_id") REFERENCES "public"."club_locations"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_sales" ADD CONSTRAINT "club_sales_charge_fk" FOREIGN KEY ("club_id","charge_id") REFERENCES "public"."club_charges"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_sales_club_idx" ON "club_sales" USING btree ("club_id","sold_at" DESC);--> statement-breakpoint
CREATE INDEX "club_sales_location_idx" ON "club_sales" USING btree ("club_id","location_id") WHERE "club_sales"."location_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_sales_member_idx" ON "club_sales" USING btree ("club_id","member_id") WHERE "club_sales"."member_id" IS NOT NULL;--> statement-breakpoint
-- A sale is a fact. Reversing it is the one later act (once, with who did
-- it); an erasure may clear the client. DELETE only during a purge. A new
-- sale takes the number its own transaction just drew from the counter (the
-- row it holds until commit), so the gapless sequence is the database's
-- promise, not the application's.
CREATE FUNCTION club_sales_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  probe public.club_sales%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.number IS DISTINCT FROM (SELECT q.last_value FROM public.club_number_sequences q
                                     WHERE q.club_id = NEW.club_id AND q.kind = 'sale') THEN
      RAISE EXCEPTION 'club_sales: a sale takes the number just drawn from its counter'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_sales_number_drawn';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.club_id::text = current_setting('pops.purging_club', true) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'club_sales: a sale is reversed, never deleted';
  END IF;
  probe := NEW;
  probe.member_id := OLD.member_id;
  probe.reversed_at := OLD.reversed_at;
  probe.reversed_by := OLD.reversed_by;
  IF probe IS DISTINCT FROM OLD
     OR (NEW.member_id IS DISTINCT FROM OLD.member_id AND NEW.member_id IS NOT NULL)
     OR (OLD.reversed_at IS NOT NULL
         AND (NEW.reversed_at IS DISTINCT FROM OLD.reversed_at
              OR NEW.reversed_by IS DISTINCT FROM OLD.reversed_by)) THEN
    RAISE EXCEPTION 'club_sales: a sale is a fact; it may only be reversed, once'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_sales_fact';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_sales_guard" BEFORE INSERT OR UPDATE OR DELETE ON "club_sales" FOR EACH ROW EXECUTE FUNCTION club_sales_guard();--> statement-breakpoint
CREATE TRIGGER "club_sales_no_truncate" BEFORE TRUNCATE ON "club_sales" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
CREATE TABLE "club_sale_lines" (
	"club_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"line_no" smallint NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"quantity" integer NOT NULL,
	"discount_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"vat_rate_bp" integer NOT NULL,
	CONSTRAINT "club_sale_lines_pkey" PRIMARY KEY("sale_id", "line_no"),
	CONSTRAINT "club_sale_lines_line_sane" CHECK ("club_sale_lines"."line_no" BETWEEN 1 AND 200),
	CONSTRAINT "club_sale_lines_name_sane" CHECK (btrim("club_sale_lines"."name") <> '' AND char_length("club_sale_lines"."name") <= 80),
	CONSTRAINT "club_sale_lines_quantity_sane" CHECK ("club_sale_lines"."quantity" BETWEEN 1 AND 1000),
	-- In bigint: 10 000 000 cents × 1000 overflows an integer.
	CONSTRAINT "club_sale_lines_money_sane" CHECK ("club_sale_lines"."unit_price_cents" BETWEEN 0 AND 10000000
	      AND "club_sale_lines"."unit_price_cents"::bigint * "club_sale_lines"."quantity" <= 10000000
	      AND "club_sale_lines"."discount_cents"::bigint BETWEEN 0 AND "club_sale_lines"."unit_price_cents"::bigint * "club_sale_lines"."quantity"
	      AND "club_sale_lines"."total_cents"::bigint = "club_sale_lines"."unit_price_cents"::bigint * "club_sale_lines"."quantity" - "club_sale_lines"."discount_cents"),
	CONSTRAINT "club_sale_lines_vat_known" CHECK ("club_sale_lines"."vat_rate_bp" IN (0, 900, 2000))
);
--> statement-breakpoint
-- Its own key to clubs: the purge must empty this table in its first round
-- (see DELETES above), or the product key below would refuse the purge.
ALTER TABLE "club_sale_lines" ADD CONSTRAINT "club_sale_lines_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_sale_lines" ADD CONSTRAINT "club_sale_lines_sale_fk" FOREIGN KEY ("club_id","sale_id") REFERENCES "public"."club_sales"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_sale_lines" ADD CONSTRAINT "club_sale_lines_product_fk" FOREIGN KEY ("club_id","product_id") REFERENCES "public"."club_products"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Best sellers: lines by product.
CREATE INDEX "club_sale_lines_product_idx" ON "club_sale_lines" USING btree ("club_id","product_id");--> statement-breakpoint
CREATE FUNCTION club_sale_lines_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.club_id::text = current_setting('pops.purging_club', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'club_sale_lines: what was sold never changes (reverse the sale instead)';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_sale_lines_guard" BEFORE UPDATE OR DELETE ON "club_sale_lines" FOR EACH ROW EXECUTE FUNCTION club_sale_lines_guard();--> statement-breakpoint
CREATE TRIGGER "club_sale_lines_no_truncate" BEFORE TRUNCATE ON "club_sale_lines" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
CREATE TABLE "club_stock_movements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "club_stock_movements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"club_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"sale_id" uuid,
	"unit_cost_cents" integer,
	"recorded_by" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_stock_movements_kind_known" CHECK ("club_stock_movements"."kind" IN ('receive', 'sale', 'return', 'adjust', 'waste')),
	CONSTRAINT "club_stock_movements_quantity_sane" CHECK ("club_stock_movements"."quantity" <> 0 AND "club_stock_movements"."quantity" BETWEEN -100000 AND 100000),
	-- The sign says the direction: in for a delivery or a return, out for a
	-- sale or a write-off, either way for a count correction.
	CONSTRAINT "club_stock_movements_sign_matches_kind" CHECK (("club_stock_movements"."kind" IN ('receive', 'return') AND "club_stock_movements"."quantity" > 0)
	      OR ("club_stock_movements"."kind" IN ('sale', 'waste') AND "club_stock_movements"."quantity" < 0)
	      OR "club_stock_movements"."kind" = 'adjust'),
	-- A sale is never deleted (club_sales_guard), so sale_id is never cleared.
	CONSTRAINT "club_stock_movements_sale_pair" CHECK (("club_stock_movements"."kind" IN ('sale', 'return')) = ("club_stock_movements"."sale_id" IS NOT NULL)),
	CONSTRAINT "club_stock_movements_cost_sane" CHECK ("club_stock_movements"."unit_cost_cents" IS NULL
	      OR ("club_stock_movements"."kind" = 'receive' AND "club_stock_movements"."unit_cost_cents" BETWEEN 0 AND 10000000))
);
--> statement-breakpoint
ALTER TABLE "club_stock_movements" ADD CONSTRAINT "club_stock_movements_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_stock_movements" ADD CONSTRAINT "club_stock_movements_product_fk" FOREIGN KEY ("club_id","product_id") REFERENCES "public"."club_products"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_stock_movements" ADD CONSTRAINT "club_stock_movements_sale_fk" FOREIGN KEY ("club_id","sale_id") REFERENCES "public"."club_sales"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_stock_movements_product_idx" ON "club_stock_movements" USING btree ("club_id","product_id");--> statement-breakpoint
CREATE INDEX "club_stock_movements_sale_idx" ON "club_stock_movements" USING btree ("club_id","sale_id") WHERE "club_stock_movements"."sale_id" IS NOT NULL;--> statement-breakpoint
-- The stock ledger: a count is corrected by a new movement, never by an edit.
CREATE FUNCTION club_stock_movements_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.club_id::text = current_setting('pops.purging_club', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'club_stock_movements is append-only (record an adjustment instead)';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_stock_movements_guard" BEFORE UPDATE OR DELETE ON "club_stock_movements" FOR EACH ROW EXECUTE FUNCTION club_stock_movements_guard();--> statement-breakpoint
CREATE TRIGGER "club_stock_movements_no_truncate" BEFORE TRUNCATE ON "club_stock_movements" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
-- The single definition of stock on hand. LATERAL, so one club's products
-- read only their own movements through club_stock_movements_product_idx.
CREATE VIEW "club_product_stock" WITH (security_invoker = true) AS
SELECT
  p.id AS product_id,
  p.club_id,
  coalesce(s.on_hand, 0) AS on_hand
FROM public.club_products p
LEFT JOIN LATERAL (
  SELECT sum(mv.quantity) AS on_hand
    FROM public.club_stock_movements mv
   WHERE mv.club_id = p.club_id AND mv.product_id = p.id
) s ON true;--> statement-breakpoint
-- ─── Promotions ───────────────────────────────────────────────────────────
CREATE TABLE "club_promotions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"kind" text NOT NULL,
	"value" integer NOT NULL,
	"target" text DEFAULT 'all' NOT NULL,
	"target_ids" uuid[],
	"starts_on" date NOT NULL,
	"ends_on" date,
	"max_uses" integer,
	"per_member_max" integer,
	"new_members_only" boolean DEFAULT false NOT NULL,
	"min_visits_90d" integer,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_promotions_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_promotions_name_sane" CHECK (btrim("club_promotions"."name") <> '' AND char_length("club_promotions"."name") <= 80),
	-- Stored upper-case; typed in any case.
	CONSTRAINT "club_promotions_code_shape" CHECK ("club_promotions"."code" IS NULL OR "club_promotions"."code" ~ '^[A-Z0-9-]{3,24}$'),
	CONSTRAINT "club_promotions_kind_known" CHECK ("club_promotions"."kind" IN ('percent', 'amount', 'fixed_price')),
	-- percent in basis points (1 = 0.01 %), amount and fixed price in cents.
	CONSTRAINT "club_promotions_value_sane" CHECK (("club_promotions"."kind" = 'percent' AND "club_promotions"."value" BETWEEN 1 AND 10000)
	      OR ("club_promotions"."kind" = 'amount' AND "club_promotions"."value" BETWEEN 1 AND 10000000)
	      OR ("club_promotions"."kind" = 'fixed_price' AND "club_promotions"."value" BETWEEN 0 AND 10000000)),
	CONSTRAINT "club_promotions_target_known" CHECK ("club_promotions"."target" IN ('all', 'plans', 'products')),
	-- Named plans or products: ids of THIS club's rows are matched at use, so a
	-- foreign id simply never matches (no foreign key can reach into an array).
	CONSTRAINT "club_promotions_targets_sane" CHECK ("club_promotions"."target_ids" IS NULL
	      OR (array_ndims("club_promotions"."target_ids") = 1 AND cardinality("club_promotions"."target_ids") BETWEEN 1 AND 200
          AND array_position("club_promotions"."target_ids", NULL) IS NULL)),
	CONSTRAINT "club_promotions_window_sane" CHECK (isfinite("club_promotions"."starts_on")
	      AND ("club_promotions"."ends_on" IS NULL OR (isfinite("club_promotions"."ends_on") AND "club_promotions"."ends_on" >= "club_promotions"."starts_on"))),
	CONSTRAINT "club_promotions_caps_sane" CHECK (("club_promotions"."max_uses" IS NULL OR "club_promotions"."max_uses" BETWEEN 1 AND 1000000)
	      AND ("club_promotions"."per_member_max" IS NULL OR "club_promotions"."per_member_max" BETWEEN 1 AND 1000)),
	CONSTRAINT "club_promotions_loyalty_sane" CHECK ("club_promotions"."min_visits_90d" IS NULL OR "club_promotions"."min_visits_90d" BETWEEN 1 AND 365)
);
--> statement-breakpoint
ALTER TABLE "club_promotions" ADD CONSTRAINT "club_promotions_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A live code means one offer at a club; an archived one may be reused.
CREATE UNIQUE INDEX "club_promotions_code_unique" ON "club_promotions" USING btree ("club_id","code") WHERE "club_promotions"."code" IS NOT NULL AND "club_promotions"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "club_promotions_club_idx" ON "club_promotions" USING btree ("club_id","starts_on") WHERE "club_promotions"."archived_at" IS NULL;--> statement-breakpoint
CREATE TRIGGER "club_promotions_set_updated_at" BEFORE UPDATE ON "club_promotions" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- An offer is archived, never deleted — even an unused one: the office has
-- one way to end an offer.
CREATE FUNCTION club_promotions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.club_id::text = current_setting('pops.purging_club', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'club_promotions: an offer is archived, never deleted';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_promotions_guard" BEFORE DELETE ON "club_promotions" FOR EACH ROW EXECUTE FUNCTION club_promotions_guard();--> statement-breakpoint
CREATE TRIGGER "club_promotions_no_truncate" BEFORE TRUNCATE ON "club_promotions" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
CREATE TABLE "club_promotion_redemptions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "club_promotion_redemptions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"club_id" uuid NOT NULL,
	"promotion_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"member_id" uuid,
	"membership_id" uuid,
	"sale_id" uuid,
	"discount_cents" integer NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_promotion_redemptions_subject_known" CHECK ("club_promotion_redemptions"."subject" IN ('membership', 'sale')),
	-- sale_id is never cleared (sales are reversed, not deleted); a sale use
	-- names its sale and nothing else. membership_id IS cleared when an
	-- erasure deletes the membership, so no CHECK names it (0039 rule 5) —
	-- `subject` still says what the use was for.
	CONSTRAINT "club_promotion_redemptions_sale_pair" CHECK (("club_promotion_redemptions"."subject" = 'sale') = ("club_promotion_redemptions"."sale_id" IS NOT NULL)),
	-- A sale use never names a membership (a SET NULL can only make this true).
	CONSTRAINT "club_promotion_redemptions_membership_only" CHECK ("club_promotion_redemptions"."subject" = 'membership' OR "club_promotion_redemptions"."membership_id" IS NULL),
	CONSTRAINT "club_promotion_redemptions_discount_sane" CHECK ("club_promotion_redemptions"."discount_cents" BETWEEN 1 AND 10000000)
);
--> statement-breakpoint
ALTER TABLE "club_promotion_redemptions" ADD CONSTRAINT "club_promotion_redemptions_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_promotion_redemptions" ADD CONSTRAINT "club_promotion_redemptions_promotion_fk" FOREIGN KEY ("club_id","promotion_id") REFERENCES "public"."club_promotions"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_promotion_redemptions" ADD CONSTRAINT "club_promotion_redemptions_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE set null ("member_id") ON UPDATE no action;--> statement-breakpoint
-- Two keys on the membership. The plain one clears membership_id whenever the
-- membership goes (an erasure deletes it). The composite one (0046's
-- club_checkouts_membership_fk pattern on club_memberships_member_unique)
-- makes the membership the SAME client's, so a use always counts against the
-- client it discounted; it alone could leave a dangling id, because an
-- erasure may null member_id first, after which it no longer matches.
ALTER TABLE "club_promotion_redemptions" ADD CONSTRAINT "club_promotion_redemptions_membership_fk" FOREIGN KEY ("club_id","membership_id") REFERENCES "public"."club_memberships"("club_id","id") ON DELETE set null ("membership_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_promotion_redemptions" ADD CONSTRAINT "club_promotion_redemptions_membership_member_fk" FOREIGN KEY ("club_id","member_id","membership_id") REFERENCES "public"."club_memberships"("club_id","member_id","id") ON DELETE set null ("membership_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_promotion_redemptions" ADD CONSTRAINT "club_promotion_redemptions_sale_fk" FOREIGN KEY ("club_id","sale_id") REFERENCES "public"."club_sales"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- One offer per purchase: a membership or a sale is discounted once.
CREATE UNIQUE INDEX "club_promotion_redemptions_membership_unique" ON "club_promotion_redemptions" USING btree ("membership_id") WHERE "club_promotion_redemptions"."membership_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "club_promotion_redemptions_sale_unique" ON "club_promotion_redemptions" USING btree ("sale_id") WHERE "club_promotion_redemptions"."sale_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_promotion_redemptions_promotion_idx" ON "club_promotion_redemptions" USING btree ("club_id","promotion_id");--> statement-breakpoint
CREATE INDEX "club_promotion_redemptions_member_idx" ON "club_promotion_redemptions" USING btree ("club_id","member_id") WHERE "club_promotion_redemptions"."member_id" IS NOT NULL;--> statement-breakpoint
-- Append-only. The only updates are the SET NULLs an erasure cascades. A
-- membership use is written WITH its membership — checked at insert, since a
-- CHECK would refuse the erasure that later clears it.
CREATE FUNCTION club_promotion_redemptions_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  probe public.club_promotion_redemptions%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.subject = 'membership' AND NEW.membership_id IS NULL THEN
      RAISE EXCEPTION 'club_promotion_redemptions: a membership use names its membership'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_promotion_redemptions_membership_named';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.club_id::text = current_setting('pops.purging_club', true) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'club_promotion_redemptions is append-only';
  END IF;
  probe := NEW;
  probe.member_id := OLD.member_id;
  probe.membership_id := OLD.membership_id;
  IF probe IS DISTINCT FROM OLD
     OR (NEW.member_id IS DISTINCT FROM OLD.member_id AND NEW.member_id IS NOT NULL)
     OR (NEW.membership_id IS DISTINCT FROM OLD.membership_id AND NEW.membership_id IS NOT NULL) THEN
    RAISE EXCEPTION 'club_promotion_redemptions is append-only';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_promotion_redemptions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "club_promotion_redemptions" FOR EACH ROW EXECUTE FUNCTION club_promotion_redemptions_guard();--> statement-breakpoint
CREATE TRIGGER "club_promotion_redemptions_no_truncate" BEFORE TRUNCATE ON "club_promotion_redemptions" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
-- ─── An online purchase carries its offer ─────────────────────────────────
ALTER TABLE "club_checkouts" ADD COLUMN "promotion_id" uuid;--> statement-breakpoint
ALTER TABLE "club_checkouts" ADD COLUMN "discount_cents" integer;--> statement-breakpoint
-- An offer a checkout carries cannot be deleted (NO ACTION, and
-- club_promotions_guard), so promotion_id is never cleared.
ALTER TABLE "club_checkouts" ADD CONSTRAINT "club_checkouts_promotion_pair" CHECK (("club_checkouts"."promotion_id" IS NULL) = ("club_checkouts"."discount_cents" IS NULL)
      AND ("club_checkouts"."discount_cents" IS NULL OR "club_checkouts"."discount_cents" BETWEEN 1 AND 10000000));--> statement-breakpoint
ALTER TABLE "club_checkouts" ADD CONSTRAINT "club_checkouts_promotion_membership" CHECK ("club_checkouts"."promotion_id" IS NULL OR "club_checkouts"."purpose" = 'membership');--> statement-breakpoint
ALTER TABLE "club_checkouts" ADD CONSTRAINT "club_checkouts_promotion_fk" FOREIGN KEY ("club_id","promotion_id") REFERENCES "public"."club_promotions"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_checkouts_promotion_idx" ON "club_checkouts" USING btree ("club_id","promotion_id") WHERE "club_checkouts"."promotion_id" IS NOT NULL;--> statement-breakpoint
-- 0046's guard, with the offer joining what a checkout is for.
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
     OR NEW.discount_cents IS DISTINCT FROM OLD.discount_cents THEN
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
	    'promotion_saved', 'promotion_archived')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_audit" VALIDATE CONSTRAINT "club_audit_action_known";--> statement-breakpoint
COMMENT ON TABLE "club_products" IS 'What a club sells over the counter (0049). Archived, never deleted, once sold or counted. vat_rate_bp is what an invoice line carries (wave B2).';--> statement-breakpoint
COMMENT ON TABLE "club_stock_movements" IS 'The stock ledger (0049), append-only: received, sold, returned, adjusted, written off. Stock on hand is derived in club_product_stock and may go below zero.';--> statement-breakpoint
COMMENT ON TABLE "club_number_sequences" IS 'Gapless per-club counters (0049): sales, later invoices. Taken by an upsert that holds the row until commit; only ever up by one.';--> statement-breakpoint
COMMENT ON TABLE "club_sales" IS 'One till sale (0049): number, optional client (SET NULL on erasure), totals, and the one product charge it raised. A fact: only reversed (once). Not a fiscal receipt.';--> statement-breakpoint
COMMENT ON TABLE "club_sale_lines" IS 'The lines of a till sale as snapshots (0049): name, unit price, quantity, discount, VAT rate. Never changed.';--> statement-breakpoint
COMMENT ON TABLE "club_promotions" IS 'A club offer (0049): a code, or automatic (no code); percent, amount off or fixed price; for plans, products or both; validity, caps, new clients only, a loyalty threshold. Archived, never deleted.';--> statement-breakpoint
COMMENT ON TABLE "club_promotion_redemptions" IS 'Each use of an offer (0049), against the membership or till sale it discounted. Append-only; uses are derived (a reversed sale or a mistaken membership no longer counts).';--> statement-breakpoint
COMMENT ON VIEW "club_product_stock" IS 'The single definition of a product''s stock on hand: the sum of its movements (bigint).';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
