-- 0053_club_events: «Клубове» v2, wave D1 (plan 2026-10-25) — events, camps,
-- workshops and tournaments with tickets, a waitlist and online payment
-- (1club's events and tournaments; anolla's camps and tournaments).
-- Hand-written; do not regenerate.
--
-- WHAT THIS ADDS
--
--   club_events            one event at one of the club's locations: a kind
--                          (event | camp | workshop | tournament), a title and
--                          description in bg (en optional), a span of up to 60
--                          days, an optional sport (a tournament's ratings are
--                          per sport, wave D2), a registration window, an
--                          overall capacity (NULL: no limit), a team flag (a
--                          registration then carries a team name), how it is
--                          paid (desk | online_optional | online_required, the
--                          services' vocabulary), a cancel deadline, a public
--                          flag and a status draft | published | cancelled. An
--                          event is never deleted: it is cancelled.
--   club_event_tickets     what a person registers FOR: a ticket type with a
--                          price, an optional member price (at most the price),
--                          an optional capacity of its own, and an audience
--                          (all | adults | minors, the plans' vocabulary).
--                          Archived, never deleted.
--   club_event_registrations
--                          one person's place: the ticket, the client record
--                          (SET NULL on erasure — the seat stays taken,
--                          anonymised, as a court booking does), an ARRIVAL
--                          TICKET from a sequence (the waitlist's order, 0042's
--                          rule), a state held | confirmed | waitlisted |
--                          cancelled | late_cancelled | expired, the price and
--                          the free-cancel deadline SNAPSHOTTED at registration
--                          (as hours and as the instant — moving the event later
--                          never shortens what a person was promised), when it
--                          got its seat (at registration, or later from the line
--                          — a place the line seated after the deadline was
--                          never accepted late, so giving it up is never late),
--                          the charge, a team name (cleared with
--                          the client on erasure), and who registered them
--                          (staff by value).
--
-- THE RULES THE DATABASE HOLDS
--
--   * OVER-BOOKING IS IMPOSSIBLE BY CONSTRUCTION. A row that takes a seat
--     (held or confirmed) — inserted, or moved there from the waitlist — is
--     admitted by club_event_registrations_seat only while the event and the
--     ticket have room, counted under a lock on the EVENT row (FOR NO KEY
--     UPDATE: it does not wait on the FOR KEY SHARE every foreign-key check on
--     that row takes). Held rows count whether or not their hold has lapsed:
--     a lapsed hold is released by the application (its charge voided, its
--     checkout closed, in one transaction) before its seat is given away, so a
--     payment arriving at the last moment can never confirm a seat sold twice.
--   * THE LINE IS NOT JUMPED: per ticket, until the event starts, the
--     database refuses a newcomer a seat somebody waits for
--     (club_event_registrations_line_first; once it has started, the line is
--     frozen and the desk seats whom it sees); across
--     tickets, the application gives a freed seat to the line, in arrival
--     order, in the same transaction that freed it. The arrival ticket is
--     drawn by the trigger on every INSERT, never taken from the writer, as
--     are the free-cancel instant and the seat time; a place names its client
--     when made (NULL means erased, nothing else).
--   * A capacity — the event's or a ticket's — is never set below the seats
--     already taken (club_events_capacity_taken), under the same event lock.
--   * A place starts alive (held, confirmed or waitlisted), on a live ticket
--     of a PUBLISHED event (club_event_registrations_event_open), and only a
--     published event gives seats. One charge is ONE place's, and of kind
--     'event' (club_event_registrations_charge_unique, …_charge_kind): a
--     payment confirms, and a release or a cancellation voids, exactly the
--     place it was for.
--   * An event's status moves draft → published → cancelled (or draft →
--     cancelled), never back (club_events_status_flow).
--   * A payment on a held registration's charge confirms it, wherever the
--     money was taken (club_payments_confirm_event_hold — 0048's rule for
--     courts, beside it). The confirm path never takes the event lock.
--   * What was registered never changes, and states only move forward
--     (club_event_registrations_guard): waitlisted → held | confirmed |
--     cancelled; held → confirmed | cancelled | expired; confirmed →
--     cancelled | late_cancelled. An ended registration stays as it ended
--     except that erasure clears its client.
--   * A published event with a resource closes that resource for the event's
--     span: a club_time_blocks row with event_id, reason 'event', written and
--     removed by a trigger on club_events and by nothing else (a guard on
--     club_time_blocks, 0048's pg_trigger_depth pattern) — so the calendar's
--     EXCLUDE constraints (0048) refuse an event on a court already booked
--     (23P01), and a court booking over an event. An edit that does not move
--     the event leaves its closure alone (it is not re-checked against
--     today's calendar).
--
-- THE LOCK ORDER every transaction that writes registrations keeps (the
-- application's — SQL cannot enforce it): the EVENT row FOR NO KEY UPDATE
-- first, then the open checkouts, the charges, the registrations — each set
-- by id; a sweep over several events takes them one transaction each. A
-- payment confirming a hold takes checkout → charge → registration and never
-- the event, so it cannot close a cycle with any of these.
--
--   club_charge_holds      every held seat or slot and its charge — the court
--                          bookings (0048) and the event registrations — for
--                          the one place that ties a payment session's expiry
--                          to its hold (apps/web/lib/clubs/payments.ts).
--
--   Vocabulary: charge kind 'event'; time block reason 'event'; notification
--   kinds event_registered, event_promoted, event_cancelled; audit actions
--   event_saved, event_published, event_cancelled, event_registered,
--   event_registration_cancelled. The twin lists live in
--   lib/src/clubs/vocab.ts and lib/src/clubs/events.ts; lib/src/clubs/
--   clubs.test.ts reads the LAST definition of each constraint.
--
-- TENANCY: every new table carries club_id with its own club_id → clubs
-- CASCADE, so the purge empties them in its first round (0049's header).
-- Keys inside a club are composite (club_id, …): an event names only the
-- club's own location and a resource AT that location, a ticket only its own
-- event, a registration only that event's ticket (club_id, event_id,
-- ticket_id), the club's own client and the club's own charge. The client key
-- SETs NULL on that one column; the others are NO ACTION (nothing deletes an
-- event, a ticket or a charge). No new column references users: staff ids are
-- BY VALUE (0039 rule 5), so account erasure has no new rows to count.
--
-- Locking: club_staff first (ACCESS EXCLUSIVE), the order 0045–0052 keep for
-- account erasure; then club_audit and club_notifications (CHECK swaps —
-- VALIDATE scans them); then SHARE ROW EXCLUSIVE on clubs, club_locations,
-- club_resources and club_members for the new keys; then ACCESS EXCLUSIVE on
-- club_charges (a CHECK swap) and club_time_blocks (a column, a CHECK swap, a
-- key, a guard), and SHARE ROW EXCLUSIVE on club_payments (a new trigger) —
-- all until COMMIT. Locking club_staff first serialises account erasure and
-- the staff-scoped statements only: a payment being recorded at that moment
-- takes club_charges and club_payments in the other order (0048); a trainer's
-- leave writes club_time_blocks before its key reaches club_staff; a portal,
-- kiosk or worker transaction that writes club_members or club_charges
-- before club_audit holds those in the reverse order. One running at that
-- instant may deadlock with this file — Postgres aborts one side after ~1 s:
-- a red deploy is simply re-run, pg-boss retries a job, a form is sent
-- again. No order of these statements removes that. Small tables, one
-- transaction: deploy at a quiet hour, never during a club purge (0045).
--
-- rollback (after reverting the application), in ONE explicit transaction, at
-- a quiet hour. It takes ACCESS EXCLUSIVE on club_payments, club_charges,
-- club_members, clubs and club_time_blocks (dropped triggers and keys) until
-- COMMIT and may meet a payment as the deploy does — re-run it:
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;
--   -- Places held for a payment first: their charges voided and their
--   -- checkouts closed, so the reverted application (whose sweep knows only
--   -- court holds) is not left owing a place that no longer exists. A
--   -- provider session still open takes money until its own expiry (at most
--   -- 23 hours); that payment lands on a void charge as unapplied, to refund.
--   -- (checkouts before charges: the payment path's order)
--   UPDATE "club_checkouts" SET "status" = 'expired', "completed_at" = now()
--    WHERE "charge_id" IN (SELECT "charge_id" FROM "club_event_registrations" WHERE "state" = 'held')
--      AND "status" = 'open';
--   UPDATE "club_charges" ch SET "voided_at" = now()
--    WHERE ch."id" IN (SELECT "charge_id" FROM "club_event_registrations" WHERE "state" = 'held')
--      AND ch."voided_at" IS NULL
--      AND NOT EXISTS (SELECT 1 FROM "club_payments" pp WHERE pp."charge_id" = ch."id");
--   DROP VIEW "club_charge_holds";
--   DROP TRIGGER "club_payments_confirm_event_hold" ON "club_payments";
--   DROP TRIGGER "club_events_resource_block" ON "club_events";
--   DROP TRIGGER "club_time_blocks_event_guard" ON "club_time_blocks";
--   DELETE FROM "club_time_blocks" WHERE "event_id" IS NOT NULL;  -- DESTRUCTIVE: event closures
--   ALTER TABLE "club_time_blocks" DROP CONSTRAINT "club_time_blocks_event_reason",
--     DROP COLUMN "event_id";
--   DROP TABLE "club_event_registrations";   -- DESTRUCTIVE: every registration
--   DROP TABLE "club_event_tickets", "club_events";
--   DROP SEQUENCE "club_event_registration_seq";
--   DROP FUNCTION club_payments_confirm_event_hold(), club_events_resource_block(),
--     club_event_registrations_seat(), club_event_registrations_guard(),
--     club_events_status_flow(), club_event_capacity_guard(), club_time_blocks_event_guard();
--   The widened club_audit_action_known, club_notifications_kind_known,
--   club_charges_kind_known and club_time_blocks_reason_known STAY (a superset
--   is harmless; audit rows and charges are never removed). `event` charges
--   remain as open money the reverted application must still display and
--   settle.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_audit", "club_notifications" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "clubs", "club_locations", "club_resources", "club_members" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_charges", "club_time_blocks" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_payments" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- ─── Events ──────────────────────────────────────────────────────────────
CREATE TABLE "club_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title_bg" text NOT NULL,
	"title_en" text,
	"description_bg" text,
	"description_en" text,
	"sport" text,
	"location_id" uuid NOT NULL,
	"resource_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"registration_opens_at" timestamp with time zone,
	"registration_closes_at" timestamp with time zone,
	"capacity" integer,
	"team_event" boolean DEFAULT false NOT NULL,
	"payment" text DEFAULT 'desk' NOT NULL,
	"cancel_deadline_hours" integer DEFAULT 48 NOT NULL,
	"public" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_events_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_events_kind_known" CHECK ("club_events"."kind" IN ('event', 'camp', 'workshop', 'tournament')),
	CONSTRAINT "club_events_title_sane" CHECK (btrim("club_events"."title_bg") <> '' AND char_length("club_events"."title_bg") <= 120
	      AND ("club_events"."title_en" IS NULL OR (btrim("club_events"."title_en") <> '' AND char_length("club_events"."title_en") <= 120))),
	CONSTRAINT "club_events_description_sane" CHECK (("club_events"."description_bg" IS NULL OR (btrim("club_events"."description_bg") <> '' AND char_length("club_events"."description_bg") <= 4000))
	      AND ("club_events"."description_en" IS NULL OR (btrim("club_events"."description_en") <> '' AND char_length("club_events"."description_en") <= 4000))),
	CONSTRAINT "club_events_sport_format" CHECK ("club_events"."sport" IS NULL OR "club_events"."sport" ~ '^[a-z][a-z0-9_]{1,29}$'),
	CONSTRAINT "club_events_span_sane" CHECK (isfinite("club_events"."starts_at") AND isfinite("club_events"."ends_at")
	      AND "club_events"."ends_at" > "club_events"."starts_at"
	      AND "club_events"."ends_at" - "club_events"."starts_at" <= interval '60 days'),
	-- Registration closes no later than the event ends, and opens before it closes.
	CONSTRAINT "club_events_window_sane" CHECK (("club_events"."registration_opens_at" IS NULL OR isfinite("club_events"."registration_opens_at"))
	      AND ("club_events"."registration_closes_at" IS NULL
	           OR (isfinite("club_events"."registration_closes_at") AND "club_events"."registration_closes_at" <= "club_events"."ends_at"))
	      AND ("club_events"."registration_opens_at" IS NULL OR "club_events"."registration_closes_at" IS NULL
	           OR "club_events"."registration_opens_at" < "club_events"."registration_closes_at")),
	CONSTRAINT "club_events_capacity_sane" CHECK ("club_events"."capacity" IS NULL OR "club_events"."capacity" BETWEEN 1 AND 10000),
	CONSTRAINT "club_events_payment_known" CHECK ("club_events"."payment" IN ('desk', 'online_optional', 'online_required')),
	CONSTRAINT "club_events_cancel_sane" CHECK ("club_events"."cancel_deadline_hours" BETWEEN 0 AND 720),
	CONSTRAINT "club_events_status_known" CHECK ("club_events"."status" IN ('draft', 'published', 'cancelled')),
	CONSTRAINT "club_events_cancel_pair" CHECK (("club_events"."status" = 'cancelled') = ("club_events"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "club_events" ADD CONSTRAINT "club_events_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_events" ADD CONSTRAINT "club_events_location_fk" FOREIGN KEY ("club_id","location_id") REFERENCES "public"."club_locations"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The resource must stand at the event's own location (0048's class rule).
ALTER TABLE "club_events" ADD CONSTRAINT "club_events_resource_fk" FOREIGN KEY ("club_id","location_id","resource_id") REFERENCES "public"."club_resources"("club_id","location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_events_club_starts_idx" ON "club_events" USING btree ("club_id","starts_at");--> statement-breakpoint
CREATE INDEX "club_events_resource_idx" ON "club_events" USING btree ("club_id","resource_id") WHERE "club_events"."resource_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_events_location_idx" ON "club_events" USING btree ("club_id","location_id");--> statement-breakpoint
CREATE TRIGGER "club_events_set_updated_at" BEFORE UPDATE ON "club_events" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- draft → published → cancelled (or draft → cancelled); never back. A
-- cancelled event's places are gone; a published one's are being sold.
CREATE FUNCTION club_events_status_flow() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT ((OLD.status = 'draft' AND NEW.status IN ('published', 'cancelled'))
              OR (OLD.status = 'published' AND NEW.status = 'cancelled')) THEN
    RAISE EXCEPTION 'club_events: an event goes draft → published → cancelled, never back'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_events_status_flow';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_events_status_flow" BEFORE UPDATE OF "status" ON "club_events" FOR EACH ROW EXECUTE FUNCTION club_events_status_flow();--> statement-breakpoint
CREATE TABLE "club_event_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"name_bg" text NOT NULL,
	"name_en" text,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"member_price_cents" integer,
	"capacity" integer,
	"audience" text DEFAULT 'all' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_event_tickets_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_event_tickets_event_unique" UNIQUE("club_id", "event_id", "id"),
	CONSTRAINT "club_event_tickets_name_sane" CHECK (btrim("club_event_tickets"."name_bg") <> '' AND char_length("club_event_tickets"."name_bg") <= 80
	      AND ("club_event_tickets"."name_en" IS NULL OR (btrim("club_event_tickets"."name_en") <> '' AND char_length("club_event_tickets"."name_en") <= 80))),
	CONSTRAINT "club_event_tickets_price_sane" CHECK ("club_event_tickets"."price_cents" BETWEEN 0 AND 10000000
	      AND ("club_event_tickets"."member_price_cents" IS NULL
	           OR "club_event_tickets"."member_price_cents" BETWEEN 0 AND "club_event_tickets"."price_cents")),
	CONSTRAINT "club_event_tickets_capacity_sane" CHECK ("club_event_tickets"."capacity" IS NULL OR "club_event_tickets"."capacity" BETWEEN 1 AND 10000),
	CONSTRAINT "club_event_tickets_audience_known" CHECK ("club_event_tickets"."audience" IN ('all', 'adults', 'minors')),
	CONSTRAINT "club_event_tickets_sort_sane" CHECK ("club_event_tickets"."sort_order" BETWEEN 0 AND 1000)
);
--> statement-breakpoint
ALTER TABLE "club_event_tickets" ADD CONSTRAINT "club_event_tickets_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_event_tickets" ADD CONSTRAINT "club_event_tickets_event_fk" FOREIGN KEY ("club_id","event_id") REFERENCES "public"."club_events"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_event_tickets_event_idx" ON "club_event_tickets" USING btree ("club_id","event_id","sort_order");--> statement-breakpoint
CREATE TRIGGER "club_event_tickets_set_updated_at" BEFORE UPDATE ON "club_event_tickets" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE SEQUENCE "public"."club_event_registration_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "club_event_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"member_id" uuid,
	"seq" bigint DEFAULT nextval('club_event_registration_seq') NOT NULL,
	"state" text NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"price_cents" integer NOT NULL,
	"cancel_deadline_hours" integer NOT NULL,
	-- Set by the seat trigger at INSERT; the default is only a placeholder.
	"free_cancel_until" timestamp with time zone DEFAULT now() NOT NULL,
	"seated_at" timestamp with time zone,
	"charge_id" uuid,
	"team_name" text,
	"booked_by" text,
	"cancel_kind" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_event_registrations_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_event_registrations_seq_unique" UNIQUE("seq"),
	CONSTRAINT "club_event_registrations_state_known" CHECK ("club_event_registrations"."state" IN ('held', 'confirmed', 'waitlisted', 'cancelled', 'late_cancelled', 'expired')),
	CONSTRAINT "club_event_registrations_hold_pair" CHECK (("club_event_registrations"."state" = 'held') = ("club_event_registrations"."hold_expires_at" IS NOT NULL)),
	-- The event is cancelled by the club ('club'), a place by its member or the desk.
	CONSTRAINT "club_event_registrations_cancel_facts" CHECK ((("club_event_registrations"."state" IN ('cancelled', 'late_cancelled')) = ("club_event_registrations"."cancelled_at" IS NOT NULL))
	      AND (("club_event_registrations"."state" IN ('cancelled', 'late_cancelled')) = ("club_event_registrations"."cancel_kind" IS NOT NULL))
	      AND ("club_event_registrations"."cancel_kind" IS NULL OR "club_event_registrations"."cancel_kind" IN ('member', 'staff', 'club'))),
	CONSTRAINT "club_event_registrations_price_sane" CHECK ("club_event_registrations"."price_cents" BETWEEN 0 AND 10000000),
	CONSTRAINT "club_event_registrations_cancel_sane" CHECK ("club_event_registrations"."cancel_deadline_hours" BETWEEN 0 AND 720),
	CONSTRAINT "club_event_registrations_team_sane" CHECK ("club_event_registrations"."team_name" IS NULL
	      OR (btrim("club_event_registrations"."team_name") <> '' AND char_length("club_event_registrations"."team_name") <= 60)),
	-- A waitlisted place has no seat yet, so nothing to pay for yet.
	CONSTRAINT "club_event_registrations_waitlist_unbilled" CHECK ("club_event_registrations"."state" <> 'waitlisted' OR "club_event_registrations"."charge_id" IS NULL),
	-- When the place got its seat: a seat holder has one, a place in line none.
	CONSTRAINT "club_event_registrations_seated_pair" CHECK (("club_event_registrations"."state" NOT IN ('held', 'confirmed', 'late_cancelled') OR "club_event_registrations"."seated_at" IS NOT NULL)
	      AND ("club_event_registrations"."state" <> 'waitlisted' OR "club_event_registrations"."seated_at" IS NULL)),
	CONSTRAINT "club_event_registrations_times_finite" CHECK (isfinite("club_event_registrations"."free_cancel_until")
	      AND ("club_event_registrations"."seated_at" IS NULL OR isfinite("club_event_registrations"."seated_at")))
);
--> statement-breakpoint
ALTER TABLE "club_event_registrations" ADD CONSTRAINT "club_event_registrations_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_event_registrations" ADD CONSTRAINT "club_event_registrations_event_fk" FOREIGN KEY ("club_id","event_id") REFERENCES "public"."club_events"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_event_registrations" ADD CONSTRAINT "club_event_registrations_ticket_fk" FOREIGN KEY ("club_id","event_id","ticket_id") REFERENCES "public"."club_event_tickets"("club_id","event_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Erasing the client keeps the seat (the club's books, its head count), anonymised.
ALTER TABLE "club_event_registrations" ADD CONSTRAINT "club_event_registrations_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE set null ("member_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_event_registrations" ADD CONSTRAINT "club_event_registrations_charge_fk" FOREIGN KEY ("club_id","charge_id") REFERENCES "public"."club_charges"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_event_registrations_event_idx" ON "club_event_registrations" USING btree ("club_id","event_id","seq");--> statement-breakpoint
CREATE INDEX "club_event_registrations_ticket_idx" ON "club_event_registrations" USING btree ("club_id","ticket_id") WHERE "club_event_registrations"."state" IN ('held', 'confirmed');--> statement-breakpoint
CREATE INDEX "club_event_registrations_member_idx" ON "club_event_registrations" USING btree ("club_id","member_id") WHERE "club_event_registrations"."member_id" IS NOT NULL;--> statement-breakpoint
-- One charge is one place's: a payment confirms, a release or a cancellation
-- voids, exactly the place it was raised for (0048's rule for bookings).
CREATE UNIQUE INDEX "club_event_registrations_charge_unique" ON "club_event_registrations" USING btree ("club_id","charge_id") WHERE "club_event_registrations"."charge_id" IS NOT NULL;--> statement-breakpoint
-- One live place per person per event: a second registration is a mistake,
-- and a place given up may be taken again (with a FRESH arrival ticket).
CREATE UNIQUE INDEX "club_event_registrations_one_live" ON "club_event_registrations" USING btree ("club_id","event_id","member_id") WHERE "club_event_registrations"."member_id" IS NOT NULL AND "club_event_registrations"."state" IN ('held', 'confirmed', 'waitlisted');--> statement-breakpoint
CREATE INDEX "club_event_registrations_held_idx" ON "club_event_registrations" USING btree ("hold_expires_at") WHERE "club_event_registrations"."state" = 'held';--> statement-breakpoint
CREATE TRIGGER "club_event_registrations_set_updated_at" BEFORE UPDATE ON "club_event_registrations" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- ─── The rules ───────────────────────────────────────────────────────────
-- A place starts alive, with its arrival ticket drawn here, on a live ticket
-- of a published event, and with nobody's charge but its own. A seat is taken
-- only while there is one — the event's capacity and the ticket's, counted
-- under a lock on the event row — and never ahead of somebody waiting for the
-- same ticket. Moving between seat states (held → confirmed, by a payment)
-- takes no new seat and no lock.
CREATE FUNCTION club_event_registrations_seat() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  event_status text;
  event_capacity integer;
  event_starts timestamptz;
  event_hours integer;
  ticket_capacity integer;
  ticket_archived boolean;
  taken integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state NOT IN ('held', 'confirmed', 'waitlisted') OR NEW.member_id IS NULL THEN
      RAISE EXCEPTION 'club_event_registrations: a place starts held, confirmed or waitlisted, for a client'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_event_registrations_terms';
    END IF;
    NEW.seq := nextval('public.club_event_registration_seq');
    IF NEW.charge_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.club_charges ch
       WHERE ch.club_id = NEW.club_id AND ch.id = NEW.charge_id AND ch.kind = 'event'
    ) THEN
      RAISE EXCEPTION 'club_event_registrations: a place is paid by an event charge'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_event_registrations_charge_kind';
    END IF;
  ELSIF OLD.state IN ('held', 'confirmed') OR NEW.state NOT IN ('held', 'confirmed') THEN
    RETURN NEW;
  END IF;
  SELECT e.status, e.capacity, e.starts_at, e.cancel_deadline_hours
    INTO event_status, event_capacity, event_starts, event_hours
    FROM public.club_events e
   WHERE e.club_id = NEW.club_id AND e.id = NEW.event_id
     FOR NO KEY UPDATE;
  IF TG_OP = 'INSERT' THEN
    -- The terms are the event's, the times the database's — never the writer's.
    NEW.cancel_deadline_hours := coalesce(event_hours, NEW.cancel_deadline_hours);
    NEW.free_cancel_until := event_starts - make_interval(hours => NEW.cancel_deadline_hours);
    NEW.created_at := now();
    NEW.seated_at := CASE WHEN NEW.state IN ('held', 'confirmed') THEN now() END;
  END IF;
  IF event_status IS DISTINCT FROM 'published' THEN
    RAISE EXCEPTION 'club_event_registrations: only a published event takes registrations and gives seats'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_event_registrations_event_open';
  END IF;
  SELECT t.capacity, t.archived_at IS NOT NULL INTO ticket_capacity, ticket_archived
    FROM public.club_event_tickets t
   WHERE t.club_id = NEW.club_id AND t.id = NEW.ticket_id;
  IF TG_OP = 'INSERT' AND ticket_archived THEN
    RAISE EXCEPTION 'club_event_registrations: the ticket is no longer on sale'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_event_registrations_ticket_live';
  END IF;
  IF NEW.state NOT IN ('held', 'confirmed') THEN
    RETURN NEW;
  END IF;
  -- From the line into a seat: now — and never an erased client's place.
  IF TG_OP = 'UPDATE' THEN
    IF NEW.member_id IS NULL THEN
      RAISE EXCEPTION 'club_event_registrations: an erased client''s place is never seated'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_event_registrations_terms';
    END IF;
    NEW.seated_at := now();
  END IF;
  IF TG_OP = 'INSERT' AND event_starts > now() AND EXISTS (
    SELECT 1 FROM public.club_event_registrations w
     WHERE w.club_id = NEW.club_id AND w.ticket_id = NEW.ticket_id
       AND w.state = 'waitlisted' AND w.member_id IS NOT NULL
       -- Somebody the line can still seat: an archived client is never promoted.
       AND EXISTS (SELECT 1 FROM public.club_members wm
                    WHERE wm.club_id = w.club_id AND wm.id = w.member_id AND wm.archived_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'club_event_registrations: somebody is waiting for this ticket'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_event_registrations_line_first';
  END IF;
  IF event_capacity IS NOT NULL THEN
    SELECT count(*) INTO taken FROM public.club_event_registrations r
     WHERE r.club_id = NEW.club_id AND r.event_id = NEW.event_id
       AND r.state IN ('held', 'confirmed') AND r.id <> NEW.id;
    IF taken >= event_capacity THEN
      RAISE EXCEPTION 'club_event_registrations: the event is full'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_event_registrations_full';
    END IF;
  END IF;
  IF ticket_capacity IS NOT NULL THEN
    SELECT count(*) INTO taken FROM public.club_event_registrations r
     WHERE r.club_id = NEW.club_id AND r.ticket_id = NEW.ticket_id
       AND r.state IN ('held', 'confirmed') AND r.id <> NEW.id;
    IF taken >= ticket_capacity THEN
      RAISE EXCEPTION 'club_event_registrations: the ticket is sold out'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_event_registrations_full';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_event_registrations_seat" BEFORE INSERT OR UPDATE OF "state" ON "club_event_registrations" FOR EACH ROW EXECUTE FUNCTION club_event_registrations_seat();--> statement-breakpoint
-- What was registered never changes, and a place's state only moves forward.
CREATE FUNCTION club_event_registrations_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  probe public.club_event_registrations%ROWTYPE;
  erased boolean := NEW.member_id IS NULL AND OLD.member_id IS NOT NULL;
BEGIN
  -- Erasing the client erases a team name with it (it may be their own name).
  IF erased THEN
    NEW.team_name := NULL;
  END IF;
  IF OLD.state IN ('cancelled', 'late_cancelled', 'expired') THEN
    probe := NEW;
    probe.member_id := OLD.member_id;
    IF erased THEN
      probe.team_name := OLD.team_name;
    END IF;
    probe.updated_at := OLD.updated_at;
    IF probe IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'club_event_registrations: an ended place stays as it ended'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_event_registrations_terms';
    END IF;
  ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.club_id IS DISTINCT FROM OLD.club_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.ticket_id IS DISTINCT FROM OLD.ticket_id
     OR NEW.seq IS DISTINCT FROM OLD.seq OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.price_cents IS DISTINCT FROM OLD.price_cents
     OR NEW.cancel_deadline_hours IS DISTINCT FROM OLD.cancel_deadline_hours
     OR NEW.free_cancel_until IS DISTINCT FROM OLD.free_cancel_until
     -- The seat time is the seat trigger's to set (it fires after this one).
     OR NEW.seated_at IS DISTINCT FROM OLD.seated_at
     OR NEW.booked_by IS DISTINCT FROM OLD.booked_by
     OR (NEW.team_name IS DISTINCT FROM OLD.team_name AND NOT erased)
     OR (OLD.charge_id IS NOT NULL AND NEW.charge_id IS DISTINCT FROM OLD.charge_id)
     OR (NEW.state = 'waitlisted' AND OLD.state <> 'waitlisted')
     OR (NEW.state = 'held' AND OLD.state NOT IN ('held', 'waitlisted'))
     OR (NEW.state = 'confirmed' AND OLD.state NOT IN ('confirmed', 'held', 'waitlisted'))
     OR (NEW.state = 'expired' AND OLD.state <> 'held')
     OR (NEW.state = 'late_cancelled' AND OLD.state <> 'confirmed') THEN
    RAISE EXCEPTION 'club_event_registrations: what was registered never changes, and states only move forward'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_event_registrations_terms';
  END IF;
  IF NEW.member_id IS DISTINCT FROM OLD.member_id AND NEW.member_id IS NOT NULL THEN
    RAISE EXCEPTION 'club_event_registrations: the client may only be cleared'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_event_registrations_terms';
  END IF;
  IF NEW.charge_id IS NOT NULL AND NEW.charge_id IS DISTINCT FROM OLD.charge_id AND NOT EXISTS (
    SELECT 1 FROM public.club_charges ch
     WHERE ch.club_id = NEW.club_id AND ch.id = NEW.charge_id AND ch.kind = 'event'
  ) THEN
    RAISE EXCEPTION 'club_event_registrations: a place is paid by an event charge'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_event_registrations_charge_kind';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_event_registrations_guard" BEFORE UPDATE ON "club_event_registrations" FOR EACH ROW EXECUTE FUNCTION club_event_registrations_guard();--> statement-breakpoint
CREATE TRIGGER "club_event_registrations_no_truncate" BEFORE TRUNCATE ON "club_event_registrations" FOR EACH STATEMENT EXECUTE FUNCTION club_calendar_no_truncate();--> statement-breakpoint
-- A payment on a held place's charge confirms it — the court bookings' rule
-- (0048), for event places. No event lock: the seat was already counted.
CREATE FUNCTION club_payments_confirm_event_hold() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.club_event_registrations
     SET state = 'confirmed', hold_expires_at = NULL, updated_at = now()
   WHERE club_id = NEW.club_id AND charge_id = NEW.charge_id AND state = 'held';
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_payments_confirm_event_hold" AFTER INSERT ON "club_payments" FOR EACH ROW WHEN (NEW.kind = 'payment') EXECUTE FUNCTION club_payments_confirm_event_hold();--> statement-breakpoint
-- A capacity — the event's or a ticket's — never drops below the seats
-- already taken: counted under the event row lock, as the seat trigger counts.
CREATE FUNCTION club_event_capacity_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent uuid;
  taken integer;
BEGIN
  IF NEW.capacity IS NULL OR NEW.capacity IS NOT DISTINCT FROM OLD.capacity THEN
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME = 'club_events' THEN
    SELECT count(*) INTO taken FROM public.club_event_registrations r
     WHERE r.club_id = NEW.club_id AND r.event_id = NEW.id AND r.state IN ('held', 'confirmed');
  ELSE
    parent := NEW.event_id;
    PERFORM 1 FROM public.club_events e
      WHERE e.club_id = NEW.club_id AND e.id = parent FOR NO KEY UPDATE;
    SELECT count(*) INTO taken FROM public.club_event_registrations r
     WHERE r.club_id = NEW.club_id AND r.ticket_id = NEW.id AND r.state IN ('held', 'confirmed');
  END IF;
  IF taken > NEW.capacity THEN
    RAISE EXCEPTION '%: the capacity is below the seats already taken', TG_TABLE_NAME
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_events_capacity_taken';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_events_capacity_guard" BEFORE UPDATE OF "capacity" ON "club_events" FOR EACH ROW EXECUTE FUNCTION club_event_capacity_guard();--> statement-breakpoint
CREATE TRIGGER "club_event_tickets_capacity_guard" BEFORE UPDATE OF "capacity" ON "club_event_tickets" FOR EACH ROW EXECUTE FUNCTION club_event_capacity_guard();--> statement-breakpoint
-- ─── An event closes its court ───────────────────────────────────────────
ALTER TABLE "club_time_blocks" ADD COLUMN "event_id" uuid;--> statement-breakpoint
ALTER TABLE "club_time_blocks" DROP CONSTRAINT "club_time_blocks_reason_known";--> statement-breakpoint
ALTER TABLE "club_time_blocks" ADD CONSTRAINT "club_time_blocks_reason_known" CHECK ("club_time_blocks"."reason" IN ('time_off', 'training', 'other', 'event')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_time_blocks" VALIDATE CONSTRAINT "club_time_blocks_reason_known";--> statement-breakpoint
-- An event's closure is a resource's, carries its event, and nothing else does.
ALTER TABLE "club_time_blocks" ADD CONSTRAINT "club_time_blocks_event_reason" CHECK (("club_time_blocks"."reason" = 'event') = ("club_time_blocks"."event_id" IS NOT NULL)
	    AND ("club_time_blocks"."event_id" IS NULL OR "club_time_blocks"."resource_id" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_time_blocks" VALIDATE CONSTRAINT "club_time_blocks_event_reason";--> statement-breakpoint
ALTER TABLE "club_time_blocks" ADD CONSTRAINT "club_time_blocks_event_fk" FOREIGN KEY ("club_id","event_id") REFERENCES "public"."club_events"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "club_time_blocks_one_per_event" ON "club_time_blocks" USING btree ("event_id") WHERE "club_time_blocks"."event_id" IS NOT NULL;--> statement-breakpoint
-- An event's closure is written by its event's trigger and by nothing else —
-- no application path may reopen a court under a published tournament
-- (0048's claims guard pattern; a purge's cascade runs at depth 2 as well).
CREATE FUNCTION club_time_blocks_event_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF pg_trigger_depth() < 2 AND (
       (TG_OP IN ('INSERT', 'UPDATE') AND NEW.event_id IS NOT NULL)
    OR (TG_OP IN ('UPDATE', 'DELETE') AND OLD.event_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'club_time_blocks: an event''s closure is written by its event only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_time_blocks_event_owned';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_time_blocks_event_guard" BEFORE INSERT OR UPDATE OR DELETE ON "club_time_blocks" FOR EACH ROW EXECUTE FUNCTION club_time_blocks_event_guard();--> statement-breakpoint
-- A published event with a resource holds that resource for its span; a
-- draft or a cancelled one holds nothing. Re-written on every change of the
-- span, the resource or the status, so a moved event moves its closure (and
-- the calendar's EXCLUDE re-checks it).
CREATE FUNCTION club_events_resource_block() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- A save that does not move the event leaves its closure (and its claim)
    -- as it is: never re-checked against today's calendar (0048).
    IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.resource_id IS NOT DISTINCT FROM OLD.resource_id
       AND NEW.starts_at = OLD.starts_at AND NEW.ends_at = OLD.ends_at THEN
      RETURN NEW;
    END IF;
    DELETE FROM public.club_time_blocks WHERE club_id = OLD.club_id AND event_id = OLD.id;
  END IF;
  IF NEW.status = 'published' AND NEW.resource_id IS NOT NULL THEN
    INSERT INTO public.club_time_blocks (club_id, resource_id, starts_at, ends_at, reason, event_id,
                                         created_by)
    VALUES (NEW.club_id, NEW.resource_id, NEW.starts_at, NEW.ends_at, 'event', NEW.id, NEW.created_by);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_events_resource_block" AFTER INSERT OR UPDATE OF "status", "resource_id", "starts_at", "ends_at" ON "club_events" FOR EACH ROW EXECUTE FUNCTION club_events_resource_block();--> statement-breakpoint
-- ─── Every hold, for the payment page ───────────────────────────────────
CREATE VIEW "club_charge_holds" WITH (security_invoker = true) AS
  SELECT h.club_id, h.charge_id, h.hold_expires_at, 'reservation'::text AS source, h.id AS source_id
    FROM public.club_reservations h
   WHERE h.state = 'held' AND h.charge_id IS NOT NULL
  UNION ALL
  SELECT r.club_id, r.charge_id, r.hold_expires_at, 'event'::text AS source, r.id AS source_id
    FROM public.club_event_registrations r
   WHERE r.state = 'held' AND r.charge_id IS NOT NULL;--> statement-breakpoint
-- ─── Vocabulary ──────────────────────────────────────────────────────────
ALTER TABLE "club_charges" DROP CONSTRAINT "club_charges_kind_known";--> statement-breakpoint
ALTER TABLE "club_charges" ADD CONSTRAINT "club_charges_kind_known" CHECK ("club_charges"."kind" IN ('membership', 'drop_in', 'product', 'fee', 'reservation', 'wallet', 'event', 'other')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_charges" VALIDATE CONSTRAINT "club_charges_kind_known";--> statement-breakpoint
ALTER TABLE "club_notifications" DROP CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
ALTER TABLE "club_notifications" ADD CONSTRAINT "club_notifications_kind_known" CHECK ("club_notifications"."kind" IN (
	    'member_invite', 'staff_invite',
	    'booking_confirmed', 'booking_promoted', 'booking_cancelled', 'class_cancelled', 'reminder_24h',
	    'membership_expiring', 'membership_expired',
	    'application_received', 'application_approved', 'operator_new_application',
	    'claim_pending', 'erasure_requested',
	    'roster_daily', 'owner_weekly',
	    'membership_renewed', 'fee_charged', 'owner_monthly',
	    'payment_received',
	    'broadcast', 'automation',
	    'inbox_message', 'inbox_reply', 'leads_due',
	    'event_registered', 'event_promoted', 'event_cancelled')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_notifications" VALIDATE CONSTRAINT "club_notifications_kind_known";--> statement-breakpoint
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
	    'staff_profile_changed', 'preferences_changed',
	    'payment_account_connected', 'payment_account_disconnected', 'checkout_started',
	    'online_payment_received', 'online_refund_issued',
	    'resource_saved', 'resource_archived', 'hours_saved', 'service_saved', 'service_archived',
	    'reservation_created', 'reservation_cancelled',
	    'product_saved', 'product_archived', 'stock_moved', 'sale_recorded', 'sale_reversed',
	    'promotion_saved', 'promotion_archived',
	    'wallet_topped_up', 'invoice_issued', 'credit_note_issued',
	    'broadcast_saved', 'broadcast_scheduled', 'broadcast_cancelled', 'automation_saved',
	    'sms_settings_changed',
	    'thread_started', 'thread_closed', 'thread_reopened', 'inquiry_received',
	    'lead_opened', 'lead_updated', 'lead_lost', 'lead_reopened',
	    'feedback_settings_changed',
	    'event_saved', 'event_published', 'event_cancelled', 'event_registered',
	    'event_registration_cancelled')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_audit" VALIDATE CONSTRAINT "club_audit_action_known";--> statement-breakpoint
COMMENT ON TABLE "club_events" IS 'An event, camp, workshop or tournament of a club (0053), at one location, optionally closing one resource for its span. Cancelled, never deleted.';--> statement-breakpoint
COMMENT ON TABLE "club_event_tickets" IS 'A ticket type of a club event (0053): price, optional member price, optional capacity, audience. Archived, never deleted.';--> statement-breakpoint
COMMENT ON TABLE "club_event_registrations" IS 'One place at a club event (0053): ticket, client (SET NULL on erasure, the team name with it), arrival ticket (seq, the waitlist order), state, snapshotted price and free-cancel instant, when it was seated, charge. Seats are counted by trigger under the event lock.';--> statement-breakpoint
COMMENT ON VIEW "club_charge_holds" IS 'Every held court booking (0048) and event place (0053) with its charge: what a payment session must expire with.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
