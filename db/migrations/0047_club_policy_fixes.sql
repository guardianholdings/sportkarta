-- 0047_club_policy_fixes: the code review of «Клубове» v2 wave A (0045) found
-- that the no-show / late-cancel rules and the plan terms were read LIVE from
-- the class and the plan. Rules a member never saw could then bind them:
--   - a club switching a fee on tonight charged last week's no-shows;
--   - a club raising a plan's minimum term to 36 months bound members who
--     signed a month-to-month plan;
--   - a waitlisted member who withdrew (never holding a place), or a desk
--     undoing its own booking, paid a late-cancel fee.
-- The fix is the 0041 rule — a sale is a SNAPSHOT — applied to both:
--
--   club_bookings.no_show_fee_cents / late_cancel_fee_cents / counts_strikes
--     the class's policy AS BOOKED, copied by trigger when a booking becomes
--     active (on insert, and on a re-booking); the nightly fee job and the
--     strike count read these, never the class. Existing bookings snapshot
--     nothing, so no rule is applied retroactively.
--   club_bookings.cancel_kind / was_going
--     who cancelled (the member, or the desk) and whether the booking held a
--     place at that moment. Only a member's own late cancellation of a place
--     is a fee or a strike.
--   club_memberships.notice_days / min_term_months / self_pause_allowed /
--     self_cancel_allowed
--     the plan's terms AS SOLD; the portal and notice arithmetic read these.
--     Backfilled from the plans for memberships sold under 0045.
--   club_membership_pauses.by_member
--     a pause the member set in the portal — at most ONE per membership, by
--     a partial UNIQUE index (two portal submits racing cannot both land), and
--     never with a created_by (0039 rule 5: created_by is a STAFF id by value;
--     the member's POPS id is not stored there).
--
-- The class and plan bounds are copied, not referenced: club_bookings_fees_sane
-- twins 0045's club_classes_fees_sane and club_memberships_terms_sane twins
-- club_plans_policy_sane. A migration widening one MUST widen its twin, or
-- every booking of that class / sale of that plan fails on the wrong table.
--
-- Locking: club_staff first (0039's order); the backfill UPDATE touches the
-- club_memberships rows whose terms differ from their plan's, under the ACCESS
-- EXCLUSIVE its ADD COLUMN took — small tables, one deploy. When 0045–0047
-- ship in ONE migrate run behind an app that already serves the club tables
-- (#42 live), 0045 holds club_bookings / club_memberships early and 0047
-- upgrades club_bookings and first takes club_membership_pauses at the end:
-- a portal cancel or pause starting mid-batch can close a lock cycle, and
-- Postgres then aborts one side (most likely the migrator, the later waiter).
-- The deploy goes red and is simply re-run; nothing is half-applied, because
-- the batch is one transaction. Deploy at a quiet hour.
--
-- The backfill gives memberships the terms their plan has AT MIGRATION TIME.
-- In production 0045 and 0047 apply together, so every plan still holds
-- 0045's defaults (no notice, no minimum, no self-service) and the UPDATE
-- touches nothing. On a database where 0045 ran ahead (dev, e2e), it is the
-- nearest record of what a membership was sold under. Pauses the 0045-era
-- portal wrote kept the member's id in created_by with by_member = false, so
-- such a member could self-pause once more — dev data only, not backfilled
-- (an UPDATE re-runs club_membership_pauses_within_membership and raises for
-- pauses whose membership has since been cancelled).
--
-- rollback — in ONE explicit transaction, after reverting the application
-- (which then reads the class and plan live again). The columns may stay;
-- then, before the 0047 application returns, re-run this file's backfill for
-- memberships created since the revert (the reverted app sells with the
-- column defaults: no notice, no self-service). Cancellations made meanwhile
-- carry NULL cancel_kind / was_going and never become a fee or a strike (the
-- safe direction). If the columns must go:
--   DROP TRIGGER "club_bookings_policy_snapshot" ON "club_bookings";
--   DROP FUNCTION club_bookings_policy_snapshot();
--   DROP INDEX "club_membership_pauses_one_by_member";
--   ALTER TABLE "club_bookings" DROP COLUMN "cancel_kind", DROP COLUMN "was_going",
--     DROP COLUMN "no_show_fee_cents", DROP COLUMN "late_cancel_fee_cents",
--     DROP COLUMN "counts_strikes";            -- DESTRUCTIVE: the terms each
--     -- booking was made under, which the fee rows were computed from
--   ALTER TABLE "club_memberships" DROP COLUMN "notice_days", DROP COLUMN "min_term_months",
--     DROP COLUMN "self_pause_allowed", DROP COLUMN "self_cancel_allowed";
--     -- DESTRUCTIVE: the terms each membership was sold under
--   ALTER TABLE "club_membership_pauses" DROP COLUMN "by_member";
--     -- DESTRUCTIVE: which pauses members set themselves; the reverted app
--     -- cannot see them (created_by is NULL) and would allow a second one
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "club_bookings" ADD COLUMN "cancel_kind" text;--> statement-breakpoint
ALTER TABLE "club_bookings" ADD COLUMN "was_going" boolean;--> statement-breakpoint
ALTER TABLE "club_bookings" ADD COLUMN "no_show_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "club_bookings" ADD COLUMN "late_cancel_fee_cents" integer;--> statement-breakpoint
ALTER TABLE "club_bookings" ADD COLUMN "counts_strikes" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "club_bookings" ADD CONSTRAINT "club_bookings_cancel_kind_known" CHECK ("club_bookings"."cancel_kind" IS NULL OR "club_bookings"."cancel_kind" IN ('member', 'staff')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_bookings" VALIDATE CONSTRAINT "club_bookings_cancel_kind_known";--> statement-breakpoint
-- Who cancelled and whether it held a place are recorded together: a
-- cancellation with one and not the other would silently waive the fee.
ALTER TABLE "club_bookings" ADD CONSTRAINT "club_bookings_cancel_facts_pair" CHECK (("club_bookings"."cancel_kind" IS NULL) = ("club_bookings"."was_going" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_bookings" VALIDATE CONSTRAINT "club_bookings_cancel_facts_pair";--> statement-breakpoint
ALTER TABLE "club_bookings" ADD CONSTRAINT "club_bookings_active_not_cancelled" CHECK ("club_bookings"."state" <> 'active' OR "club_bookings"."cancel_kind" IS NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_bookings" VALIDATE CONSTRAINT "club_bookings_active_not_cancelled";--> statement-breakpoint
ALTER TABLE "club_bookings" ADD CONSTRAINT "club_bookings_fees_sane" CHECK (("club_bookings"."no_show_fee_cents" IS NULL OR "club_bookings"."no_show_fee_cents" BETWEEN 1 AND 100000)
      AND ("club_bookings"."late_cancel_fee_cents" IS NULL OR "club_bookings"."late_cancel_fee_cents" BETWEEN 1 AND 100000)) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_bookings" VALIDATE CONSTRAINT "club_bookings_fees_sane";--> statement-breakpoint
-- The class's policy as booked. Fires when a booking BECOMES active — a new
-- booking, or a re-booking after a cancellation — or when an active booking
-- moves to another class or changes between trial and regular (0042 allows
-- moving a booking); it clears the previous cancellation's facts. A trial
-- never carries a fee or a strike. The lookup is pinned to the booking's club
-- (0039 rule 1) and, finding nothing, leaves the row for the foreign key to
-- refuse with 23503 rather than failing NOT NULL with 23502 (0041's pattern).
CREATE FUNCTION club_bookings_policy_snapshot() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.state = 'active' AND (TG_OP = 'INSERT' OR OLD.state <> 'active'
                               OR OLD.occurrence_id <> NEW.occurrence_id
                               OR OLD.is_trial <> NEW.is_trial) THEN
    SELECT CASE WHEN NEW.is_trial THEN NULL ELSE k.no_show_fee_cents END,
           CASE WHEN NEW.is_trial THEN NULL ELSE k.late_cancel_fee_cents END,
           (NOT NEW.is_trial AND k.strike_limit IS NOT NULL)
      INTO NEW.no_show_fee_cents, NEW.late_cancel_fee_cents, NEW.counts_strikes
      FROM public.club_class_occurrences o
      JOIN public.club_classes k ON k.club_id = o.club_id AND k.id = o.class_id
     WHERE o.club_id = NEW.club_id AND o.id = NEW.occurrence_id;
    IF NOT FOUND THEN
      NEW.no_show_fee_cents := NULL;
      NEW.late_cancel_fee_cents := NULL;
      NEW.counts_strikes := false;  -- the foreign key reports it as 23503
    END IF;
    NEW.cancel_kind := NULL;
    NEW.was_going := NULL;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_bookings_policy_snapshot" BEFORE INSERT OR UPDATE OF "state", "occurrence_id", "is_trial" ON "club_bookings" FOR EACH ROW EXECUTE FUNCTION club_bookings_policy_snapshot();--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "notice_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "min_term_months" integer;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "self_pause_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD COLUMN "self_cancel_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_terms_sane" CHECK (("club_memberships"."min_term_months" IS NULL OR "club_memberships"."min_term_months" BETWEEN 1 AND 36)
      AND "club_memberships"."notice_days" BETWEEN 0 AND 120) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_memberships" VALIDATE CONSTRAINT "club_memberships_terms_sane";--> statement-breakpoint
-- Existing memberships get the terms their plan has now (see the header: in
-- production these are 0045's defaults and nothing changes). Only rows that
-- differ are written, so no membership's updated_at moves for nothing.
UPDATE "club_memberships" ms
   SET notice_days = p.notice_days, min_term_months = p.min_term_months,
       self_pause_allowed = p.self_pause_allowed, self_cancel_allowed = p.self_cancel_allowed
  FROM "club_plans" p
 WHERE p.club_id = ms.club_id AND p.id = ms.plan_id
   AND (ms.notice_days, ms.min_term_months, ms.self_pause_allowed, ms.self_cancel_allowed)
       IS DISTINCT FROM (p.notice_days, p.min_term_months, p.self_pause_allowed, p.self_cancel_allowed);--> statement-breakpoint
ALTER TABLE "club_membership_pauses" ADD COLUMN "by_member" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "club_membership_pauses" ADD CONSTRAINT "club_membership_pauses_member_unattributed" CHECK (NOT "club_membership_pauses"."by_member" OR "club_membership_pauses"."created_by" IS NULL) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_membership_pauses" VALIDATE CONSTRAINT "club_membership_pauses_member_unattributed";--> statement-breakpoint
CREATE UNIQUE INDEX "club_membership_pauses_one_by_member" ON "club_membership_pauses" USING btree ("membership_id") WHERE "club_membership_pauses"."by_member";--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
