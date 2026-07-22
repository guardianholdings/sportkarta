-- 0006_contributions_points: crowd condition layer + append-only points ledger
-- (docs/ROADMAP.md §5, Stage 3.2). Two new tables, two new columns on
-- facilities, two more counters on the GDPR tombstone. No existing row is
-- rewritten and no data is destroyed.
--
-- facilities.condition denormalises the latest crowd report so the map and the
-- facility page never scan history; facility_condition_reports keeps that
-- history. The application writes both in ONE transaction along with the
-- facility_edits row — nothing here enforces that, so a future caller that
-- splits them would leave the map showing a condition with no report behind it.
--
-- points_ledger is append-only, with one deliberate exception. UPDATE and
-- TRUNCATE are always refused. DELETE is refused too, EXCEPT when the owning
-- users row is already gone — precisely the ON DELETE CASCADE from GDPR
-- erasure. The check runs as `public.users` under a pinned search_path: without
-- that, a session could shadow `users` with a temp table and quietly delete
-- awards, and a session whose search_path lacked `public` would fail erasure
-- outright. (A caller with arbitrary SQL could still delete-and-reinsert the
-- same account id in one transaction to reset a score; better-auth ids are
-- random, and anyone able to do that can also DROP the trigger.)
--
-- facility_id is RESTRICT, matching facility_edits: an award must never dangle,
-- and an append-only table could never be repaired if it did. CASCADE would be
-- wrong — it fires the BEFORE DELETE trigger while the account still exists, so
-- deleting any facility with points would abort.
--
-- Idempotency is the UNIQUE index on idempotency_key, not application logic:
-- awards are INSERT ... ON CONFLICT DO NOTHING, so retries cannot double-award
-- even under concurrency (db/src/points-ledger.test.ts proves it).
--
-- Locking: ADD COLUMN without a default is catalog-only and the CHECK scans
-- ~6,600 all-NULL rows in milliseconds, but the ACCESS EXCLUSIVE lock on
-- facilities is held until COMMIT — so a long-running map or import query would
-- queue every reader behind it. lock_timeout makes that fail fast instead of
-- taking the public map down.
--
-- rollback: DESTRUCTIVE once the app has written. DROP TABLE "points_ledger"
-- destroys every award — the ledger cannot be reconstructed from anything else,
-- because facility_edits records the field change, not the award — and
-- DROP TABLE "facility_condition_reports" plus DROP COLUMN "condition" destroy
-- the entire crowd condition layer. Recovery is a restore from the nightly
-- backup, losing everything written since. Note DELETE cannot be used to undo
-- rows here: the triggers refuse it, so only DROP TABLE will do it, which is
-- exactly why this is destructive rather than reversible.
--   ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";
--   ALTER TABLE "facilities" DROP CONSTRAINT "facilities_condition_pair";
--   DROP TRIGGER "points_ledger_no_truncate" ON "points_ledger";
--   DROP TRIGGER "points_ledger_no_delete" ON "points_ledger";
--   DROP TRIGGER "points_ledger_no_update" ON "points_ledger";
--   DROP FUNCTION forbid_points_ledger_mutation();
--   DROP TABLE "points_ledger"; DROP TABLE "facility_condition_reports";
--   ALTER TABLE "account_deletions" DROP COLUMN "points_erased";
--   ALTER TABLE "account_deletions" DROP COLUMN "condition_reports_anonymized";
--   ALTER TABLE "facilities" DROP COLUMN "condition_reported_at";
--   ALTER TABLE "facilities" DROP COLUMN "condition";
--   DROP TYPE "points_event"; DROP TYPE "facility_condition";
--   (then restore the dropped tables from backup — the data is not recoverable
--    by rollback alone)
SET lock_timeout = '3s';--> statement-breakpoint
CREATE TYPE "public"."facility_condition" AS ENUM('excellent', 'good', 'poor', 'unusable');--> statement-breakpoint
CREATE TYPE "public"."points_event" AS ENUM('facility_added', 'facility_verified', 'condition_reported');--> statement-breakpoint
CREATE TABLE "facility_condition_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"reporter_id" text,
	"state" "facility_condition" NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"photo_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_condition_reports_tags_sane" CHECK ("facility_condition_reports"."tags" <@ ARRAY['broken_equipment','damaged_surface','flooding','litter','missing_net','no_lighting','overgrown','vandalism']::text[]
          AND coalesce(array_length("facility_condition_reports"."tags", 1), 0) <= 6)
);
--> statement-breakpoint
CREATE TABLE "points_ledger" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "points_ledger_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"event" "points_event" NOT NULL,
	"points" integer NOT NULL,
	"facility_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_ledger_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "points_ledger_points_sane" CHECK ("points_ledger"."points" BETWEEN 1 AND 100),
	CONSTRAINT "points_ledger_key_not_blank" CHECK (btrim("points_ledger"."idempotency_key") <> '')
);
--> statement-breakpoint
ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "condition" "facility_condition";--> statement-breakpoint
ALTER TABLE "facilities" ADD COLUMN "condition_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "condition_reports_anonymized" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "points_erased" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "facility_condition_reports" ADD CONSTRAINT "facility_condition_reports_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_condition_reports" ADD CONSTRAINT "facility_condition_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_condition_reports" ADD CONSTRAINT "facility_condition_reports_photo_id_facility_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."facility_photos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facility_condition_reports_facility_created_idx" ON "facility_condition_reports" USING btree ("facility_id","created_at");--> statement-breakpoint
CREATE INDEX "facility_condition_reports_reporter_idx" ON "facility_condition_reports" USING btree ("reporter_id") WHERE "facility_condition_reports"."reporter_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "facility_condition_reports_photo_id_idx" ON "facility_condition_reports" USING btree ("photo_id") WHERE "facility_condition_reports"."photo_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "points_ledger_user_created_idx" ON "points_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "points_ledger_facility_idx" ON "points_ledger" USING btree ("facility_id");--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_condition_pair" CHECK (("facilities"."condition" IS NULL) = ("facilities"."condition_reported_at" IS NULL));--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
          AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0);--> statement-breakpoint
