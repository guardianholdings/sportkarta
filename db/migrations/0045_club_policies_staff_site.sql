-- 0045_club_policies_staff_site: «Клубове» v2, wave A (plan 2026-10-25 —
-- cover what vedro.one, 1club.ai and anolla.com sell, plus our own extras).
--
-- WHAT THIS ADDS
--
--   Membership policies (1club "membership policies"; anolla "recurring
--   subscriptions"):
--     club_plans.auto_renew / min_term_months / notice_days /
--     self_pause_allowed / self_cancel_allowed — the club's terms for a plan.
--     club_memberships.renews / renewal_of / term_started_on /
--     renewal_ends_on — a renewing abonnement is a CHAIN of memberships, each
--     a full snapshot (0041's rule: a sale is never rewritten). The
--     club.renewals job appends the successor and an open charge when a
--     period ends; renewal_of is UNIQUE, so a retried job cannot sell the next
--     period twice. A member's own «Прекратете» never shortens a paid period:
--     it sets renewal_ends_on to the later of (today + notice_days) and
--     (term_started_on + min_term_months), and the job stops renewing past it.
--     A trial can never renew (CHECK).
--
--   No-show and late-cancel policies (1club booking policies — and where
--   1club is thin): club_classes.no_show_fee_cents / late_cancel_fee_cents /
--   strike_limit / strike_days. A fee is an ordinary club_charges row of kind
--   'fee' pointing at the booking it is for; club_charges_one_fee_per_booking
--   makes the nightly job idempotent. Attendance is NEVER refused — a fee is
--   owed money, a strike only stops SELF-booking until it ages out, and the
--   desk can always book.
--
--   Staff (vedro and 1club "commissions", 1club "time off"):
--     club_staff.public_profile — the trainer's own opt-in to appear, with
--     name and bio, on the club's public page. No photos (CLAUDE.md: no
--     identifiable people in photos).
--     club_time_blocks — a trainer's leave. Wave C reuses the table for rooms
--     and courts (it will gain resource_id and make staff_user_id optional).
--     CASCADE from club_staff: a leave belongs to the grant. Its created_by
--     joins 0039's list of staff ids kept BY VALUE (rule 5).
--
--   The club page as a website (1club "branded website"): clubs.accent picks
--   one of the design system's three scales (never a hex value — CLAUDE.md),
--   and club_faq holds the club's questions and answers.
--
--   Contact consent (needed before any marketing message — Wave F):
--   club_members.marketing_email_at / marketing_sms_at / sms_opt_out_at.
--   Timestamps, not booleans: when the consent was given is what a regulator
--   asks for.
--
--   Vocabulary: club_audit_action_known and club_notifications_kind_known are
--   re-created with the new values (the twin lists in lib/src/clubs/vocab.ts;
--   lib/src/clubs/clubs.test.ts reads the LAST definition of each).
--
-- club_charges_guard is replaced so the one new column on a charge, booking_id,
-- may only be cleared (what deleting the booking with its member cascades) —
-- the same rule member_id and membership_id already follow.
--
-- Locking: club_staff is locked FIRST (ACCESS EXCLUSIVE). That is the order
-- 0039's header requires: account erasure (apps/web/lib/account-deletion.ts)
-- and staff removal touch club_staff before club_classes, club_audit and clubs,
-- so a deploy that took club_classes first could deadlock with an erasure
-- landing in the same milliseconds. ADD COLUMN with a constant default is
-- catalogue-only on PG 16, but it — like ADD/DROP CONSTRAINT — takes ACCESS
-- EXCLUSIVE on its table until the batch commits, so every VALIDATE below
-- scans under ACCESS EXCLUSIVE: in this one-transaction migrator the NOT VALID
-- split buys nothing. That is fine for these small tables; club_audit only
-- grows, and a future widening of its CHECK should be weighed with that in
-- mind. The two new tables are created empty.
-- Operator note: do not purge a club (/admin/klubove) while this deploy's
-- migrate step runs — purge locks clubs first (the admin_actions residual risk
-- 0039 already names).
--
-- rollback (ONE explicit transaction, after reverting the application). The
-- reverted application never reads the new columns, so the SAFE rollback is
-- to leave them: nothing below is needed for the old code to run. If they must
-- go anyway:
--   FIRST restore 0041's guard — CREATE OR REPLACE FUNCTION club_charges_guard()
--   with 0041's body (lines 249–280 of 0041); once booking_id is dropped the
--   0045 body fails every UPDATE/DELETE on club_charges ("record probe has no
--   field booking_id"), which would break voiding, erasure and purge.
--   DROP TABLE "club_faq", "club_time_blocks";               -- DESTRUCTIVE: the
--     club's FAQ and its trainers' leave
--   ALTER TABLE "club_charges" DROP COLUMN "booking_id";     -- DESTRUCTIVE: which
--     booking each fee was for
--   ALTER TABLE "club_memberships" DROP COLUMN "renews", DROP COLUMN "renewal_of",
--     DROP COLUMN "term_started_on", DROP COLUMN "renewal_ends_on";  -- DESTRUCTIVE:
--     renewal chains and the members' notice outcomes
--   ALTER TABLE "club_plans" DROP COLUMN "auto_renew", DROP COLUMN "min_term_months",
--     DROP COLUMN "notice_days", DROP COLUMN "self_pause_allowed", DROP COLUMN "self_cancel_allowed";
--   ALTER TABLE "club_classes" DROP COLUMN "no_show_fee_cents", DROP COLUMN "late_cancel_fee_cents",
--     DROP COLUMN "strike_limit", DROP COLUMN "strike_days";
--   ALTER TABLE "club_staff" DROP COLUMN "public_profile";
--   ALTER TABLE "clubs" DROP COLUMN "accent";
--   DO NOT drop club_members.marketing_email_at / marketing_sms_at /
--   sms_opt_out_at: they are consent and opt-out EVIDENCE, and re-adding them
--   later without the opt-outs could message people who said no.
--   Keep the widened club_audit_action_known: club_audit is append-only
--   (club_ledger_append_only refuses DELETE outside a purge), and a superset is
--   harmless to the old application. club_notifications_kind_known may be
--   narrowed only after deleting rows of the three new kinds — which loses
--   their dedupe state, so a re-run could re-send those mails (0044's caveat).
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- Erasure's first club-table lock, taken first (see the header).
LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
-- ─── Membership policies ──────────────────────────────────────────────────
ALTER TABLE "club_plans" ADD COLUMN "auto_renew" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "club_plans" ADD COLUMN "min_term_months" integer;--> statement-breakpoint
ALTER TABLE "club_plans" ADD COLUMN "notice_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "club_plans" ADD COLUMN "self_pause_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "club_plans" ADD COLUMN "self_cancel_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "club_plans" ADD CONSTRAINT "club_plans_policy_sane" CHECK (("club_plans"."min_term_months" IS NULL OR "club_plans"."min_term_months" BETWEEN 1 AND 36)
      AND "club_plans"."notice_days" BETWEEN 0 AND 120) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_plans" VALIDATE CONSTRAINT "club_plans_policy_sane";--> statement-breakpoint
-- A trial is one free visit or week; it never turns into a contract.
ALTER TABLE "club_plans" ADD CONSTRAINT "club_plans_trial_never_renews" CHECK ("club_plans"."kind" <> 'trial' OR NOT "club_plans"."auto_renew") NOT VALID;--> statement-breakpoint
ALTER TABLE "club_plans" VALIDATE CONSTRAINT "club_plans_trial_never_renews";--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "renews" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "renewal_of" uuid;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "term_started_on" date;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "renewal_ends_on" date;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_trial_never_renews" CHECK ("club_memberships"."kind" <> 'trial' OR NOT "club_memberships"."renews") NOT VALID;--> statement-breakpoint
ALTER TABLE "club_memberships" VALIDATE CONSTRAINT "club_memberships_trial_never_renews";--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_renewal_not_self" CHECK ("club_memberships"."renewal_of" IS NULL OR "club_memberships"."renewal_of" <> "club_memberships"."id") NOT VALID;--> statement-breakpoint
ALTER TABLE "club_memberships" VALIDATE CONSTRAINT "club_memberships_renewal_not_self";--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_term_dates_sane" CHECK (("club_memberships"."term_started_on" IS NULL OR (isfinite("club_memberships"."term_started_on") AND "club_memberships"."term_started_on" <= "club_memberships"."starts_on"))
      AND ("club_memberships"."renewal_ends_on" IS NULL OR isfinite("club_memberships"."renewal_ends_on"))) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_memberships" VALIDATE CONSTRAINT "club_memberships_term_dates_sane";--> statement-breakpoint
-- The successor of a period names it, and must be the SAME client's period
-- (the club_checkins_membership_fk pattern on club_memberships_member_unique):
-- otherwise one client's successor could occupy another's renewal slot and the
-- real renewal would be refused by club_memberships_one_successor. SET NULL
-- (renewal_of) keeps club_id and member_id when the predecessor is deleted.
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_renewal_fk" FOREIGN KEY ("club_id","member_id","renewal_of") REFERENCES "public"."club_memberships"("club_id","member_id","id") ON DELETE set null ("renewal_of") ON UPDATE no action;--> statement-breakpoint
-- One successor per period: the renewal job's idempotency key.
CREATE UNIQUE INDEX "club_memberships_one_successor" ON "club_memberships" USING btree ("renewal_of") WHERE "club_memberships"."renewal_of" IS NOT NULL;--> statement-breakpoint
-- The renewal job's scan: renewing, live memberships by end date.
CREATE INDEX "club_memberships_renewing_idx" ON "club_memberships" USING btree ("ends_on") WHERE "club_memberships"."renews" AND "club_memberships"."cancelled_at" IS NULL;--> statement-breakpoint
-- ─── No-show and late-cancel policies ─────────────────────────────────────
ALTER TABLE "club_classes" ADD COLUMN "no_show_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "club_classes" ADD COLUMN "late_cancel_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "club_classes" ADD COLUMN "strike_limit" integer;--> statement-breakpoint
ALTER TABLE "club_classes" ADD COLUMN "strike_days" integer;--> statement-breakpoint
ALTER TABLE "club_classes" ADD CONSTRAINT "club_classes_fees_sane" CHECK (("club_classes"."no_show_fee_cents" IS NULL OR "club_classes"."no_show_fee_cents" BETWEEN 1 AND 100000)
      AND ("club_classes"."late_cancel_fee_cents" IS NULL OR "club_classes"."late_cancel_fee_cents" BETWEEN 1 AND 100000)) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_classes" VALIDATE CONSTRAINT "club_classes_fees_sane";--> statement-breakpoint
ALTER TABLE "club_classes" ADD CONSTRAINT "club_classes_strikes_pair" CHECK (("club_classes"."strike_limit" IS NULL) = ("club_classes"."strike_days" IS NULL)
      AND ("club_classes"."strike_limit" IS NULL OR "club_classes"."strike_limit" BETWEEN 1 AND 20)
      AND ("club_classes"."strike_days" IS NULL OR "club_classes"."strike_days" BETWEEN 7 AND 180)) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_classes" VALIDATE CONSTRAINT "club_classes_strikes_pair";--> statement-breakpoint
ALTER TABLE "club_charges" ADD COLUMN "booking_id" uuid;--> statement-breakpoint
ALTER TABLE "club_charges" ADD CONSTRAINT "club_charges_booking_is_fee" CHECK ("club_charges"."booking_id" IS NULL OR "club_charges"."kind" = 'fee') NOT VALID;--> statement-breakpoint
ALTER TABLE "club_charges" VALIDATE CONSTRAINT "club_charges_booking_is_fee";--> statement-breakpoint
ALTER TABLE "club_charges" ADD CONSTRAINT "club_charges_booking_fk" FOREIGN KEY ("club_id","booking_id") REFERENCES "public"."club_bookings"("club_id","id") ON DELETE set null ("booking_id") ON UPDATE no action;--> statement-breakpoint
-- One fee per booking: a no-show and a late cancel are exclusive by
-- construction (a late-cancelled booking is not active, so it is never a
-- no-show), and the nightly job may run twice. VOIDED fees count too, on
-- purpose: a fee the desk waived must never be charged again by tomorrow's
-- run. Do not add "AND voided_at IS NULL" here; a corrected fee is issued as
-- an ordinary 'fee' charge without a booking.
CREATE UNIQUE INDEX "club_charges_one_fee_per_booking" ON "club_charges" USING btree ("booking_id") WHERE "club_charges"."booking_id" IS NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION club_charges_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  probe public.club_charges%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.club_id::text = current_setting('pops.purging_club', true) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'club_charges rows are voided, never deleted';
  END IF;
  probe := NEW;
  probe.voided_at := OLD.voided_at;
  probe.member_id := OLD.member_id;
  probe.membership_id := OLD.membership_id;
  probe.booking_id := OLD.booking_id;
  IF probe IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'club_charges: only voiding and anonymisation may change a charge';
  END IF;
  IF OLD.voided_at IS NOT NULL AND NEW.voided_at IS DISTINCT FROM OLD.voided_at THEN
    RAISE EXCEPTION 'club_charges: a void is final';
  END IF;
  IF NEW.member_id IS DISTINCT FROM OLD.member_id AND NEW.member_id IS NOT NULL THEN
    RAISE EXCEPTION 'club_charges: member_id may only be cleared';
  END IF;
  IF NEW.membership_id IS DISTINCT FROM OLD.membership_id AND NEW.membership_id IS NOT NULL THEN
    RAISE EXCEPTION 'club_charges: membership_id may only be cleared';
  END IF;
  IF NEW.booking_id IS DISTINCT FROM OLD.booking_id AND NEW.booking_id IS NOT NULL THEN
    RAISE EXCEPTION 'club_charges: booking_id may only be cleared';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- ─── Staff ────────────────────────────────────────────────────────────────
ALTER TABLE "club_staff" ADD COLUMN "public_profile" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE "club_time_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"staff_user_id" text NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_time_blocks_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_time_blocks_reason_known" CHECK ("club_time_blocks"."reason" IN ('time_off', 'training', 'other')),
	CONSTRAINT "club_time_blocks_range_sane" CHECK (isfinite("club_time_blocks"."starts_at") AND isfinite("club_time_blocks"."ends_at")
	      AND "club_time_blocks"."ends_at" > "club_time_blocks"."starts_at"
	      AND "club_time_blocks"."ends_at" - "club_time_blocks"."starts_at" <= interval '366 days')
);
--> statement-breakpoint
ALTER TABLE "club_time_blocks" ADD CONSTRAINT "club_time_blocks_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_time_blocks" ADD CONSTRAINT "club_time_blocks_staff_fk" FOREIGN KEY ("club_id","staff_user_id") REFERENCES "public"."club_staff"("club_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_time_blocks_staff_idx" ON "club_time_blocks" USING btree ("club_id","staff_user_id","starts_at");--> statement-breakpoint
COMMENT ON TABLE "club_time_blocks" IS 'A trainer''s unavailability (0045). Reasons are deliberately coarse — no "sick": the module records that a trainer is away, never why in health terms (GDPR Art. 9). created_by is a staff id stored BY VALUE with no FK (0039 rule 5).';--> statement-breakpoint
-- ─── The club page as a website ───────────────────────────────────────────
ALTER TABLE "clubs" ADD COLUMN "accent" text DEFAULT 'green' NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_accent_known" CHECK ("clubs"."accent" IN ('green', 'coral', 'sky')) NOT VALID;--> statement-breakpoint
ALTER TABLE "clubs" VALIDATE CONSTRAINT "clubs_accent_known";--> statement-breakpoint
CREATE TABLE "club_faq" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"question_bg" text NOT NULL,
	"answer_bg" text NOT NULL,
	"question_en" text,
	"answer_en" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_faq_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_faq_bg_sane" CHECK (btrim("club_faq"."question_bg") <> '' AND char_length("club_faq"."question_bg") <= 200
	      AND btrim("club_faq"."answer_bg") <> '' AND char_length("club_faq"."answer_bg") <= 1500),
	CONSTRAINT "club_faq_en_pair" CHECK (("club_faq"."question_en" IS NULL) = ("club_faq"."answer_en" IS NULL)
	      AND ("club_faq"."question_en" IS NULL OR (btrim("club_faq"."question_en") <> '' AND char_length("club_faq"."question_en") <= 200
	           AND btrim("club_faq"."answer_en") <> '' AND char_length("club_faq"."answer_en") <= 1500)))
);
--> statement-breakpoint
ALTER TABLE "club_faq" ADD CONSTRAINT "club_faq_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_faq_club_idx" ON "club_faq" USING btree ("club_id","sort_order");--> statement-breakpoint
CREATE TRIGGER "club_faq_set_updated_at" BEFORE UPDATE ON "club_faq" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
COMMENT ON TABLE "club_faq" IS 'The club''s own questions and answers on its public page (0045). Club content, not member data.';--> statement-breakpoint
-- ─── Contact consent ──────────────────────────────────────────────────────
ALTER TABLE "club_members" ADD COLUMN "marketing_email_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "marketing_sms_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "sms_opt_out_at" timestamp with time zone;--> statement-breakpoint
-- ─── Vocabulary ───────────────────────────────────────────────────────────
ALTER TABLE "club_audit" DROP CONSTRAINT "club_audit_action_known";--> statement-breakpoint
ALTER TABLE "club_audit" ADD CONSTRAINT "club_audit_action_known" CHECK ("club_audit"."action" IN (
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
	    'import_committed', 'export_downloaded', 'ngo_admin_viewed',
	    'membership_renewed', 'renewal_stopped', 'fee_charged',
	    'time_off_saved', 'time_off_removed', 'faq_saved', 'faq_removed',
	    'staff_profile_changed', 'preferences_changed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_audit" VALIDATE CONSTRAINT "club_audit_action_known";--> statement-breakpoint
ALTER TABLE "club_notifications" DROP CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_kind_known" CHECK ("club_notifications"."kind" IN (
	    'member_invite', 'staff_invite',
	    'booking_confirmed', 'booking_promoted', 'booking_cancelled', 'class_cancelled', 'reminder_24h',
	    'membership_expiring', 'membership_expired',
	    'application_received', 'application_approved', 'operator_new_application',
	    'claim_pending', 'erasure_requested',
	    'roster_daily', 'owner_weekly',
	    'membership_renewed', 'fee_charged', 'owner_monthly')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_notifications" VALIDATE CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
