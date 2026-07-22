-- 0007_ambassadors_moderation: municipality-scoped ambassadors, an append-only
-- decision log, and assistive pre-screen flags (docs/ROADMAP.md §5, Stage 3.3).
--
-- ROLE CHANGE: 'moderator' is retired. The UPDATE below is expected to affect
-- ZERO rows in production: no code path has ever written that value —
-- syncAdminRole writes only admin/user (apps/web/lib/roles.ts), and
-- grant/revokeAmbassador write only ambassador/user (apps/web/lib/ambassadors.ts).
-- It exists for databases where the value was set by hand. RECORD THE RESULT
-- BEFORE APPLYING (`SELECT id, email FROM users WHERE role = 'moderator'`):
-- a converted account becomes an ambassador with no municipalities, which can
-- decide nothing until an admin grants scope, and nothing afterwards records
-- who was affected. The CHECK then forbids the value; the enum member survives
-- because dropping one would recreate the type and rewrite every dependent
-- column.
--
-- ambassador_municipalities IS the authorization boundary. Every moderation
-- statement joins against it (apps/web/lib/moderation.ts), so an out-of-scope
-- decision updates zero rows even if an application check were bypassed — that
-- is what db/src/moderation-authz.test.ts proves, at the query layer.
--
-- moderation_decisions is append-only like facility_edits, and for the same
-- reason: the record of who decided what is the accountability trail. actor_id
-- carries NO foreign key so it survives the moderator erasing their own
-- account, after which it resolves to the "former user" label.
-- municipality_id is the scope AT DECISION TIME and is RESTRICT, not SET NULL:
-- a SET NULL action is performed as an UPDATE, which the append-only trigger
-- refuses, so deleting a municipality would fail with a confusing error about a
-- table nobody touched — and, worse, SET NULL is itself the rewrite of history
-- this column exists to prevent. RESTRICT fails honestly instead.
--
-- moderation_flags is deliberately inert: no status, no link to a decision, and
-- freely deletable. A flag says "look at this, here is why"; a human decides.
--
-- Locking: everything is new except the two ALTER TABLE ... ADD CONSTRAINT
-- statements, which scan tiny tables. They are placed LAST so the ACCESS
-- EXCLUSIVE lock on users — a table every signed-in request reads — is held for
-- as short a window as possible. lock_timeout guards against queueing behind a
-- long reader.
--
-- rollback (compensating SQL, reverse order; DESTRUCTIVE where noted):
--   ALTER TABLE "users" DROP CONSTRAINT "users_role_not_moderator";
--   ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";
--   COMMENT ON TABLE "ambassador_municipalities" IS NULL;
--   COMMENT ON TABLE "moderation_decisions" IS NULL;
--   COMMENT ON TABLE "moderation_flags" IS NULL;
--   COMMENT ON COLUMN "users"."role" IS NULL;
--   DROP TRIGGER "moderation_decisions_no_truncate" ON "moderation_decisions";
--   DROP TRIGGER "moderation_decisions_no_delete" ON "moderation_decisions";
--   DROP TRIGGER "moderation_decisions_no_update" ON "moderation_decisions";
--   DROP FUNCTION forbid_moderation_decisions_mutation();
--   DROP TABLE "moderation_flags";
--   DROP TABLE "moderation_decisions";   -- DESTRUCTIVE: the accountability log.
--       DELETE cannot undo rows here at all (the triggers refuse it), so only
--       DROP TABLE will do it, and recovery is a restore from the nightly
--       backup — losing every decision made since.
--   DROP TABLE "ambassador_municipalities"; -- DESTRUCTIVE: every grant
--   ALTER TABLE "account_deletions" DROP COLUMN "moderation_decisions_preserved";
--   DROP TYPE "moderation_decision"; DROP TYPE "moderation_target";
--   (the moderator → ambassador conversion is NOT reversible: which accounts
--    were moderators is not recorded anywhere after this runs)
SET lock_timeout = '3s';--> statement-breakpoint
CREATE TYPE "public"."moderation_decision" AS ENUM('approved', 'rejected', 'reviewed', 'dismissed', 'verified', 'gone');--> statement-breakpoint
CREATE TYPE "public"."moderation_target" AS ENUM('photo', 'report', 'facility');--> statement-breakpoint
CREATE TABLE "ambassador_municipalities" (
	"user_id" text NOT NULL,
	"municipality_id" integer NOT NULL,
	"granted_by" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ambassador_municipalities_user_id_municipality_id_pk" PRIMARY KEY("user_id","municipality_id")
);
--> statement-breakpoint
CREATE TABLE "moderation_decisions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "moderation_decisions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" text NOT NULL,
	"target_type" "moderation_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"facility_id" uuid NOT NULL,
	"municipality_id" integer,
	"decision" "moderation_decision" NOT NULL,
	"queued_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_decisions_actor_not_blank" CHECK (btrim("moderation_decisions"."actor_id") <> ''),
	CONSTRAINT "moderation_decisions_order" CHECK ("moderation_decisions"."decided_at" >= "moderation_decisions"."queued_at"),
	CONSTRAINT "moderation_decisions_decision_matches_target" CHECK (("moderation_decisions"."target_type" = 'photo' AND "moderation_decisions"."decision" IN ('approved', 'rejected'))
          OR ("moderation_decisions"."target_type" = 'report' AND "moderation_decisions"."decision" IN ('reviewed', 'dismissed'))
          OR ("moderation_decisions"."target_type" = 'facility' AND "moderation_decisions"."decision" IN ('verified', 'gone'))),
	CONSTRAINT "moderation_decisions_facility_target" CHECK ("moderation_decisions"."target_type" <> 'facility' OR "moderation_decisions"."target_id" = "moderation_decisions"."facility_id")
);
--> statement-breakpoint
CREATE TABLE "moderation_flags" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "moderation_flags_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"target_type" "moderation_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_flags_reason_format" CHECK ("moderation_flags"."reason" ~ '^[a-z][a-z0-9_]{2,39}$'),
	CONSTRAINT "moderation_flags_note_len" CHECK ("moderation_flags"."note" IS NULL OR char_length("moderation_flags"."note") <= 300)
);
--> statement-breakpoint
ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "moderation_decisions_preserved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ambassador_municipalities" ADD CONSTRAINT "ambassador_municipalities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_municipalities" ADD CONSTRAINT "ambassador_municipalities_municipality_id_municipalities_id_fk" FOREIGN KEY ("municipality_id") REFERENCES "public"."municipalities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ambassador_municipalities" ADD CONSTRAINT "ambassador_municipalities_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_municipality_id_municipalities_id_fk" FOREIGN KEY ("municipality_id") REFERENCES "public"."municipalities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ambassador_municipalities_municipality_idx" ON "ambassador_municipalities" USING btree ("municipality_id");--> statement-breakpoint
CREATE INDEX "ambassador_municipalities_granted_by_idx" ON "ambassador_municipalities" USING btree ("granted_by") WHERE "ambassador_municipalities"."granted_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "moderation_decisions_actor_decided_idx" ON "moderation_decisions" USING btree ("actor_id","decided_at");--> statement-breakpoint
CREATE INDEX "moderation_decisions_decided_idx" ON "moderation_decisions" USING btree ("decided_at");--> statement-breakpoint
CREATE INDEX "moderation_decisions_municipality_decided_idx" ON "moderation_decisions" USING btree ("municipality_id","decided_at");--> statement-breakpoint
CREATE INDEX "moderation_decisions_target_idx" ON "moderation_decisions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "moderation_decisions_facility_idx" ON "moderation_decisions" USING btree ("facility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_flags_target_reason_unique" ON "moderation_flags" USING btree ("target_type","target_id","reason");--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
          AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
          AND "account_deletions"."moderation_decisions_preserved" >= 0);--> statement-breakpoint
