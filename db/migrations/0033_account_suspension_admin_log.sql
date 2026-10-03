-- Account suspension, and an append-only log of what admins CHANGE — the two
-- operator tools the pre-launch audit found missing (findings 52, 56, 63).
--
-- WHY THIS EXISTS. Sign-up is open (email OTP), and until now the operator had
-- no way to stop an account from the UI: no suspended state, no way to end its
-- sessions, no way to pull an offensive display name or public passport, and no
-- admin path to erasure. The only remedy for a member posting abuse was
-- hand-written SQL on the server. And the privilege changes that DO exist —
-- granting an ambassador, widening or narrowing their municipalities, switching
-- paid venues on nationally, hiding a business — were bare UPDATEs and DELETEs
-- that left no trace of who did them, so after an incident nobody could answer
-- "who changed this, and when" from the product.
--
-- TWO PARTS:
--
--   1. users.suspended_at + users.suspended_reason. A suspended account is read
--      as SIGNED OUT on its very next request: getCurrentUser()
--      (apps/web/lib/auth-session.ts) selects the row only WHERE suspended_at IS
--      NULL, so every gate behind it — requireUser, requireRole, every server
--      action — sees an anonymous visitor, cookie cache or not. The suspend
--      action also deletes the member's `sessions` rows in the same transaction.
--      THREE CHECKS make the state honest rather than conventional:
--        - users_suspension_pair: a suspension without a reason, or a reason
--          left behind after lifting one, is unrepresentable.
--        - users_suspended_reason_sane: the reason is short, non-blank text.
--        - users_suspended_is_private: A SUSPENDED ACCOUNT CANNOT HAVE A PUBLIC
--          PASSPORT. The suspend statement sets profile_visibility = 'private' in
--          the same UPDATE, and this constraint is what guarantees it: the
--          public surfaces all read `leaderboard_eligible_members`, which admits
--          only public passports, so an abusive name leaves every board the
--          moment the suspension commits. Lifting the suspension does NOT
--          re-publish anything — publishing is the member's own act (0010), so
--          they opt in again themselves.
--      The reason lives ON THE USERS ROW and nowhere else, deliberately: it is
--      free text an admin typed about a person, and the users row is exactly
--      what erasure deletes. It is cleared when the suspension is lifted.
--
--   2. admin_actions — who changed what, for every privilege or visibility
--      change an admin makes. Modelled on account_access_log (0028) and
--      moderation_decisions (0007), and sharing their three properties for the
--      same reasons:
--        a. APPEND-ONLY by trigger, search_path pinned. A log an admin can edit
--           is not a log.
--        b. NO FOREIGN KEYS on actor_id or subject_id. Both are users.id carried
--           by value, so erasing an account — including through this very log's
--           'account_erased' action — cannot take the record of what was done
--           to it with it. After erasure the id resolves to nothing, the same
--           "former user" state every other audit table relies on.
--        c. NARROW BY CONSTRUCTION. There is NO free-text column: no reason, no
--           note, no old display name. `detail` is a small jsonb object of
--           scalars (a municipality id, a count, a setting value) written by ONE
--           typed module (apps/web/lib/admin-actions.ts), and a CHECK caps its
--           size. A log that kept the display name it reset or the reason it
--           suspended for would become the one copy of that text that survives
--           the member's erasure — append-only rows cannot be scrubbed.
--      Reads of a member's data are NOT logged here: that is account_access_log
--      and its 'export' scope, which already exists. This table records changes.
--
--      `subject_id` is required for every action about an account and forbidden
--      for the two national switches (a setting, a business), written as an
--      allowlist of the SUBJECTLESS actions so that a future enum value is
--      required to name an account until somebody decides otherwise here.
--
-- WHAT IS DELIBERATELY NOT HERE: the facility editor's status changes. They are
-- already attributed, append-only and rendered on the facility's own history
-- (facility_edits carries the session's account id as `actor`, plus old and new
-- values). Copying them here would create a second, disagreeing record of the
-- same act.
--
-- Locking: the new type, table, indexes, function and triggers are all new and
-- contend with nothing. The one ALTER on `users` — a table every signed-in
-- request reads — adds two NULLable columns with no default (catalog-only, no
-- rewrite) and three CHECKs whose validation scan passes trivially because both
-- columns are NULL everywhere. It is a single ALTER statement so the table is
-- locked and scanned once, and it is placed LAST in this file, with the
-- COMMENTs (the 0007/0020 house rule). That keeps the lock short only within
-- the file: the migrator runs the whole pending batch in ONE transaction, on
-- production as on a fresh database, so when 0033 ships with 0034 and 0035
-- the ACCESS EXCLUSIVE lock on `users` is held until the batch commits — every
-- signed-in request waits for that, normally tens of milliseconds, at worst a
-- few seconds (each later lock wait is bounded by its own lock_timeout).
-- Acceptable pre-launch; a change that must hold `users` only briefly has to
-- ship alone or last. lock_timeout bounds the wait behind an in-flight reader;
-- SET LOCAL, reset at the end, so it does not leak into the next file.
--
-- Rolling back only the APPLICATION (deploy.yml `rollback_to`) silently lifts
-- every active suspension: the older build's getCurrentUser never reads
-- suspended_at, so a suspended member simply signs in again (only
-- users_suspended_is_private still holds). Before an app-only rollback, check
--   SELECT count(*) FROM users WHERE suspended_at IS NOT NULL;
--
-- rollback (compensating SQL, reverse order; revert the application first —
-- getCurrentUser selects suspended_at, and would fail on every request):
--   ALTER TABLE "users"
--     DROP CONSTRAINT "users_suspended_is_private",
--     DROP CONSTRAINT "users_suspended_reason_sane",
--     DROP CONSTRAINT "users_suspension_pair",
--     DROP COLUMN "suspended_reason",   -- DESTRUCTIVE: every reason is lost
--     DROP COLUMN "suspended_at";       -- DESTRUCTIVE: every suspension is LIFTED
--   DROP TRIGGER "admin_actions_no_truncate" ON "admin_actions";
--   DROP TRIGGER "admin_actions_no_delete" ON "admin_actions";
--   DROP TRIGGER "admin_actions_no_update" ON "admin_actions";
--   DROP FUNCTION forbid_admin_actions_mutation();
--   DROP TABLE "admin_actions";         -- DESTRUCTIVE: the accountability log.
--       DELETE cannot remove rows (the triggers refuse it), so only DROP TABLE
--       will, and recovery is a restore from the nightly backup.
--   DROP TYPE "admin_action";

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE TYPE "public"."admin_action" AS ENUM('account_suspended', 'account_unsuspended', 'display_name_reset', 'passport_made_private', 'sessions_revoked', 'account_erased', 'ambassador_granted', 'ambassador_revoked', 'ambassador_scope_added', 'ambassador_scope_removed', 'setting_changed', 'business_visibility_changed');--> statement-breakpoint
CREATE TABLE "admin_actions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "admin_actions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_id" text NOT NULL,
	"action" "admin_action" NOT NULL,
	"subject_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_actions_actor_not_blank" CHECK (btrim("admin_actions"."actor_id") <> ''),
	CONSTRAINT "admin_actions_subject_not_blank" CHECK ("admin_actions"."subject_id" IS NULL OR btrim("admin_actions"."subject_id") <> ''),
	CONSTRAINT "admin_actions_subject_matches_action" CHECK (("admin_actions"."subject_id" IS NULL) = ("admin_actions"."action" IN ('setting_changed', 'business_visibility_changed'))),
	CONSTRAINT "admin_actions_detail_object" CHECK (jsonb_typeof("admin_actions"."detail") = 'object'),
	CONSTRAINT "admin_actions_detail_small" CHECK (octet_length("admin_actions"."detail"::text) <= 512),
	CONSTRAINT "admin_actions_acted_at_finite" CHECK (isfinite("admin_actions"."acted_at"))
);
--> statement-breakpoint
-- "what has been done to this account" — the account screen's panel. Partial:
-- the national switches carry no subject and are never looked up this way.
CREATE INDEX "admin_actions_subject_acted_idx" ON "admin_actions" USING btree ("subject_id","acted_at" DESC NULLS LAST) WHERE "admin_actions"."subject_id" IS NOT NULL;--> statement-breakpoint
-- "recent ambassador grants" / "recent paid-venue switches" — the panels on
-- /admin/ambasadori and /admin/chastni filter by a set of actions.
CREATE INDEX "admin_actions_action_acted_idx" ON "admin_actions" USING btree ("action","acted_at" DESC NULLS LAST);--> statement-breakpoint
-- "what has this admin been doing" — the supervision question.
CREATE INDEX "admin_actions_actor_acted_idx" ON "admin_actions" USING btree ("actor_id","acted_at" DESC NULLS LAST);--> statement-breakpoint
-- Append-only enforcement, mirroring account_access_log (0028).
CREATE FUNCTION forbid_admin_actions_mutation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'admin_actions is append-only (accountability log)';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "admin_actions_no_update"
BEFORE UPDATE ON "admin_actions"
FOR EACH ROW EXECUTE FUNCTION forbid_admin_actions_mutation();--> statement-breakpoint
CREATE TRIGGER "admin_actions_no_delete"
BEFORE DELETE ON "admin_actions"
FOR EACH ROW EXECUTE FUNCTION forbid_admin_actions_mutation();--> statement-breakpoint
CREATE TRIGGER "admin_actions_no_truncate"
BEFORE TRUNCATE ON "admin_actions"
FOR EACH STATEMENT EXECUTE FUNCTION forbid_admin_actions_mutation();--> statement-breakpoint
COMMENT ON TABLE "admin_actions" IS 'Who changed what: every privilege or visibility change an admin makes (suspension, name reset, forced-private passport, session revocation, erasure, ambassador grants and scope, the paid-venue switch, business visibility). Append-only by trigger; actor_id and subject_id carry no FK so erasure cannot delete the record of what was done. No free text by design — the suspension reason lives on users and leaves with the account. Written only by apps/web/lib/admin-actions.ts. Reads of member data are logged in account_access_log instead.';--> statement-breakpoint
ALTER TABLE "users"
	ADD COLUMN "suspended_at" timestamp with time zone,
	ADD COLUMN "suspended_reason" text,
	ADD CONSTRAINT "users_suspension_pair" CHECK (("users"."suspended_at" IS NULL) = ("users"."suspended_reason" IS NULL)),
	ADD CONSTRAINT "users_suspended_reason_sane" CHECK ("users"."suspended_reason" IS NULL OR (btrim("users"."suspended_reason") <> '' AND char_length("users"."suspended_reason") <= 300)),
	ADD CONSTRAINT "users_suspended_is_private" CHECK ("users"."suspended_at" IS NULL OR "users"."profile_visibility" = 'private');--> statement-breakpoint
COMMENT ON COLUMN "users"."suspended_at" IS 'When an admin suspended this account; NULL = not suspended. getCurrentUser() treats a suspended account as signed out on its next request. users_suspended_is_private forbids a public passport while set.';--> statement-breakpoint
COMMENT ON COLUMN "users"."suspended_reason" IS 'Why, in the admin''s words. Kept ONLY here (never in admin_actions) so erasure removes it; cleared when the suspension is lifted.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;