-- Append-only enforcement. A grant cannot express "insert only", so triggers
-- do it. search_path is pinned and `users` is schema-qualified: the DELETE
-- exception below is the entire GDPR escape hatch, and resolving that name
-- through the caller's search_path would let a temp table shadow it (silent
-- delete bypass) or a search_path without public break erasure entirely.
CREATE FUNCTION forbid_points_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- The FK cascade runs after the parent row is gone, so a missing owner is
    -- proof this delete belongs to an account erasure.
    IF NOT EXISTS (SELECT 1 FROM public.users WHERE id = OLD.user_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'points_ledger is append-only (rows leave only with the account)';
  END IF;
  RAISE EXCEPTION 'points_ledger is append-only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "points_ledger_no_update"
BEFORE UPDATE ON "points_ledger"
FOR EACH ROW EXECUTE FUNCTION forbid_points_ledger_mutation();--> statement-breakpoint
CREATE TRIGGER "points_ledger_no_delete"
BEFORE DELETE ON "points_ledger"
FOR EACH ROW EXECUTE FUNCTION forbid_points_ledger_mutation();--> statement-breakpoint
CREATE TRIGGER "points_ledger_no_truncate"
BEFORE TRUNCATE ON "points_ledger"
FOR EACH STATEMENT EXECUTE FUNCTION forbid_points_ledger_mutation();--> statement-breakpoint
COMMENT ON TABLE "points_ledger" IS 'Append-only earning ledger; no spending mechanics, so a balance is sum(points). Rows are immutable and leave only with the owning account (GDPR). idempotency_key is UNIQUE — awards are INSERT ... ON CONFLICT DO NOTHING, so retries cannot double-award.';--> statement-breakpoint
COMMENT ON COLUMN "facilities"."condition" IS 'Latest crowd-reported condition, denormalised from facility_condition_reports. NULL means nobody has reported yet — not "excellent".';--> statement-breakpoint
COMMENT ON TABLE "facility_condition_reports" IS 'History behind facilities.condition. reporter_id is cleared on account erasure; the report itself stays, as public-interest data about a place.';