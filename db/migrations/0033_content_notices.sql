-- Notice-and-action and statements of reasons — the legal half of moderation
-- the queue never had (DSA Arts. 16 and 17; pre-launch audit 2026-09).
--
-- WHY THIS EXISTS. POPS hosts content its users write: facility names, photos,
-- display names and home cities on public boards. A hosting service owes two
-- things for that regardless of its size, and the schema could express
-- neither:
--
--   * a way for ANYONE to tell us that something here is illegal or breaks the
--     rules (Art. 16). The only intake was the anonymous facility report, whose
--     five issue tags describe broken equipment, which exists only on facility
--     pages and which has no field for a reply address — so nobody could report
--     a photo, a name or a passport, and nobody who did report could be answered;
--   * a reasoned notice to the member whose content we restrict (Art. 17).
--     `moderation_decisions` recorded THAT a photo was rejected or a facility
--     removed, never WHY, and nothing told the uploader either way.
--
-- THREE CHANGES, all additive:
--
--   1. `content_notices` — one row per notice from the public form (/signal).
--      The notifier's name and address are OPTIONAL (a notice about a crime or
--      about one's own photo must not require identifying oneself) and are the
--      only personal data the row holds by design. They exist so we can confirm
--      receipt and report the decision (Art. 16(4)-(5)), and they are erased by
--      the worker's nightly cleanup 180 days after the decision — the one
--      mutation a decided row still accepts (see the guard trigger below).
--      `good_faith` is CHECK-pinned to true: the statement of good faith is part
--      of what makes a notice a notice (Art. 16(2)(d)), so a row without it is
--      unrepresentable rather than merely unexpected.
--
--   2. `moderation_decisions.reason` — a slug from the closed vocabulary in
--      lib/src/moderation (labels live in messages/*.json, never here). This
--      build gives every REFUSAL one — a rejected photo, a published photo
--      taken down (0032's 'removed'), a facility marked gone — and takes no
--      refusal without it (apps/web/lib/moderation.ts). Approvals and report
--      triage need none, and the ~all-NULL history stays exactly as it was.
--      Only the slug's SHAPE is CHECKed here: the rule that a refusal must
--      carry one is the contract step below, deliberately not in this file.
--
--   3. `moderation_notifications` — the worker's idempotency ledger for the
--      mail those two produce (statement of reasons, notice receipt, notice
--      outcome). It is the "notified_at" the audit asked for, as a separate
--      table because `moderation_decisions` is append-only and cannot be
--      stamped afterwards. Like `play_session_notifications` (0013) it records
--      THAT a message went, never to whom: no address, no account id. The
--      address is resolved from the live tables at send time, so an erased
--      account simply resolves to nobody.
--
-- NO FOREIGN KEY on `decided_by`, deliberately, exactly like
-- `moderation_decisions.actor_id` (0007): the record of who decided a notice
-- must survive that admin erasing their own account, after which the id
-- resolves to the "former user" label.
--
-- WHY NOT LOG NOTICE DECISIONS IN `moderation_decisions`. That log is scoped to
-- a facility (`facility_id NOT NULL`) and to a municipality, because an
-- ambassador's authority is a municipality. A notice can concern a passport or
-- a session that belongs to no facility, and deciding it is the controller's
-- act, not a volunteer's — the web app gives it to `requireRole('admin')` only.
-- Widening the log would have meant a new target type in its allowlist CHECK
-- and relaxing a NOT NULL the SLA report relies on. So the notice row IS its
-- own decision record, and the guard trigger gives it the same property the
-- log has: once decided, frozen.
--
-- EXPAND NOW, CONTRACT LATER — why "a refusal must have a reason" is not a
-- CHECK in this file. Everything here is invisible to the PREVIOUS build: it
-- never names the new tables, and `reason` is nullable with nothing requiring
-- it. That build still runs against this schema twice over: deploy.yml runs
-- `migrate` and only then `up -d`, so it serves for the 30-60 s in between;
-- and the recovery the operator reaches for first, the `rollback_to`
-- dispatch, redeploys old images over a schema that stays at 0033
-- (forward-only). The old build logs every photo rejection, takedown and
-- facility-gone WITHOUT a reason. A CHECK demanding one would refuse each of
-- those with 23514 and abort the decision's transaction — and a reported
-- photo, one showing an identifiable child say, would STAY UP until somebody
-- wrote SQL. So until the database backstop ships, the application is the only
-- gate (apps/web/tests/moderation.test.ts), and db/src/content-notices.test.ts
-- proves the old build's reasonless INSERT still lands.
--
-- THE CONTRACT STEP is its own later migration, once this build is live and
-- nobody intends to roll back past it:
--   ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_refusal_has_reason"
--     CHECK ("decision"::text NOT IN ('rejected', 'removed', 'gone') OR "reason" IS NOT NULL) NOT VALID;
-- NOT VALID, and never validated: refusals the old build logged — between
-- 0032's deploy and this one, and in the migrate → up window — carry no
-- reason, and the append-only log keeps them exactly as written. Compared as
-- text like 0032's decision_matches_target, so the CHECK never coerces a
-- literal through the enum. The same migration turns the "reasonless INSERT"
-- test in db/src/content-notices.test.ts back into a refusal test.
--
-- LOCKING. Everything but (2) is new. The ADD COLUMN in (2) is catalogue-only
-- (nullable, no default — no rewrite), and its format CHECK is added NOT VALID
-- for the reason 0029 spells out: a VALIDATE inside the migrator's single
-- transaction would scan the table under the ACCESS EXCLUSIVE the ADD COLUMN
-- already holds, and there is nothing to find — every existing row has a NULL
-- reason, which satisfies it. NOT VALID constraints are enforced on every
-- INSERT from the moment they exist. The append-only triggers on
-- moderation_decisions are row-level BEFORE UPDATE/DELETE triggers and do not
-- fire for DDL. lock_timeout makes the whole file fail fast rather than queue
-- behind the nightly backup's ACCESS SHARE.
--
-- rollback. ROLLING THE APPLICATION BACK NEEDS NO SQL. The previous build
-- ignores both new tables and the new column (see EXPAND NOW above), so the
-- `rollback_to` dispatch alone restores it — rejections, takedowns and
-- facility-gone all work — and the notices and the statements of reasons given
-- since this deploy stay where they are for when it rolls forward again.
-- Leave the schema as it is.
--
-- ONLY IF THE FEATURE IS ABANDONED for good (compensating SQL, reverse order;
-- DESTRUCTIVE). Roll the application back FIRST: this build writes `reason`,
-- /signal inserts notices and the worker claims the ledger, so dropping these
-- under it fails each of those paths. `content_notices` is the record of every
-- Art. 16 notice received and `reason` the record of every statement of
-- reasons sent — legally relevant history, so archive both before the drops.
-- The notice archive still holds notifier contacts: the 180-day erasure that
-- /privacy promises then has to be done on it by hand.
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   CREATE TABLE "archive_0033_decision_reasons" AS
--     SELECT id, reason FROM moderation_decisions WHERE reason IS NOT NULL;
--   CREATE TABLE "archive_0033_content_notices" AS SELECT * FROM content_notices;
--   DROP TABLE "moderation_notifications";
--   DROP TYPE "moderation_notification_kind";
--   ALTER TABLE "moderation_decisions" DROP CONSTRAINT "moderation_decisions_reason_format";
--   ALTER TABLE "moderation_decisions" DROP COLUMN "reason";
--   DROP TRIGGER "content_notices_guard_truncate" ON "content_notices";
--   DROP TRIGGER "content_notices_guard_row" ON "content_notices";
--   DROP FUNCTION guard_content_notice();
--   DROP TABLE "content_notices";
--   DROP TYPE "content_notice_status";
--   DROP TYPE "content_notice_category";
--   COMMIT;

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
CREATE TYPE "public"."content_notice_category" AS ENUM('illegal', 'personal_data', 'rights', 'abuse', 'spam', 'other');--> statement-breakpoint
CREATE TYPE "public"."content_notice_status" AS ENUM('pending', 'actioned', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."moderation_notification_kind" AS ENUM('decision', 'notice_received', 'notice_decided');--> statement-breakpoint
CREATE TABLE "content_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_url" text NOT NULL,
	"category" "content_notice_category" NOT NULL,
	"explanation" text NOT NULL,
	"notifier_name" text,
	"notifier_email" text,
	"good_faith" boolean NOT NULL,
	"status" "content_notice_status" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- An absolute http(s) URL or a path on this site, and nothing the admin
	-- queue could be tricked into rendering as a link somewhere else: no
	-- `javascript:`, no protocol-relative `//host`, no backslash anywhere (a
	-- browser reads `/\host` as `//host`), and no `://` inside a site path — no
	-- POPS path contains one, and an embedded URL is how a "path" smuggles in
	-- somebody else's host. chr(92) is the backslash, spelled so that no layer
	-- of string escaping can change what it means. apps/web/lib/notice-input.ts
	-- repeats every rule.
	CONSTRAINT "content_notices_target_url_shape" CHECK (char_length("content_notices"."target_url") BETWEEN 1 AND 500 AND "content_notices"."target_url" !~ '[[:space:][:cntrl:]]' AND position(chr(92) in "content_notices"."target_url") = 0 AND ("content_notices"."target_url" ~* '^https?://' OR ("content_notices"."target_url" ~ '^/' AND "content_notices"."target_url" !~ '^//' AND position('://' in "content_notices"."target_url") = 0))),
	CONSTRAINT "content_notices_explanation_len" CHECK (btrim("content_notices"."explanation") <> '' AND char_length("content_notices"."explanation") <= 2000),
	CONSTRAINT "content_notices_notifier_name_len" CHECK ("content_notices"."notifier_name" IS NULL OR (btrim("content_notices"."notifier_name") <> '' AND char_length("content_notices"."notifier_name") <= 120)),
	CONSTRAINT "content_notices_notifier_email_shape" CHECK ("content_notices"."notifier_email" IS NULL OR (char_length("content_notices"."notifier_email") <= 254 AND "content_notices"."notifier_email" ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
	CONSTRAINT "content_notices_good_faith" CHECK ("content_notices"."good_faith"),
	-- A decision is all three facts or none of them: who, when and why.
	CONSTRAINT "content_notices_decision_complete" CHECK ((("content_notices"."status" = 'pending') = ("content_notices"."decided_at" IS NULL)) AND (("content_notices"."status" = 'pending') = ("content_notices"."decided_by" IS NULL)) AND (("content_notices"."status" = 'pending') = ("content_notices"."decision_reason" IS NULL))),
	CONSTRAINT "content_notices_decided_by_not_blank" CHECK ("content_notices"."decided_by" IS NULL OR btrim("content_notices"."decided_by") <> ''),
	CONSTRAINT "content_notices_reason_format" CHECK ("content_notices"."decision_reason" IS NULL OR "content_notices"."decision_reason" ~ '^[a-z][a-z0-9_]{2,39}$'),
	CONSTRAINT "content_notices_order" CHECK ("content_notices"."decided_at" IS NULL OR "content_notices"."decided_at" >= "content_notices"."created_at")
);
--> statement-breakpoint
-- The admin queue's only read: oldest pending first.
CREATE INDEX "content_notices_pending_created_idx" ON "content_notices" USING btree ("created_at") WHERE "content_notices"."status" = 'pending';--> statement-breakpoint
-- A decided notice is the record of that decision: its content, its outcome
-- and its reason never change again, and the row is never deleted. The single
-- exception is the notifier's contact, which may be ERASED (set to NULL, never
-- rewritten) — that is the retention promise on /privacy, carried out nightly
-- by the worker. Content columns are frozen from the moment the notice arrives,
-- pending or not: what was reported is evidence. search_path is pinned so the
-- function cannot be influenced by the calling session.
--
-- Pruning whole notices, if that is ever decided, is a deliberate act: it needs
-- ALTER TABLE content_notices DISABLE TRIGGER content_notices_guard_row inside
-- the same transaction — the same friction 0028 puts on its log.
CREATE FUNCTION guard_content_notice() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'content_notices rows are the record of a notice and are never deleted';
  END IF;
  IF (NEW.id, NEW.target_url, NEW.category, NEW.explanation, NEW.good_faith, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.target_url, OLD.category, OLD.explanation, OLD.good_faith, OLD.created_at) THEN
    RAISE EXCEPTION 'content_notices: what was reported cannot be edited';
  END IF;
  IF (NEW.notifier_name IS NOT NULL AND NEW.notifier_name IS DISTINCT FROM OLD.notifier_name)
     OR (NEW.notifier_email IS NOT NULL AND NEW.notifier_email IS DISTINCT FROM OLD.notifier_email) THEN
    RAISE EXCEPTION 'content_notices: the notifier contact may only be erased';
  END IF;
  IF OLD.status <> 'pending'
     AND (NEW.status, NEW.decided_at, NEW.decided_by, NEW.decision_reason)
         IS DISTINCT FROM (OLD.status, OLD.decided_at, OLD.decided_by, OLD.decision_reason) THEN
    RAISE EXCEPTION 'content_notices: a decided notice is final';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "content_notices_guard_row"
BEFORE UPDATE OR DELETE ON "content_notices"
FOR EACH ROW EXECUTE FUNCTION guard_content_notice();--> statement-breakpoint
CREATE TRIGGER "content_notices_guard_truncate"
BEFORE TRUNCATE ON "content_notices"
FOR EACH STATEMENT EXECUTE FUNCTION guard_content_notice();--> statement-breakpoint
COMMENT ON COLUMN "content_notices"."notifier_email" IS
  'Optional reply address given by the notifier. Used only to confirm receipt and report the decision; erased 180 days after the decision (worker auth.cleanup).';--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_reason_format"
  CHECK ("reason" IS NULL OR "reason" ~ '^[a-z][a-z0-9_]{2,39}$') NOT VALID;--> statement-breakpoint
COMMENT ON COLUMN "moderation_decisions"."reason" IS
  'Why, as a slug from lib/src/moderation (labels in messages/*.json). Given on every rejected/removed/gone by the application from 0033 on (the CHECK is a later migration); NULL on older rows and on approvals.';--> statement-breakpoint
CREATE TABLE "moderation_notifications" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "moderation_notifications_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" "moderation_notification_kind" NOT NULL,
	"decision_id" bigint,
	"notice_id" uuid,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- A decision mail names a decision and nothing else; a notice mail names a
	-- notice and nothing else.
	CONSTRAINT "moderation_notifications_subject" CHECK ((("moderation_notifications"."kind" = 'decision') = ("moderation_notifications"."decision_id" IS NOT NULL)) AND (("moderation_notifications"."kind" = 'decision') = ("moderation_notifications"."notice_id" IS NULL)))
);
--> statement-breakpoint
-- RESTRICT is moot in practice (the log refuses every DELETE) and honest in
-- principle: a ledger entry about a decision cannot outlive it.
ALTER TABLE "moderation_notifications" ADD CONSTRAINT "moderation_notifications_decision_id_moderation_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."moderation_decisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_notifications" ADD CONSTRAINT "moderation_notifications_notice_id_content_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."content_notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- THE UNIQUE INDEXES ARE THE GUARANTEE: the worker claims a row before it
-- sends, in the same transaction, so a retried job cannot mail anyone twice.
CREATE UNIQUE INDEX "moderation_notifications_decision_unique" ON "moderation_notifications" USING btree ("decision_id") WHERE "moderation_notifications"."decision_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "moderation_notifications_notice_unique" ON "moderation_notifications" USING btree ("notice_id","kind") WHERE "moderation_notifications"."notice_id" IS NOT NULL;--> statement-breakpoint
-- The migrator runs the whole pending batch in ONE transaction, so a
-- SET LOCAL leaks into the next migration file; reset like 0020..0030 do.
SET LOCAL lock_timeout = DEFAULT;
