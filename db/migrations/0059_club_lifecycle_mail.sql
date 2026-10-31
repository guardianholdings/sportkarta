-- 0059_club_lifecycle_mail: «Клубове» — the club's OWN standing, told to its
-- owners (audit 2026-10-30, product finding 1 and 2). Hand-written; do not
-- regenerate.
--
-- WHAT THIS ADDS
--
-- Five kinds in the send ledger (club_notifications.kind), nothing else:
--
--   club_trial_ending      a paying tier's trial ends in 7 days / tomorrow
--   club_past_due          coverage ran out; the grace (14 days) has begun
--   club_lapsed            the grace is over: read-only, public page hidden
--   club_suspended         the association suspended the club
--   application_rejected   an application was turned down
--
-- Until now a club learned all of this ONLY from a banner in its office, and
-- a rejected applicant from nothing at all: the club dropped out of their
-- «Моите клубове» and the mail they had been promised never came. The
-- worker's daily club.expiry run (09:20 Sofia) now mails each owner once per
-- milestone — the ledger's dedupe key carries the milestone's date, so a club
-- that pays and lapses again a year later is told again — and the admin's
-- «Отхвърли» enqueues the rejection mail like «Одобри» enqueues the approval.
--
-- Locking: the CHECK swap takes ACCESS EXCLUSIVE on club_notifications
-- (DROP CONSTRAINT holds it until COMMIT, so NOT VALID + VALIDATE is the
-- repo's pattern rather than a concurrency gain here) and scans it. The
-- table is small in any club's first year; the scan is milliseconds. In the
-- batch that first deploys this branch (0045–0059 in one transaction)
-- club_notifications is already held since 0051, and nothing new is
-- acquired.
--
-- rollback: the new kinds are only ever written by the application, so
-- revert the application first; then, in ONE transaction, delete the rows of
-- the five kinds (losing their dedupe state — the next run would re-send
-- those mails; a surviving row would fail the re-created CHECK) and
-- re-create the constraint with 0053's list:
--   DELETE FROM "club_notifications" WHERE "kind" IN ('application_rejected',
--     'club_trial_ending', 'club_past_due', 'club_lapsed', 'club_suspended');
--   ALTER TABLE "club_notifications" DROP CONSTRAINT "club_notifications_kind_known";
--   ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_kind_known"
--     CHECK (kind IN (<the 0053 list, lines 621–632>));
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
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
	    'club_trial_ending', 'club_past_due', 'club_lapsed', 'club_suspended')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_notifications" VALIDATE CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
COMMENT ON CONSTRAINT "club_notifications_kind_known" ON "club_notifications" IS
  'The closed list of notices; the TypeScript twin is CLUB_NOTIFICATION_KINDS in lib/src/clubs/vocab.ts (0059 added the club''s own standing and the rejected application).';
