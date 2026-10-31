-- 0061_club_contracts: «Клубове» — the club's contract with the association
-- (operator decision 2026-10-31). Hand-written; do not regenerate.
--
-- WHAT CHANGED
--
-- The clubs page promised «без обвързващ срок» and «прекратявате с едно
-- писмо, без предизвестие». That was never the offer: after the free trial
-- (which still binds nobody) a club signs a contract for at least 12 months,
-- invoiced monthly or yearly as the club chooses, that renews for another 12
-- months unless the club gives notice at least one month before the end of
-- the running term. The contract is signed offline; the operator records it
-- in /admin/klubove.
--
-- WHAT THIS ADDS
--
-- Three nullable columns on clubs, the facts the operator records:
--
--   contract_starts_on   the day the contract's first term begins
--   contract_billing     'monthly' | 'yearly' — the club's invoicing choice
--   contract_notice_on   the day the club's notice was received
--
-- and nothing derived: the day the club is bound until, the last day to give
-- notice and the day a noticed contract ends are computed from these two
-- dates by clubContractTerm (lib/src/clubs/contract.ts), like the access
-- state. The contract gates NOTHING — writes still follow paid_until — so no
-- existing row changes and no predicate reads these columns.
--
-- Three CHECKs keep the facts coherent: billing is one of the two choices; a
-- start and a billing choice are recorded together (a signed contract has
-- both); notice needs a contract to give notice on.
--
-- And one notice kind (club_notifications.kind), 'club_contract_renewing':
-- the worker's daily club.expiry run tells each owner, about a month before
-- the notice deadline, that the contract renews on its date unless they
-- write by the deadline. Its dedupe key carries the renewal day, so each
-- renewal is announced once.
--
-- Locking: ADD COLUMN with no default is catalogue-only (no rewrite) but
-- takes ACCESS EXCLUSIVE on clubs until COMMIT; the three CHECKs are added
-- NOT VALID and validated in place — the columns are NULL on every row, so
-- validation is a trivial scan of a table that holds one row per club. The
-- kind CHECK swap takes ACCESS EXCLUSIVE on club_notifications and scans it
-- (0059's pattern). In the batch that first deploys this branch (0045–0061
-- in one transaction) both tables are already held by earlier files and
-- nothing new is acquired.
--
-- rollback: the new columns and kind are only ever written by the
-- application, so revert the web app AND the worker in the same deploy first
-- (the worker's clubLifecycleCandidates reads the new columns for EVERY
-- lifecycle mail: with the columns gone and the worker not reverted, each
-- daily club.expiry run fails, and the trial, past-due, lapsed and suspended
-- mails stop with it). Then, in ONE transaction, delete the rows of the new
-- kind (losing their dedupe state), re-create the kind CHECK with 0059's list
-- and its comment, and drop the columns (their CHECKs go with them):
--   DELETE FROM "club_notifications" WHERE "kind" = 'club_contract_renewing';
--   ALTER TABLE "club_notifications" DROP CONSTRAINT "club_notifications_kind_known";
--   ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_kind_known"
--     CHECK (kind IN (<the 0059 list, lines 45–56>));
--   COMMENT ON CONSTRAINT "club_notifications_kind_known" ON "club_notifications"
--     IS <0059's comment, lines 58–59>;
--   ALTER TABLE "clubs" DROP COLUMN "contract_notice_on",
--     DROP COLUMN "contract_billing", DROP COLUMN "contract_starts_on";
-- Dropping the columns loses the recorded contracts; keep a copy first.
-- A corrective migration needs a journal `when` above 1785217200000.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "contract_starts_on" date,
	ADD COLUMN "contract_billing" text,
	ADD COLUMN "contract_notice_on" date;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_contract_billing_known" CHECK ("clubs"."contract_billing" IN ('monthly', 'yearly')) NOT VALID;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_contract_complete" CHECK (("clubs"."contract_starts_on" IS NULL) = ("clubs"."contract_billing" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_contract_notice_needs_contract" CHECK ("clubs"."contract_notice_on" IS NULL OR "clubs"."contract_starts_on" IS NOT NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "clubs" VALIDATE CONSTRAINT "clubs_contract_billing_known";--> statement-breakpoint
ALTER TABLE "clubs" VALIDATE CONSTRAINT "clubs_contract_complete";--> statement-breakpoint
ALTER TABLE "clubs" VALIDATE CONSTRAINT "clubs_contract_notice_needs_contract";--> statement-breakpoint
COMMENT ON COLUMN "clubs"."contract_starts_on" IS 'First day of the club''s contract with the association (operator decision 2026-10-31: after the free trial, at least 12 months, renewing yearly unless noticed a month before the term ends). Recorded by hand in /admin/klubove; the terms are derived by clubContractTerm (lib/src/clubs/contract.ts). Gates nothing — writes follow paid_until.';--> statement-breakpoint
COMMENT ON COLUMN "clubs"."contract_billing" IS 'The club''s invoicing choice under its contract: monthly or yearly. Set together with contract_starts_on (clubs_contract_complete).';--> statement-breakpoint
COMMENT ON COLUMN "clubs"."contract_notice_on" IS 'The day the club''s notice was received. The contract then ends on the last day of the first term whose notice deadline is on or after this day (clubContractTerm).';--> statement-breakpoint
ALTER TABLE "club_notifications" DROP CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_kind_known" CHECK ("club_notifications"."kind" IN (
	    'member_invite', 'staff_invite',
	    'booking_confirmed', 'booking_promoted', 'booking_cancelled', 'class_cancelled', 'reminder_24h',
	    'membership_expiring', 'membership_expired',
	    'application_received', 'application_approved', 'application_rejected', 'operator_new_application',
	    'claim_pending', 'erasure_requested',
	    'roster_daily', 'owner_weekly',
	    'membership_renewed', 'fee_charged', 'owner_monthly',
	    'payment_received',
	    'broadcast', 'automation',
	    'inbox_message', 'inbox_reply', 'leads_due',
	    'event_registered', 'event_promoted', 'event_cancelled',
	    'club_trial_ending', 'club_past_due', 'club_lapsed', 'club_suspended',
	    'club_contract_renewing')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_notifications" VALIDATE CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
COMMENT ON CONSTRAINT "club_notifications_kind_known" ON "club_notifications" IS
  'The closed list of notices; the TypeScript twin is CLUB_NOTIFICATION_KINDS in lib/src/clubs/vocab.ts (0061 added the contract''s renewal reminder).';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
