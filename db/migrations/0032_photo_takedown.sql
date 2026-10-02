-- 0032_photo_takedown: an APPROVED facility photo can be taken down again, and
-- the takedown is its own entry in the accountability log.
--
-- WHY. Until now the only statement that changed a photo's status was the
-- queue decision, and it matches `status = 'pending'` — so once a photo was
-- approved, nothing in the product could withdraw it. That was masked while
-- nothing served photos at all; now /api/photos/[id] serves every approved one
-- to anybody, and a photo approved by mistake, or one a parent reports because
-- their child is recognisable in it, needs a way off the site that does not
-- involve somebody writing SQL against production. That is a notice-and-action
-- and GDPR erasure obligation, not a nicety.
--
-- WHY A NEW DECISION VALUE, rather than logging the takedown as 'rejected':
--   1. It is a different fact. 'rejected' says the photo never went public;
--      'removed' says it WAS public and was withdrawn — exactly what a later
--      complaint, an audit or the operator's own review has to be able to find
--      without reconstructing it from the order of two rows.
--   2. It has no queue. queued_at exists so time-to-decision is a subtraction,
--      and a takedown has nothing to subtract: the application records it as
--      acted on the moment it was queued, and the SLA medians
--      (apps/web/lib/moderation-data.ts) leave 'removed' out — which they can
--      only do if the log can tell the two apart.
-- The PHOTO goes to status 'rejected'; photo_status is unchanged. From the
-- public's side a withdrawn photo and a refused one are the same thing — not
-- shown — and in both cases the stored file is deleted once the decision has
-- committed (apps/web/lib/moderation.ts).
--
-- THE ENUM TRAP, AND WHY THE CHECK COMPARES TEXT. `ALTER TYPE ... ADD VALUE`
-- runs inside the migrator's single transaction, and PostgreSQL refuses to USE
-- a label added in the same transaction as the statement using it ("unsafe use
-- of new value") — on production, where the type was created long ago. On CI
-- and `pnpm db:reset` the type is created in that same transaction, which
-- PostgreSQL permits, so the failure is green everywhere except production
-- (0013's header, corrected in 0014). The CHECK below has to name 'removed'.
-- Written as `decision IN (..., 'removed')`, that literal is coerced to
-- moderation_decision — enum_in — which IS a use. Written as
-- `decision::text IN (...)`, the literal stays text and each existing row is
-- only converted OUT of the enum (enum_out), which is not a use. So this ships
-- in ONE deploy. Checked against PostgreSQL 16: the enum-typed spelling aborts
-- this file when the type predates the transaction, the text spelling does not.
-- The first row carrying 'removed' is written at runtime, in a later
-- transaction.
--
-- The constraint is still an ALLOWLIST per target. Nothing is loosened for
-- reports or facilities; 'removed' is legal for photos only.
--
-- LOCKING. DROP + ADD CONSTRAINT takes ACCESS EXCLUSIVE on moderation_decisions,
-- and the ADD validates by scanning it. That table holds one row per human
-- decision (hundreds, not millions) and is read only by admin screens, so the
-- scan is short; NOT VALID + VALIDATE would buy nothing inside the migrator's
-- single transaction (see 0029). lock_timeout makes the deploy fail fast rather
-- than queue behind the nightly dump's ACCESS SHARE.
--
-- rollback (compensating SQL). ROLL THE APPLICATION BACK FIRST: the current
-- build writes 'removed' on every takedown, and the old constraint refuses it
-- with 23514 — the takedown transaction aborts and the photo STAYS UP.
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   -- PRECONDITION: SELECT count(*) FROM moderation_decisions
--   --                WHERE decision::text = 'removed';   must be 0.
--   -- The log is append-only (0007's triggers), so rows that exist cannot be
--   -- deleted, and the old constraint cannot be re-added over them. If any
--   -- takedown has happened, STOP HERE and keep this constraint: those rows are
--   -- true history, and rewriting the log to make a rollback fit is exactly
--   -- what the triggers exist to prevent.
--   ALTER TABLE "moderation_decisions" DROP CONSTRAINT "moderation_decisions_decision_matches_target";
--   ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_decision_matches_target"
--     CHECK (("target_type" = 'photo' AND "decision" IN ('approved', 'rejected'))
--         OR ("target_type" = 'report' AND "decision" IN ('reviewed', 'dismissed'))
--         OR ("target_type" = 'facility' AND "decision" IN ('verified', 'gone')));
--   COMMENT ON TYPE "public"."moderation_decision" IS NULL;
--   COMMIT;
--   -- The enum value CANNOT be removed: PostgreSQL has no DROP VALUE. That is
--   -- why the ADD VALUE below carries IF NOT EXISTS — re-applying after a
--   -- rollback would otherwise abort on a label that is already there.

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
-- AFTER 'rejected' so the label order matches db/schema/index.ts (a trailing
-- label would make the next drizzle-kit diff see a reordered enum).
ALTER TYPE "public"."moderation_decision" ADD VALUE IF NOT EXISTS 'removed' AFTER 'rejected';--> statement-breakpoint
ALTER TABLE "moderation_decisions" DROP CONSTRAINT "moderation_decisions_decision_matches_target";--> statement-breakpoint
ALTER TABLE "moderation_decisions" ADD CONSTRAINT "moderation_decisions_decision_matches_target"
  CHECK (("moderation_decisions"."target_type" = 'photo'
          AND "moderation_decisions"."decision"::text IN ('approved', 'rejected', 'removed'))
      OR ("moderation_decisions"."target_type" = 'report'
          AND "moderation_decisions"."decision"::text IN ('reviewed', 'dismissed'))
      OR ("moderation_decisions"."target_type" = 'facility'
          AND "moderation_decisions"."decision"::text IN ('verified', 'gone')));--> statement-breakpoint
COMMENT ON TYPE "public"."moderation_decision" IS
  'approved/rejected: a pending photo decided in the queue. removed: an APPROVED photo taken down afterwards (0032) — the photo row goes to rejected, and the decision stays distinguishable here. reviewed/dismissed: reports. verified/gone: facilities.';--> statement-breakpoint
-- The migrator runs the whole pending batch in ONE transaction, so a
-- SET LOCAL leaks into the next migration file; reset like 0029 does.
SET LOCAL lock_timeout = DEFAULT;
