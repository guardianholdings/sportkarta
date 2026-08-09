-- Account access log — the accountability trail for the admin account-management
-- module (/admin/akaunti).
--
-- WHY THIS EXISTS. That module lets an admin open ONE person and read everything
-- the platform has recorded about them: their contributions, their play history,
-- their trainings, and — behind the two consents on `users` — their GPS routes
-- and their heart rate, which is GDPR Art. 9 special-category health data. A
-- capability like that is legitimate for a data controller and dangerous without
-- a record: "who looked at whom, and when" is the only question that
-- distinguishes administration from surveillance, and nothing in this schema
-- could answer it before this table.
--
-- It is modelled on `moderation_decisions` (0007) and shares its three
-- properties, for the same reasons:
--
--   1. APPEND-ONLY, enforced by triggers rather than by convention. A log an
--      admin can edit is not a log. The trigger function pins its search_path so
--      it cannot be influenced by the calling session.
--   2. NO FOREIGN KEYS on actor_id or subject_id. Both are opaque `users.id`
--      values carried by value. This is load-bearing twice over: an admin who
--      later erases their own account must not take the record of their access
--      with them, and — more importantly — a SUBJECT's erasure must not delete
--      the evidence that their data was read while it existed. A FK with any
--      ON DELETE action would do exactly that, and CASCADE would do it silently.
--      After either erasure the id resolves to nothing, which is the same
--      "former user" state `facility_edits.actor` and
--      `moderation_decisions.actor_id` already rely on.
--   3. NARROW BY CONSTRUCTION. Four columns and an enum. There is deliberately
--      NO free-text column, no note, no query string, no email address, no IP
--      and no user agent — an access log that accumulated those would become a
--      second store of the personal data it exists to protect, and it would be
--      the one store nobody thought to include in an erasure. It records THAT a
--      scope was opened, never WHAT was in it.
--
-- SCOPES, narrowest to widest. Recorded separately rather than as one "viewed"
-- event because the interesting question is not whether an admin opened an
-- account — they do that to answer support mail — but whether anyone opened the
-- health panel, which nothing in the product needs and which is the one read a
-- member would want accounted for:
--
--   overview  the account screen: identity, consent state, contributions,
--             points, play history, training list WITHOUT routes or metrics.
--   training  the per-training detail, including the stored GPS route
--             (`training_routes`), gated on users.training_route_consent_at.
--   health    heart rate and calories (`training_metrics`), gated on
--             users.training_health_consent_at. Art. 9 data.
--   export    a machine-readable dump of the above, which is the read most
--             likely to leave the building.
--
-- RETENTION is deliberately unbounded here. An accountability record that
-- expires cannot answer a question asked later, and the table is tiny: one row
-- per admin panel view, on a platform with a handful of admins. If that ever
-- changes, prune by `viewed_at` — never by subject, which would let the erasure
-- of an account also erase the record of who read it. NOTE that a prune is not
-- a plain DELETE: the trigger below refuses every one, so it requires
-- ALTER TABLE account_access_log DISABLE TRIGGER account_access_log_no_delete
-- inside the same transaction. That is deliberate friction, not an oversight —
-- deleting an accountability record should be a decision somebody makes on
-- purpose.
--
-- Locking: everything is new. No existing table is altered, no index is built on
-- a populated relation, so this takes no lock anything else contends for.
--
-- rollback (compensating SQL, reverse order; DESTRUCTIVE — drops the log):
--   DROP TRIGGER "account_access_log_no_truncate" ON "account_access_log";
--   DROP TRIGGER "account_access_log_no_delete" ON "account_access_log";
--   DROP TRIGGER "account_access_log_no_update" ON "account_access_log";
--   DROP FUNCTION forbid_account_access_log_mutation();
--   DROP TABLE "account_access_log";
--   DROP TYPE "account_access_scope";

CREATE TYPE "public"."account_access_scope" AS ENUM('overview', 'training', 'health', 'export');--> statement-breakpoint
CREATE TABLE "account_access_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_access_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"scope" "account_access_scope" NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_access_log_actor_not_blank" CHECK (btrim("account_access_log"."actor_id") <> ''),
	CONSTRAINT "account_access_log_subject_not_blank" CHECK (btrim("account_access_log"."subject_id") <> ''),
	CONSTRAINT "account_access_log_viewed_at_finite" CHECK (isfinite("account_access_log"."viewed_at"))
);
--> statement-breakpoint
-- "who has read this person's data" — the member-facing question, and the one a
-- regulator asks first. Leading column is the subject for that reason.
CREATE INDEX "account_access_log_subject_viewed_idx" ON "account_access_log" USING btree ("subject_id","viewed_at" DESC NULLS LAST);--> statement-breakpoint
-- "what has this admin been reading" — the supervision question.
CREATE INDEX "account_access_log_actor_viewed_idx" ON "account_access_log" USING btree ("actor_id","viewed_at" DESC NULLS LAST);--> statement-breakpoint
-- "who opened a health panel, ever" — a scan small enough to be answered without
-- naming an account first. Partial, because the other three scopes are routine
-- and would bloat an index whose only purpose is the exceptional read.
CREATE INDEX "account_access_log_health_idx" ON "account_access_log" USING btree ("viewed_at" DESC NULLS LAST) WHERE "account_access_log"."scope" = 'health';--> statement-breakpoint
-- Append-only enforcement, mirroring moderation_decisions (0007) and
-- facility_edits (0001). search_path is pinned so the function cannot be
-- influenced by the caller's session.
CREATE FUNCTION forbid_account_access_log_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'account_access_log is append-only (accountability log)';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "account_access_log_no_update"
BEFORE UPDATE ON "account_access_log"
FOR EACH ROW EXECUTE FUNCTION forbid_account_access_log_mutation();--> statement-breakpoint
CREATE TRIGGER "account_access_log_no_delete"
BEFORE DELETE ON "account_access_log"
FOR EACH ROW EXECUTE FUNCTION forbid_account_access_log_mutation();--> statement-breakpoint
CREATE TRIGGER "account_access_log_no_truncate"
BEFORE TRUNCATE ON "account_access_log"
FOR EACH STATEMENT EXECUTE FUNCTION forbid_account_access_log_mutation();
