-- 0040_club_members: a club's clients, households, and the optional link
-- between a client record and a POPS account (operator decision 2026-10-24:
-- "optional linking").
--
-- THE CLUB OWNS THE RECORD. club_members is the club's own client list — the
-- club is controller, POPS processor — and it exists whether or not the person
-- has a POPS account. Most gym clients never will. The record holds what a desk
-- needs and nothing more:
--   * NO DATE OF BIRTH, as everywhere in this schema (lib/src/age.ts,
--     apps/web/tests/dob-not-persisted.test.ts). `is_minor` is a boolean the
--     desk ticks; a child hangs under a guardian record (guardian_member_id),
--     and club_members_guardian_only_for_minors makes "an adult with a
--     guardian" unrepresentable. Minors are never mailed directly (the worker
--     routes to the guardian), which is an application rule with a test.
--   * email is NOT unique: households share an inbox, and the desk types what
--     the client says. It is stored lowercase so the claim match is exact.
--   * one staff_note, deleted with the row; no free-text history.
--   * card_token_hash is a SHA-256 of a printed card key, CHECK-pinned to 64 hex
--     characters like api_keys.key_hash, so the column cannot hold a key.
--   * status (lead / trial / active / lapsed / archived) is DERIVED by a view in
--     0043, never stored.
--
-- THE LINK IS A SEPARATE TABLE, and that is the GDPR design. club_member_links
-- is the ONLY place the module references users for a client, with ON DELETE
-- CASCADE. Erasing a POPS account therefore removes exactly one link row per
-- club and nothing the club owns: the club's record, bookings, check-ins and
-- payment records stay, because they are the controller's data, not POPS's to
-- delete. Putting user_id on club_members instead would have forced either a
-- CASCADE (deleting a business's financial records because a customer closed
-- an unrelated account) or a SET NULL column inside CHECKs (the 0009/0014 trap).
--   * status: pending (claimed by the member, awaiting the desk), active,
--     declined («Това не съм аз» — the member said an email-matched record is
--     not theirs; an explicit invite still overrides it).
--   * method: invite (staff invited the address), claim (the member claimed an
--     email-matched record), self (the member created their own record by
--     booking a trial class from the club's public page).
--   * passport_consent_at: the member's consent for their QR-verified club
--     attendance to be written to their own POPS training log (0043). It dies
--     with the link, which is the withdrawal semantics we want.
--   * UNIQUE (club_id, user_id) among non-declined links: one record per person
--     per club; a declined match does not block linking the right one.
--
-- INVITES carry a token HASH (64 hex), expire within 14 days, and are accepted
-- only by a signed-in user whose VERIFIED address equals the invited one
-- (apps/web/lib/clubs/links.ts).
--
-- ERASURE BY THE CLUB (a client exercising Art. 17 at their gym) is one DELETE
-- on club_members, scoped to the club. It cascades to links, invites, bookings,
-- check-ins, memberships and notifications (0041–0044); charges and payments
-- keep their rows with member_id set NULL, so the club's books stay whole and
-- name nobody. A child whose guardian is erased keeps their record with the
-- guardian reference cleared (SET NULL on that one column).
-- `erasure_requested_at` is a linked member asking the club, from the portal,
-- to do that; the office shows it until the owner acts.
--
-- account_deletions gains two counters, so POPS's own erasure tombstone can
-- evidence what left with the account: club_staff rows (staff grants) and
-- club_member_links rows. Inserted before the users FKs, as every counter block
-- since 0006 (the 0013 deadlock ordering).
--
-- Locking: three new tables (nothing contends). account_deletions takes ACCESS
-- EXCLUSIVE for two catalogue-only ADD COLUMNs (constant defaults, PG 11+) and a
-- CHECK re-validation over a small table; the FK to users takes SHARE ROW
-- EXCLUSIVE on users until COMMIT, placed last.
--
-- rollback (ONE explicit transaction; revert the application first —
-- apps/web/lib/account-deletion.ts inserts the two counters):
--   ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";
--   ALTER TABLE "account_deletions" DROP COLUMN "club_member_links_erased";  -- DESTRUCTIVE:
--   ALTER TABLE "account_deletions" DROP COLUMN "club_staff_erased";         -- erasure receipts
--   ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK (<the 0013 list>);
--   DROP TABLE "club_member_invites", "club_member_links", "club_members";  -- DESTRUCTIVE
--   DROP FUNCTION club_tags_valid(text[]);
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- Staff-typed labels on a client ("Сутрешна група", "VIP"): at most 20, each
-- trimmed, 1–30 characters, no comma (the CSV export joins them with one), no
-- case-insensitive repeats. Unicode is allowed — these are Bulgarian words.
CREATE FUNCTION club_tags_valid(items text[]) RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
  SELECT cardinality(items) <= 20
     AND NOT EXISTS (
       SELECT 1 FROM unnest(items) AS i
        WHERE i IS NULL OR i = '' OR btrim(i) <> i OR char_length(i) > 30 OR strpos(i, ',') > 0
     )
     AND cardinality(items) = (SELECT count(DISTINCT lower(i)) FROM unnest(items) AS i)
$$;--> statement-breakpoint
CREATE TABLE "club_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"phone" text,
	"is_minor" boolean DEFAULT false NOT NULL,
	"guardian_member_id" uuid,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"staff_note" text,
	"source" text DEFAULT 'staff' NOT NULL,
	"unsubscribe_token" text DEFAULT replace(gen_random_uuid()::text, '-', '') NOT NULL,
	"email_opt_out_at" timestamp with time zone,
	"card_token_hash" text,
	"erasure_requested_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_members_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_members_unsubscribe_token_unique" UNIQUE("unsubscribe_token"),
	CONSTRAINT "club_members_display_name_sane" CHECK (btrim("club_members"."display_name") <> '' AND char_length("club_members"."display_name") <= 120),
	CONSTRAINT "club_members_email_shape" CHECK ("club_members"."email" IS NULL OR ("club_members"."email" = lower("club_members"."email") AND char_length("club_members"."email") <= 254 AND "club_members"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
	CONSTRAINT "club_members_phone_shape" CHECK ("club_members"."phone" IS NULL OR "club_members"."phone" ~ '^\+?[0-9 ()-]{5,32}$'),
	CONSTRAINT "club_members_guardian_only_for_minors" CHECK ("club_members"."guardian_member_id" IS NULL OR "club_members"."is_minor"),
	CONSTRAINT "club_members_not_own_guardian" CHECK ("club_members"."guardian_member_id" IS NULL OR "club_members"."guardian_member_id" <> "club_members"."id"),
	CONSTRAINT "club_members_tags_valid" CHECK (club_tags_valid("club_members"."tags")),
	CONSTRAINT "club_members_staff_note_sane" CHECK ("club_members"."staff_note" IS NULL OR (btrim("club_members"."staff_note") <> '' AND char_length("club_members"."staff_note") <= 1000)),
	CONSTRAINT "club_members_source_known" CHECK ("club_members"."source" IN ('staff', 'import', 'self')),
	CONSTRAINT "club_members_unsubscribe_token_shape" CHECK ("club_members"."unsubscribe_token" ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "club_members_card_hash_shape" CHECK ("club_members"."card_token_hash" IS NULL OR "club_members"."card_token_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "club_member_links" (
	"member_id" uuid PRIMARY KEY NOT NULL,
	"club_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"status" text NOT NULL,
	"method" text NOT NULL,
	"passport_consent_at" timestamp with time zone,
	"notify_email" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_member_links_status_known" CHECK ("club_member_links"."status" IN ('pending', 'active', 'declined')),
	CONSTRAINT "club_member_links_method_known" CHECK ("club_member_links"."method" IN ('invite', 'claim', 'self')),
	CONSTRAINT "club_member_links_consent_needs_active" CHECK ("club_member_links"."passport_consent_at" IS NULL OR "club_member_links"."status" = 'active')
);
--> statement-breakpoint
CREATE TABLE "club_member_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "club_member_invites_token_unique" UNIQUE("token_hash"),
	CONSTRAINT "club_member_invites_token_shape" CHECK ("club_member_invites"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "club_member_invites_email_shape" CHECK ("club_member_invites"."email" = lower("club_member_invites"."email") AND char_length("club_member_invites"."email") <= 254 AND "club_member_invites"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	CONSTRAINT "club_member_invites_short_lived" CHECK ("club_member_invites"."expires_at" > "club_member_invites"."created_at" AND "club_member_invites"."expires_at" <= "club_member_invites"."created_at" + interval '14 days'),
	CONSTRAINT "club_member_invites_one_outcome" CHECK ("club_member_invites"."accepted_at" IS NULL OR "club_member_invites"."revoked_at" IS NULL)
);
--> statement-breakpoint
-- Search and filters on the members screen are per club; email backs the claim
-- match ("which unlinked records carry my verified address").
CREATE INDEX "club_members_club_name_idx" ON "club_members" USING btree ("club_id","display_name");--> statement-breakpoint
CREATE INDEX "club_members_email_idx" ON "club_members" USING btree ("email") WHERE "club_members"."email" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_members_guardian_idx" ON "club_members" USING btree ("club_id","guardian_member_id") WHERE "club_members"."guardian_member_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_members_tags_idx" ON "club_members" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "club_members_card_unique" ON "club_members" USING btree ("club_id","card_token_hash") WHERE "club_members"."card_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_members_erasure_requested_idx" ON "club_members" USING btree ("club_id") WHERE "club_members"."erasure_requested_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "club_member_links_one_per_user" ON "club_member_links" USING btree ("club_id","user_id") WHERE "club_member_links"."status" <> 'declined';--> statement-breakpoint
CREATE INDEX "club_member_links_user_idx" ON "club_member_links" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "club_member_links_pending_idx" ON "club_member_links" USING btree ("club_id") WHERE "club_member_links"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "club_member_invites_member_idx" ON "club_member_invites" USING btree ("club_id","member_id");--> statement-breakpoint
CREATE INDEX "club_member_invites_created_by_idx" ON "club_member_invites" USING btree ("created_by") WHERE "club_member_invites"."created_by" IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER "club_members_set_updated_at" BEFORE UPDATE ON "club_members" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER "club_member_links_set_updated_at" BEFORE UPDATE ON "club_member_links" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_guardian_fk" FOREIGN KEY ("club_id","guardian_member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE set null ("guardian_member_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_member_links" ADD CONSTRAINT "club_member_links_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_member_invites" ADD CONSTRAINT "club_member_invites_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
COMMENT ON TABLE "club_members" IS 'A club''s client records; the club is controller. No date of birth (is_minor only); a child hangs under a guardian record. Status is derived (club_member_status, 0043). Survives the POPS account''s erasure — only club_member_links goes. Not on the open-data ALLOWED_RELATIONS.';--> statement-breakpoint
COMMENT ON COLUMN "club_members"."email" IS 'Lowercase, NOT unique (households share an inbox). Backs the claim match against a POPS account''s VERIFIED address.';--> statement-breakpoint
COMMENT ON COLUMN "club_members"."card_token_hash" IS 'SHA-256 of a printed member card key (skbc_…), CHECK-pinned to 64 hex characters so the column cannot hold the key itself — the api_keys.key_hash rule (0015).';--> statement-breakpoint
COMMENT ON COLUMN "club_members"."unsubscribe_token" IS 'Random, per record: the one-click opt-out link in transactional mail to an UNLINKED client (/klubove/otpisvane/<token>). Not a credential for anything else.';--> statement-breakpoint
COMMENT ON TABLE "club_member_links" IS 'The only reference from a club''s client record to a POPS account (users CASCADE): erasing the account removes this row and nothing the club owns. passport_consent_at is the member''s consent for QR-verified club attendance to reach their own training log; it dies with the link.';--> statement-breakpoint
COMMENT ON TABLE "club_member_invites" IS 'A club inviting a client record''s address to link a POPS account. Token stored as a SHA-256 only; ≤14 days; accepted only by a signed-in user whose verified address equals email.';--> statement-breakpoint
ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "club_staff_erased" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "club_member_links_erased" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
          AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
          AND "account_deletions"."moderation_decisions_preserved" >= 0 AND "account_deletions"."sessions_cancelled" >= 0
          AND "account_deletions"."rsvps_erased" >= 0 AND "account_deletions"."checkins_erased" >= 0
          AND "account_deletions"."digest_subscriptions_erased" >= 0 AND "account_deletions"."results_anonymized" >= 0
          AND "account_deletions"."badges_erased" >= 0 AND "account_deletions"."campaign_results_anonymized" >= 0
          AND "account_deletions"."session_notifications_erased" >= 0
          AND "account_deletions"."club_staff_erased" >= 0 AND "account_deletions"."club_member_links_erased" >= 0);--> statement-breakpoint
COMMENT ON COLUMN "account_deletions"."club_staff_erased" IS 'club_staff grants removed with the account (users CASCADE). The clubs themselves are untouched; a club left without an owner shows on /admin/klubove.';--> statement-breakpoint
COMMENT ON COLUMN "account_deletions"."club_member_links_erased" IS 'club_member_links removed with the account. The clubs'' client records, bookings, check-ins and payment records are the clubs'' (controllers'') data and stay.';--> statement-breakpoint
ALTER TABLE "club_member_links" ADD CONSTRAINT "club_member_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_member_invites" ADD CONSTRAINT "club_member_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
