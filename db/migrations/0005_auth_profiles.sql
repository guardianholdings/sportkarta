-- 0005_auth_profiles: better-auth tables + minimal member profile + roles
-- (docs/ROADMAP.md §5). Mostly all-new tables. Three changes touch existing
-- tables: facility_photos.uploaded_by gains the FK migration 0001 promised
-- "when the users table exists" (plus a covering index and a data fix, below),
-- facility_edits gains an index on actor, and two column COMMENTs are updated.
--
-- Three deliberate properties, each enforced by the database rather than by
-- application convention:
--   1. No date-of-birth column exists. The profile form derives is_minor and
--      discards the date (lib/src/age.ts); nothing persists it.
--   2. sessions.ip_address is CHECK-constrained to stay empty — the privacy
--      page promises visitor IPs are never stored, and IP tracking is off in
--      the better-auth options (which writes '' rather than NULL, hence the
--      coalesce; neither value is an address).
--   3. facility_edits gets NO foreign key to users and no DML here. It is
--      append-only (triggers from 0001) and must survive account erasure: the
--      audit trail keeps the opaque actor id while the person behind it
--      becomes unrecoverable. Contributions then display as "former user"
--      (i18n string), never as a name. The added index only speeds up the
--      erasure path's count; it changes no data.
--
-- DATA CHANGE (expected to affect zero rows): facility_photos.uploaded_by must
-- reference users.id before the FK is valid. No code path has ever written a
-- non-NULL value there — the only writer, the anonymous report flow, inserts
-- NULL — so in practice this clears nothing. The statement is scoped to values
-- with no matching user so it cannot destroy a legitimate reference, and is
-- idempotent. Anything it does clear (hand-inserted Stage-1 rows) is a photo
-- ATTRIBUTION record, recoverable only from that night's backup;
-- facility_edits does not hold photo uploads, so it is not a substitute.
--
-- rollback (compensating SQL, reverse order):
--   COMMENT ON COLUMN "facility_photos"."uploaded_by" IS NULL;
--   COMMENT ON COLUMN "facility_edits"."actor" IS NULL;
--   DROP INDEX "facility_photos_uploaded_by_idx";
--   DROP INDEX "facility_edits_actor_idx";
--   ALTER TABLE "facility_photos" DROP CONSTRAINT "facility_photos_uploaded_by_users_id_fk";
--   DROP TRIGGER "verifications_set_updated_at" ON "verifications";
--   DROP TRIGGER "accounts_set_updated_at" ON "accounts";
--   DROP TRIGGER "sessions_set_updated_at" ON "sessions";
--   DROP TRIGGER "users_set_updated_at" ON "users";
--   DROP TABLE "verifications"; DROP TABLE "accounts"; DROP TABLE "sessions";
--   DROP TABLE "account_deletions"; DROP TABLE "users";
--   DROP TYPE "user_role";
--   (any uploaded_by value cleared above: restore from backup — destructive)
CREATE TYPE "public"."user_role" AS ENUM('user', 'ambassador', 'moderator', 'admin');--> statement-breakpoint
CREATE TABLE "account_deletions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "account_deletions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"audit_rows_preserved" integer DEFAULT 0 NOT NULL,
	"photos_anonymized" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "account_deletions_user_id_not_blank" CHECK (btrim("account_deletions"."user_id") <> ''),
	CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0)
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token"),
	CONSTRAINT "sessions_no_ip_stored" CHECK (coalesce("sessions"."ip_address", '') = '')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"home_city" text,
	"is_minor" boolean DEFAULT false NOT NULL,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_email_not_blank" CHECK (btrim("users"."email") <> ''),
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_display_name_len" CHECK (char_length("users"."display_name") <= 200),
	CONSTRAINT "users_home_city_sane" CHECK ("users"."home_city" IS NULL OR (btrim("users"."home_city") <> '' AND char_length("users"."home_city") <= 80))
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_deletions_deleted_at_idx" ON "account_deletions" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "account_deletions_user_id_idx" ON "account_deletions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_unique" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verifications_expires_at_idx" ON "verifications" USING btree ("expires_at");--> statement-breakpoint
-- See the DATA CHANGE note in the header: scoped so it can only clear values
-- that no user row can satisfy, and expected to affect zero rows.
UPDATE "facility_photos" SET "uploaded_by" = NULL
WHERE "uploaded_by" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = "facility_photos"."uploaded_by");--> statement-breakpoint
ALTER TABLE "facility_photos" ADD CONSTRAINT "facility_photos_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facility_edits_actor_idx" ON "facility_edits" USING btree ("actor") WHERE "facility_edits"."actor" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "facility_photos_uploaded_by_idx" ON "facility_photos" USING btree ("uploaded_by") WHERE "facility_photos"."uploaded_by" IS NOT NULL;--> statement-breakpoint
-- Reuses set_updated_at() from migration 0001. better-auth also sets these
-- columns itself; the triggers make direct SQL (profile edits, admin fixes)
-- correct too.
CREATE TRIGGER "users_set_updated_at"
BEFORE UPDATE ON "users"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER "sessions_set_updated_at"
BEFORE UPDATE ON "sessions"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER "accounts_set_updated_at"
BEFORE UPDATE ON "accounts"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER "verifications_set_updated_at"
BEFORE UPDATE ON "verifications"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
COMMENT ON TABLE "users" IS 'Member profiles. No date of birth is stored: the profile form derives is_minor (lib/src/age.ts) and discards the date. Do not add a DOB column.';--> statement-breakpoint
COMMENT ON COLUMN "users"."is_minor" IS 'Derived once from a date of birth that is never persisted. Gates minor protections (no individual public leaderboards).';--> statement-breakpoint
COMMENT ON COLUMN "sessions"."ip_address" IS 'Always NULL or the empty string (CHECK-enforced) — never an address. IP tracking is disabled in the better-auth options; IPs are used transiently for rate-limiting only.';--> statement-breakpoint
COMMENT ON TABLE "account_deletions" IS 'GDPR erasure tombstones. Holds no personal data: only the opaque id of the erased account plus counts, so an erasure can be evidenced without retaining anything about the person.';--> statement-breakpoint
COMMENT ON COLUMN "facility_edits"."actor" IS 'Opaque users.id, or a Stage-1 admin name on historic rows. Intentionally NOT a foreign key: the audit log is append-only and must survive account erasure, after which the id resolves to nothing and the UI shows the "former user" label.';--> statement-breakpoint
-- Supersedes the 0001 comment ("FK added when the users table exists").
COMMENT ON COLUMN "facility_photos"."uploaded_by" IS 'Uploader (users.id), or NULL for anonymous and erased uploads. ON DELETE SET NULL is the GDPR mechanism: erasing an account anonymises their photos in the same statement.';