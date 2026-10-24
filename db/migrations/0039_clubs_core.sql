-- 0039_clubs_core: the tenancy core of the «Клубове» add-on — clubs, their
-- locations, paired kiosk tablets, staff and staff invites, and each club's own
-- append-only audit log (docs/ROADMAP.md Stage 9, docs/MONETISATION.md S7).
--
-- WHAT A CLUB IS. A private gym, studio, sports club or trainer that runs its
-- day on POPS: members, abonnements, classes, attendance. The NGO is the
-- PROCESSOR of a club's client data and the club is the CONTROLLER (Art. 28
-- GDPR), which shapes everything below: the club's records survive a POPS
-- account's erasure, and a club can erase its own client.
--
-- SIX RULES HOLD FOR EVERY CLUB TABLE (0039–0044), and the tests in
-- db/src/club-*.test.ts assert them:
--   1. TENANCY IS IN THE KEYS. Every row carries club_id, every parent carries
--      UNIQUE (club_id, id), and every intra-module foreign key is COMPOSITE on
--      (club_id, parent_id). A booking therefore cannot point at another club's
--      occurrence even if an application scope check were bypassed — the
--      database refuses it with 23503. ON DELETE SET NULL names the one column
--      it nulls (PG 15+), so club_id is never cleared with it.
--   2. SCOPE IS IN THE STATEMENT. apps/web/lib/clubs/scope.ts embeds the actor's
--      club_staff membership in every query (the ambassador pattern of
--      apps/web/lib/moderation.ts), so an out-of-scope write updates zero rows.
--   3. DERIVED STATE LIVES IN VIEWS, never in columns: membership balance,
--      charge status, member status, waitlist position (0041–0043).
--   4. LEDGERS ARE APPEND-ONLY BY TRIGGER and carry no free text.
--   5. NO CHECK NAMES A COLUMN THAT A `users` CASCADE NULLS (the 0009/0014
--      trap: a CHECK like that turns GDPR erasure into a constraint violation).
--      The only users references are club_staff.user_id (CASCADE — the grant
--      leaves with the account), club_member_links.user_id (0040, CASCADE) and
--      two `granted_by`/`created_by` columns that are SET NULL and in no CHECK.
--   6. NOTHING HERE IS ON THE OPEN-DATA ALLOWED_RELATIONS
--      (lib/src/opendata/schema.ts), and DENIED_IDENTIFIERS gains the club
--      vocabulary in the same change.
-- TEXT + CHECK throughout, never a new enum type: a CHECK can be widened in a
-- later migration, an enum value can never be dropped.
--
-- INTRA-CLUB REFERENCES THAT MUST NOT BE DELETED (a plan that was sold, a
-- location with history) use NO ACTION rather than RESTRICT, on purpose: NO
-- ACTION is checked at the END of the statement, so the purge's single
-- `DELETE FROM clubs` can cascade through parent and child in any order, while
-- a stand-alone delete of the parent is still refused.
--
-- ENTITLEMENT IS A PREDICATE, NOT A FLAG. Whether a club may write is
--   status = 'active' AND (tier = 'community'
--                          OR coalesce(paid_until, trial_ends_on) + 14 >= today)
-- written once in apps/web/lib/clubs/access.ts and embedded in every write. No
-- column says "paid" — the operator sets paid_until when the invoice is paid
-- (operator decision 2026-10-24: invoice + manual activation, no card billing).
--
-- THE AUDIT LOG. club_audit is the CLUB's accountability record (who sold,
-- refunded, erased, exported) and is shown to the club's owner. The NGO's own
-- admin changes to a club go to admin_actions (0033) with the 0038 values; an
-- NGO admin READING a club's data is logged here as 'ngo_admin_viewed', where
-- the club — the controller — can see it.
--
-- PURGE. A club archived for 90 days is deleted from /admin/klubove with one
-- `DELETE FROM clubs`, which cascades to everything. The append-only triggers
-- refuse that cascade UNLESS the transaction has set
--   SELECT set_config('pops.purging_club', '<club id>', true);
-- for that very club. A GUC is not a security boundary against someone with SQL
-- access (nor is DISABLE TRIGGER), and it does not try to be: it is friction
-- against an application bug deleting a ledger, and it is scoped to one club and
-- one transaction (is_local = true).
--
-- admin_actions: the subject rule (0033's admin_actions_subject_matches_action)
-- is rewritten so the club-level actions are subjectless (a club is not an
-- account). club_staff_granted/_revoked DO name the account they changed. The
-- comparison is `action::text` because the values were added by 0038 in this
-- same transaction (see 0038's header).
--
-- Locking: every table is new. The two statements that touch existing tables:
--   * the FKs to users, municipalities, facilities and businesses take SHARE ROW
--     EXCLUSIVE on the referenced table until COMMIT (writes wait, reads do
--     not); they are placed last, before the comments.
--   * the admin_actions constraint swap takes ACCESS EXCLUSIVE on a small,
--     append-only, admin-only table and re-validates it with one scan.
-- lock_timeout fails the deploy fast rather than queueing behind a reader.
--
-- rollback (compensating SQL, ONE explicit transaction, reverse order; revert
-- the application first — apps/web/lib/clubs reads these tables):
--   ALTER TABLE "admin_actions" DROP CONSTRAINT "admin_actions_subject_matches_action",
--     ADD CONSTRAINT "admin_actions_subject_matches_action" CHECK (("admin_actions"."subject_id" IS NULL) = ("admin_actions"."action" IN ('setting_changed', 'business_visibility_changed')));
--       -- fails if any club_* row exists; those rows are append-only by design.
--   DROP TABLE "club_audit", "club_staff_invites", "club_staff",
--              "club_kiosk_devices", "club_locations", "clubs" CASCADE;
--       -- DESTRUCTIVE: every club and its configuration (0040–0044 must be
--       -- rolled back first).
--   DROP FUNCTION club_ledger_append_only(); DROP FUNCTION club_ledger_no_truncate();
--   DROP FUNCTION club_slug_list_valid(text[], integer);
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
-- A list of slugs (sports a club offers): each one has the shape of
-- play_sessions.sport, at most `max_items`, no NULLs and no repeats.
-- IMMUTABLE because a CHECK may only call immutable functions; it reads only
-- its arguments, so the label is honest. search_path pinned like every
-- function in this schema.
CREATE FUNCTION club_slug_list_valid(items text[], max_items integer) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT cardinality(items) <= max_items
     AND NOT EXISTS (
       SELECT 1 FROM unnest(items) AS i
        WHERE i IS NULL OR i !~ '^[a-z][a-z0-9_]{1,29}$'
     )
     AND cardinality(items) = (SELECT count(DISTINCT i) FROM unnest(items) AS i)
$$;--> statement-breakpoint
CREATE TABLE "clubs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name_bg" text NOT NULL,
	"name_en" text,
	"kind" text DEFAULT 'gym' NOT NULL,
	"tier" text DEFAULT 'community' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"visible" boolean DEFAULT false NOT NULL,
	"description_bg" text,
	"description_en" text,
	"sports" text[] DEFAULT '{}' NOT NULL,
	"municipality_id" integer,
	"legal_name" text,
	"eik" text,
	"public_email" text,
	"public_phone" text,
	"website_url" text,
	"locale" text DEFAULT 'bg' NOT NULL,
	"timezone" text DEFAULT 'Europe/Sofia' NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"booking_opens_hours" integer DEFAULT 168 NOT NULL,
	"cancel_deadline_hours" integer DEFAULT 2 NOT NULL,
	"mail_unlinked_members" boolean DEFAULT false NOT NULL,
	"logo_path" text,
	"member_cap" integer,
	"trial_ends_on" date,
	"paid_until" date,
	"business_id" bigint,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clubs_slug_unique" UNIQUE("slug"),
	CONSTRAINT "clubs_slug_shape" CHECK ("clubs"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("clubs"."slug") BETWEEN 3 AND 60),
	CONSTRAINT "clubs_name_bg_sane" CHECK (btrim("clubs"."name_bg") <> '' AND char_length("clubs"."name_bg") <= 120),
	CONSTRAINT "clubs_name_en_sane" CHECK ("clubs"."name_en" IS NULL OR (btrim("clubs"."name_en") <> '' AND char_length("clubs"."name_en") <= 120)),
	CONSTRAINT "clubs_kind_known" CHECK ("clubs"."kind" IN ('gym', 'studio', 'club', 'trainer', 'other')),
	CONSTRAINT "clubs_tier_known" CHECK ("clubs"."tier" IN ('community', 'standard', 'pro')),
	CONSTRAINT "clubs_status_known" CHECK ("clubs"."status" IN ('pending', 'active', 'suspended', 'archived')),
	CONSTRAINT "clubs_pending_not_approved" CHECK ("clubs"."status" <> 'pending' OR "clubs"."approved_at" IS NULL),
	CONSTRAINT "clubs_live_was_approved" CHECK ("clubs"."status" NOT IN ('active', 'suspended') OR "clubs"."approved_at" IS NOT NULL),
	CONSTRAINT "clubs_suspended_pair" CHECK (("clubs"."status" = 'suspended') = ("clubs"."suspended_at" IS NOT NULL)),
	CONSTRAINT "clubs_archived_pair" CHECK (("clubs"."status" = 'archived') = ("clubs"."archived_at" IS NOT NULL)),
	CONSTRAINT "clubs_descriptions_sane" CHECK (("clubs"."description_bg" IS NULL OR (btrim("clubs"."description_bg") <> '' AND char_length("clubs"."description_bg") <= 2000))
	      AND ("clubs"."description_en" IS NULL OR (btrim("clubs"."description_en") <> '' AND char_length("clubs"."description_en") <= 2000))),
	CONSTRAINT "clubs_sports_valid" CHECK (club_slug_list_valid("clubs"."sports", 12)),
	CONSTRAINT "clubs_legal_name_sane" CHECK ("clubs"."legal_name" IS NULL OR (btrim("clubs"."legal_name") <> '' AND char_length("clubs"."legal_name") <= 200)),
	CONSTRAINT "clubs_eik_shape" CHECK ("clubs"."eik" IS NULL OR "clubs"."eik" ~ '^([0-9]{9}|[0-9]{13})$'),
	CONSTRAINT "clubs_public_email_shape" CHECK ("clubs"."public_email" IS NULL OR ("clubs"."public_email" = lower("clubs"."public_email") AND char_length("clubs"."public_email") <= 254 AND "clubs"."public_email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
	CONSTRAINT "clubs_public_phone_shape" CHECK ("clubs"."public_phone" IS NULL OR "clubs"."public_phone" ~ '^\+?[0-9 ()-]{5,32}$'),
	CONSTRAINT "clubs_website_shape" CHECK ("clubs"."website_url" IS NULL OR ("clubs"."website_url" ~ '^https?://[^[:space:]]+$' AND char_length("clubs"."website_url") <= 300)),
	CONSTRAINT "clubs_locale_known" CHECK ("clubs"."locale" IN ('bg', 'en')),
	CONSTRAINT "clubs_timezone_supported" CHECK ("clubs"."timezone" = 'Europe/Sofia'),
	CONSTRAINT "clubs_currency_supported" CHECK ("clubs"."currency" = 'EUR'),
	CONSTRAINT "clubs_booking_window_sane" CHECK ("clubs"."booking_opens_hours" BETWEEN 1 AND 2160),
	CONSTRAINT "clubs_cancel_deadline_sane" CHECK ("clubs"."cancel_deadline_hours" BETWEEN 0 AND 168),
	CONSTRAINT "clubs_logo_path_sane" CHECK ("clubs"."logo_path" IS NULL OR ("clubs"."logo_path" ~ '^[A-Za-z0-9/_.-]+$' AND char_length("clubs"."logo_path") <= 300 AND "clubs"."logo_path" NOT LIKE '%..%')),
	CONSTRAINT "clubs_member_cap_sane" CHECK ("clubs"."member_cap" IS NULL OR "clubs"."member_cap" BETWEEN 1 AND 1000000),
	CONSTRAINT "clubs_dates_sane" CHECK (("clubs"."trial_ends_on" IS NULL OR isfinite("clubs"."trial_ends_on")) AND ("clubs"."paid_until" IS NULL OR isfinite("clubs"."paid_until")))
);
--> statement-breakpoint
CREATE TABLE "club_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"facility_id" uuid,
	"address" text,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_locations_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_locations_name_sane" CHECK (btrim("club_locations"."name") <> '' AND char_length("club_locations"."name") <= 120),
	CONSTRAINT "club_locations_address_sane" CHECK ("club_locations"."address" IS NULL OR (btrim("club_locations"."address") <> '' AND char_length("club_locations"."address") <= 300))
);
--> statement-breakpoint
CREATE TABLE "club_kiosk_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"pairing_code_hash" text,
	"pairing_expires_at" timestamp with time zone,
	"secret_hash" text,
	"paired_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_kiosk_devices_name_sane" CHECK (btrim("club_kiosk_devices"."name") <> '' AND char_length("club_kiosk_devices"."name") <= 60),
	CONSTRAINT "club_kiosk_devices_code_hash_shape" CHECK ("club_kiosk_devices"."pairing_code_hash" IS NULL OR "club_kiosk_devices"."pairing_code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "club_kiosk_devices_secret_hash_shape" CHECK ("club_kiosk_devices"."secret_hash" IS NULL OR "club_kiosk_devices"."secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "club_kiosk_devices_code_pair" CHECK (("club_kiosk_devices"."pairing_code_hash" IS NULL) = ("club_kiosk_devices"."pairing_expires_at" IS NULL)),
	CONSTRAINT "club_kiosk_devices_paired_pair" CHECK (("club_kiosk_devices"."secret_hash" IS NULL) = ("club_kiosk_devices"."paired_at" IS NULL)),
	CONSTRAINT "club_kiosk_devices_paired_has_no_code" CHECK ("club_kiosk_devices"."secret_hash" IS NULL OR "club_kiosk_devices"."pairing_code_hash" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "club_staff" (
	"club_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"display_name" text,
	"bio" text,
	"pay_rate_kind" text DEFAULT 'none' NOT NULL,
	"pay_rate_cents" integer,
	"pay_share_bp" integer,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_staff_pkey" PRIMARY KEY("club_id", "user_id"),
	CONSTRAINT "club_staff_role_known" CHECK ("club_staff"."role" IN ('owner', 'manager', 'trainer', 'desk')),
	CONSTRAINT "club_staff_display_name_sane" CHECK ("club_staff"."display_name" IS NULL OR (btrim("club_staff"."display_name") <> '' AND char_length("club_staff"."display_name") <= 80)),
	CONSTRAINT "club_staff_bio_sane" CHECK ("club_staff"."bio" IS NULL OR (btrim("club_staff"."bio") <> '' AND char_length("club_staff"."bio") <= 1000)),
	CONSTRAINT "club_staff_pay_kind_known" CHECK ("club_staff"."pay_rate_kind" IN ('none', 'flat', 'per_head', 'share')),
	CONSTRAINT "club_staff_pay_amount_pair" CHECK (("club_staff"."pay_rate_kind" IN ('flat', 'per_head')) = ("club_staff"."pay_rate_cents" IS NOT NULL)),
	CONSTRAINT "club_staff_pay_share_pair" CHECK (("club_staff"."pay_rate_kind" = 'share') = ("club_staff"."pay_share_bp" IS NOT NULL)),
	CONSTRAINT "club_staff_pay_sane" CHECK (("club_staff"."pay_rate_cents" IS NULL OR "club_staff"."pay_rate_cents" BETWEEN 0 AND 10000000)
	      AND ("club_staff"."pay_share_bp" IS NULL OR "club_staff"."pay_share_bp" BETWEEN 0 AND 10000))
);
--> statement-breakpoint
CREATE TABLE "club_staff_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "club_staff_invites_token_unique" UNIQUE("token_hash"),
	CONSTRAINT "club_staff_invites_token_shape" CHECK ("club_staff_invites"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "club_staff_invites_email_shape" CHECK ("club_staff_invites"."email" = lower("club_staff_invites"."email") AND char_length("club_staff_invites"."email") <= 254 AND "club_staff_invites"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	CONSTRAINT "club_staff_invites_role_known" CHECK ("club_staff_invites"."role" IN ('owner', 'manager', 'trainer', 'desk')),
	CONSTRAINT "club_staff_invites_short_lived" CHECK ("club_staff_invites"."expires_at" > "club_staff_invites"."created_at" AND "club_staff_invites"."expires_at" <= "club_staff_invites"."created_at" + interval '14 days'),
	CONSTRAINT "club_staff_invites_one_outcome" CHECK ("club_staff_invites"."accepted_at" IS NULL OR "club_staff_invites"."revoked_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "club_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "club_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"club_id" uuid NOT NULL,
	"actor_id" text,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"subject_member_id" uuid,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_audit_actor_kind_known" CHECK ("club_audit"."actor_kind" IN ('staff', 'member', 'ngo_admin', 'system', 'kiosk')),
	CONSTRAINT "club_audit_actor_matches_kind" CHECK (("club_audit"."actor_kind" IN ('system', 'kiosk')) = ("club_audit"."actor_id" IS NULL)),
	CONSTRAINT "club_audit_actor_not_blank" CHECK ("club_audit"."actor_id" IS NULL OR btrim("club_audit"."actor_id") <> ''),
	CONSTRAINT "club_audit_action_known" CHECK ("club_audit"."action" IN (
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
	    'import_committed', 'export_downloaded', 'ngo_admin_viewed')),
	CONSTRAINT "club_audit_detail_object" CHECK (jsonb_typeof("club_audit"."detail") = 'object'),
	CONSTRAINT "club_audit_detail_small" CHECK (octet_length("club_audit"."detail"::text) <= 512),
	CONSTRAINT "club_audit_acted_at_finite" CHECK (isfinite("club_audit"."acted_at"))
);
--> statement-breakpoint
CREATE INDEX "clubs_status_idx" ON "clubs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "clubs_municipality_idx" ON "clubs" USING btree ("municipality_id") WHERE "clubs"."municipality_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "clubs_business_idx" ON "clubs" USING btree ("business_id") WHERE "clubs"."business_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_locations_facility_idx" ON "club_locations" USING btree ("facility_id") WHERE "club_locations"."facility_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "club_locations_one_per_facility" ON "club_locations" USING btree ("club_id","facility_id") WHERE "club_locations"."facility_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_kiosk_devices_location_idx" ON "club_kiosk_devices" USING btree ("club_id","location_id");--> statement-breakpoint
-- Two live pairing codes in one club may not collide, or a tablet typing the
-- code could pair the wrong device. The application retries a collision.
CREATE UNIQUE INDEX "club_kiosk_devices_live_code_unique" ON "club_kiosk_devices" USING btree ("club_id","pairing_code_hash") WHERE "club_kiosk_devices"."pairing_code_hash" IS NOT NULL;--> statement-breakpoint
-- "Which clubs do I work at" — the /klub hub and requireClubStaff.
CREATE INDEX "club_staff_user_idx" ON "club_staff" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "club_staff_granted_by_idx" ON "club_staff" USING btree ("granted_by") WHERE "club_staff"."granted_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_staff_invites_club_idx" ON "club_staff_invites" USING btree ("club_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "club_staff_invites_created_by_idx" ON "club_staff_invites" USING btree ("created_by") WHERE "club_staff_invites"."created_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_audit_club_acted_idx" ON "club_audit" USING btree ("club_id","acted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "club_audit_member_acted_idx" ON "club_audit" USING btree ("club_id","subject_member_id","acted_at" DESC NULLS LAST) WHERE "club_audit"."subject_member_id" IS NOT NULL;--> statement-breakpoint
-- Append-only, with ONE escape: deleting the rows of the club this transaction
-- is purging (see the header). UPDATE is never allowed. Shared by club_audit
-- and club_monthly_activity (0044); club_payments has its own guard (0041)
-- because it must also admit anonymisation.
CREATE FUNCTION club_ledger_append_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND OLD.club_id::text = current_setting('pops.purging_club', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE FUNCTION club_ledger_no_truncate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_audit_no_update" BEFORE UPDATE ON "club_audit" FOR EACH ROW EXECUTE FUNCTION club_ledger_append_only();--> statement-breakpoint
CREATE TRIGGER "club_audit_no_delete" BEFORE DELETE ON "club_audit" FOR EACH ROW EXECUTE FUNCTION club_ledger_append_only();--> statement-breakpoint
CREATE TRIGGER "club_audit_no_truncate" BEFORE TRUNCATE ON "club_audit" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
CREATE TRIGGER "clubs_set_updated_at" BEFORE UPDATE ON "clubs" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER "club_locations_set_updated_at" BEFORE UPDATE ON "club_locations" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER "club_staff_set_updated_at" BEFORE UPDATE ON "club_staff" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
ALTER TABLE "club_locations" ADD CONSTRAINT "club_locations_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_kiosk_devices" ADD CONSTRAINT "club_kiosk_devices_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_kiosk_devices" ADD CONSTRAINT "club_kiosk_devices_location_fk" FOREIGN KEY ("club_id","location_id") REFERENCES "public"."club_locations"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_staff" ADD CONSTRAINT "club_staff_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_staff_invites" ADD CONSTRAINT "club_staff_invites_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_audit" ADD CONSTRAINT "club_audit_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_municipality_id_municipalities_id_fk" FOREIGN KEY ("municipality_id") REFERENCES "public"."municipalities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_locations" ADD CONSTRAINT "club_locations_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_staff" ADD CONSTRAINT "club_staff_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_staff" ADD CONSTRAINT "club_staff_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_staff_invites" ADD CONSTRAINT "club_staff_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_actions" DROP CONSTRAINT "admin_actions_subject_matches_action",
	ADD CONSTRAINT "admin_actions_subject_matches_action" CHECK (("admin_actions"."subject_id" IS NULL) = ("admin_actions"."action"::text IN (
	    'setting_changed', 'business_visibility_changed',
	    'club_created', 'club_updated', 'club_status_changed', 'club_plan_changed', 'club_purged')));--> statement-breakpoint
COMMENT ON TABLE "clubs" IS 'A tenant of the «Клубове» add-on: a gym, studio, club or trainer. The club is the CONTROLLER of its client records, POPS the processor. Entitlement to write is derived (apps/web/lib/clubs/access.ts: active AND (community OR coalesce(paid_until, trial_ends_on) + 14 days >= Sofia today)), never stored. Not on the open-data ALLOWED_RELATIONS.';--> statement-breakpoint
COMMENT ON COLUMN "clubs"."paid_until" IS 'Last day the operator''s invoice covers, set by hand in /admin/klubove when the bank transfer arrives (operator decision 2026-10-24: no card billing). A 14-day grace follows before writes stop.';--> statement-breakpoint
COMMENT ON COLUMN "clubs"."visible" IS 'The owner''s own switch for the public page. The page renders only when this AND status = active AND the entitlement predicate hold (CLUB_RENDERABLE in apps/web/lib/clubs/public.ts).';--> statement-breakpoint
COMMENT ON COLUMN "clubs"."public_email" IS 'The club''s BUSINESS contact, published by the club itself. There is deliberately no contact-person or billing-contact column: natural persons stay in the offline CRM (the partners rule, 0019).';--> statement-breakpoint
COMMENT ON TABLE "club_locations" IS 'Where a club trains. facility_id links a map facility (the club block on its page); address is free text for a hall that is not on the map. There are deliberately NO coordinates — an address is what a club publishes, and a pin picked in the browser is never stored.';--> statement-breakpoint
COMMENT ON TABLE "club_kiosk_devices" IS 'A tablet at a club desk showing the rotating check-in QR. Paired once with a 6-digit code (hash stored, 10 minutes); the tablet then holds a random secret in an httpOnly cookie scoped to the kiosk path and only its SHA-256 lives here. Revocation is setting revoked_at; the next refresh stops working.';--> statement-breakpoint
COMMENT ON TABLE "club_staff" IS 'Who works at a club and in what role (owner, manager, trainer, desk). user_id CASCADE: a grant leaves with the account. There is no last-owner trigger — it would make erasure blockable; the application refuses demoting the last owner and /admin/klubove lists ownerless clubs.';--> statement-breakpoint
COMMENT ON COLUMN "club_staff"."pay_rate_kind" IS 'Report data only: per-head counts are computed at read time from check-ins. POPS runs no payroll and stores no amounts owed to anyone.';--> statement-breakpoint
COMMENT ON TABLE "club_audit" IS 'The CLUB''s accountability log (who sold, refunded, exported, erased), shown to the club owner. Append-only by trigger except during a purge of that very club (pops.purging_club). actor_id and subject_member_id are carried by value so erasure cannot remove the record. No free text: detail is a small object of ids and counts written by apps/web/lib/clubs/audit.ts.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
