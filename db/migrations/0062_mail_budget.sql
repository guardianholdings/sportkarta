-- 0062_mail_budget: a durable daily mail budget with a reserve for sign-in
-- codes (launch-readiness audit 2026-10-31, finding B-05). Hand-written; do
-- not regenerate.
--
-- WHY
--
-- Every sign-in-code limiter in apps/web/lib/auth-rate-limit.ts is an
-- in-process sliding window: it forgets on every deploy and sees only its own
-- process. The production relay (Migadu Mini) allows 100 sends a DAY, shared
-- by sign-in codes, session and club notices and club bulk mail — so one
-- address flood, or one big broadcast, could spend the day's quota and stop
-- everyone's sign-in until midnight. The in-memory limiters stay as the first
-- line; this table is the second: a counter per civil Sofia day and per KIND
-- of mail that every sender increments atomically BEFORE it hands a message
-- to the relay, and that refuses once the kind's share is spent. Codes have
-- their own share, so no amount of notices or broadcasts can take it.
--
-- WHAT THIS ADDS
--
-- mail_budget (sofia_day, kind) → sent, refused
--
--   sofia_day   the civil day in Europe/Sofia the counts belong to — the
--               relay's quota is a calendar day; the writers compute it as
--               (now() AT TIME ZONE 'Europe/Sofia')::date, on the database
--               clock, so every process agrees which day it is
--   kind        otp | notice | bulk — the three shares. A fourth kind is a
--               CHECK swap in a NEW migration (DROP CONSTRAINT → ADD … NOT
--               VALID → VALIDATE, as 0059 does) plus the TypeScript twin,
--               MAIL_BUDGET_KINDS in lib/src/email/budget.ts — never an edit
--               of this file
--   sent        messages handed to the relay today, of this kind
--   refused     send attempts the budget turned away today (a sweep that
--               tries again every ten minutes counts each time)
--
-- The LIMITS are not stored: they come from MAIL_DAILY_QUOTA and the shares
-- (lib/src/email/budget.ts), so the operator raises the plan with an
-- environment variable and no migration. The increment is ONE statement —
-- INSERT … ON CONFLICT DO UPDATE SET sent = sent + 1 WHERE sent < limit
-- RETURNING — so two senders at the edge get exactly one slot between them:
-- the second waits on the row lock and re-evaluates the WHERE against the row
-- the first committed (db/src/mail-budget.test.ts proves it). A send the
-- relay then refuses gives its slot back.
--
-- Holds no personal data: a date and two counts. Rows older than 90 days are
-- pruned by the worker's nightly auth.cleanup.
--
-- Locking: CREATE TABLE touches nothing that exists. No backfill: the first
-- send of each day inserts its row.
--
-- rollback: revert the application first (every sender increments this table
-- and would fail without it), then: DROP TABLE "mail_budget";
-- A corrective migration needs a journal `when` above 1785224400000.
CREATE TABLE "mail_budget" (
	"sofia_day" date NOT NULL,
	"kind" text NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"refused" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "mail_budget_pkey" PRIMARY KEY("sofia_day","kind"),
	CONSTRAINT "mail_budget_kind_known" CHECK ("mail_budget"."kind" IN ('otp', 'notice', 'bulk')),
	CONSTRAINT "mail_budget_counts_nonnegative" CHECK ("mail_budget"."sent" >= 0 AND "mail_budget"."refused" >= 0)
);--> statement-breakpoint
COMMENT ON TABLE "mail_budget" IS
  'Messages handed to the mail relay per civil Sofia day and kind (otp | notice | bulk), and the attempts refused. The limits live in the environment (MAIL_DAILY_QUOTA and the shares; lib/src/email/budget.ts). Counts only — no personal data.';