-- Retire 'moderator': convert any holders, then forbid the value (see header).
UPDATE "users" SET role = 'ambassador' WHERE role = 'moderator';--> statement-breakpoint
-- Append-only enforcement, mirroring facility_edits. search_path is pinned so
-- the function cannot be influenced by the caller's session.
CREATE FUNCTION forbid_moderation_decisions_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'moderation_decisions is append-only (accountability log)';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "moderation_decisions_no_update"
BEFORE UPDATE ON "moderation_decisions"
FOR EACH ROW EXECUTE FUNCTION forbid_moderation_decisions_mutation();--> statement-breakpoint
CREATE TRIGGER "moderation_decisions_no_delete"
BEFORE DELETE ON "moderation_decisions"
FOR EACH ROW EXECUTE FUNCTION forbid_moderation_decisions_mutation();--> statement-breakpoint
CREATE TRIGGER "moderation_decisions_no_truncate"
BEFORE TRUNCATE ON "moderation_decisions"
FOR EACH STATEMENT EXECUTE FUNCTION forbid_moderation_decisions_mutation();--> statement-breakpoint
-- A scope row must never outlive the role. addMunicipality checks the role at
-- insert time and revokeAmbassador deletes the rows, but ADMIN_EMAILS demotes
-- an admin straight to 'user' without going through either — this makes the
-- database enforce it, so a later re-grant can never silently restore
-- municipalities nobody chose.
CREATE FUNCTION drop_scope_when_not_ambassador() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.ambassador_municipalities WHERE user_id = NEW.id;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "users_role_change_drops_scope"
AFTER UPDATE OF role ON "users"
FOR EACH ROW WHEN (NEW.role <> 'ambassador')
EXECUTE FUNCTION drop_scope_when_not_ambassador();--> statement-breakpoint
COMMENT ON TABLE "ambassador_municipalities" IS 'The moderation authorization boundary: every moderation statement joins against it, so an out-of-scope decision updates zero rows. One row per municipality — an ambassador may hold several.';--> statement-breakpoint
COMMENT ON TABLE "moderation_decisions" IS 'Append-only accountability log. actor_id is an opaque users.id with no FK so decisions survive the moderator erasing their account; municipality_id is the scope AT DECISION TIME (RESTRICT, never SET NULL, so history cannot be rewritten); queued_at makes time-to-decision a subtraction on one row.';--> statement-breakpoint
COMMENT ON TABLE "moderation_flags" IS 'Assistive pre-screen output (docs/prompts/moderation-prescreen.md). Inert by construction: no status, no link to a decision. A flag never decides anything — a human does.';--> statement-breakpoint
COMMENT ON COLUMN "users"."role" IS 'user | ambassador | admin. The moderator value is retired (CHECK-forbidden); ambassador authority is scoped by ambassador_municipalities, not by rank.';--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_not_moderator" CHECK ("users"."role" <> 'moderator');
