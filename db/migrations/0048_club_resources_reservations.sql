-- 0048_club_resources_reservations: «Клубове» v2, wave C (plan 2026-10-25) —
-- courts, rooms and equipment as bookable resources, 1:1 appointments with a
-- trainer, opening hours, peak/off-peak and member pricing, and a calendar on
-- which DOUBLE BOOKING IS IMPOSSIBLE BY CONSTRUCTION (anolla's core; 1club's
-- appointments; vedro's rooms). Hand-written; do not regenerate.
--
-- WHAT THIS ADDS
--
--   club_resources          a court, room, pitch, lane or piece of equipment at
--                           a location. quantity = 1 is exclusive (one booking
--                           at a time); quantity > 1 is a pool (N rackets, N
--                           lanes sold as one), counted under a row lock.
--   club_location_hours     one opening interval per location and ISO weekday,
--                           in Sofia wall-clock time (a slot engine reads it
--                           through the DST-aware recurrence helpers).
--   club_time_blocks        0045's trainer leave now also closes a RESOURCE
--                           (maintenance, a tournament): exactly one of
--                           staff_user_id / resource_id.
--   club_classes.resource_id
--                           the room or court a class occupies; its scheduled
--                           occurrences claim it.
--   club_services           what members book: a `rental` (a resource for a
--                           length of time) or an `appointment` (a trainer,
--                           optionally with a resource). Durations, step,
--                           buffer, booking window (≤ 42 days — inside the
--                           8-week materialisation horizon, so every class is
--                           already on the calendar before anything can be
--                           booked against it), cancel deadline, price per
--                           hour or per booking, an optional member price.
--   club_service_resources / club_service_staff
--                           which resources and trainers a service may use.
--   club_price_rules        peak / off-peak (and member) prices by weekday and
--                           local time window; the highest priority wins.
--   club_staff_hours        when a trainer takes appointments, per location
--                           and weekday.
--   club_reservations       a booked slot: service, member (SET NULL on
--                           erasure — the slot stays booked, anonymised),
--                           resource and/or trainer (staff id BY VALUE, rule 5),
--                           the price, buffer and cancel deadline SNAPSHOTTED
--                           at booking, a state held | confirmed | cancelled |
--                           late_cancelled | expired. A payment on a held
--                           booking's charge confirms it (trigger on
--                           club_payments), wherever the money was taken.
--   club_calendar_claims    the one table every busy interval is written to —
--                           scheduled class occurrences (their class's
--                           resource), live reservations (resource + buffer,
--                           and trainer) and time blocks — maintained by
--                           triggers, never by application code (a guard
--                           refuses any other writer, and TRUNCATE). Two
--                           EXCLUDE constraints (btree_gist, installed by
--                           0021) refuse an overlapping claim on an exclusive
--                           resource and on a trainer with 23P01; a pool
--                           resource is refused at capacity by the claim
--                           function, which sums the UNITS each claim takes
--                           (a booking or class one, a block the whole pool).
--                           A resource's quantity may change: future claims
--                           are re-marked, and a pool cannot shrink below
--                           what is already booked.
--
--   Vocabulary: audit actions resource_saved, resource_archived, hours_saved,
--   service_saved, service_archived, reservation_created,
--   reservation_cancelled; charge kind `reservation`.
--
-- NOT CLAIMED: a trainer's classes. 0042 never refused overlapping class
-- assignments, so a constraint there could fail on existing data; the slot
-- engine reads the classes a trainer teaches as busy instead.
--
-- Assumptions: the pool check is correct under READ COMMITTED (the app's
-- level); it locks the resource row FOR NO KEY UPDATE — not FOR UPDATE, which
-- would deadlock against the FOR KEY SHARE every foreign-key check on that
-- row takes first. Claim triggers fire only when a booking's busy span or
-- targets change, so an erasure (member_id SET NULL), a payment confirming a
-- hold or attaching a charge never re-checks the past against today's
-- settings. A hold blocks its slot until five minutes past its expiry (a
-- payment made in its last moments arrives first); after that the sweep, or
-- the booking path itself, releases it, voids its charge and closes its
-- checkout in one transaction. A trainer whose account is deleted keeps their
-- confirmed future appointments (staff id by value) until the office cancels
-- them.
--
-- Locking: club_staff first (0039's order). ACCESS EXCLUSIVE on
-- club_time_blocks, club_classes, club_charges and club_audit (the two CHECK
-- swaps; VALIDATE scans club_charges and club_audit), SHARE ROW EXCLUSIVE on
-- clubs, club_locations, club_members, club_class_occurrences and
-- club_payments for the new foreign keys and triggers. Small tables, one
-- transaction: deploy at a quiet hour, never during a club purge; a red deploy
-- is simply re-run. A payment being recorded at that moment (a desk, or the
-- worker applying a webhook) may meet this file head-on over club_charges and
-- club_payments — no order of these statements avoids it, because the desk
-- and the webhook take the two tables in opposite orders. Postgres aborts one
-- side after ~1 s: the deploy is re-run, pg-boss retries the job, or the
-- cashier's form fails and is sent again (nothing was recorded, so nothing
-- is recorded twice). Existing
-- time blocks are claimed by the backfill at the end; staff leave that
-- overlaps itself would make it fail — a pre-check names the clash first.
--
-- rollback (after reverting the application), in ONE explicit transaction, at
-- a quiet hour — it takes ACCESS EXCLUSIVE across the clubs tables and may
-- meet a payment the same way (re-run it):
--   SET LOCAL lock_timeout = '3s';
--   DROP TRIGGER "club_payments_confirm_hold" ON "club_payments";
--   DROP FUNCTION club_payments_confirm_hold();
--   DROP TRIGGER "club_reservations_claims" ON "club_reservations";
--   DROP TRIGGER "club_class_occurrences_claims" ON "club_class_occurrences";
--   DROP TRIGGER "club_classes_resource_claims" ON "club_classes";
--   DROP TRIGGER "club_time_blocks_claims" ON "club_time_blocks";
--   DROP TRIGGER "club_resources_quantity_claims" ON "club_resources";
--   DROP TRIGGER "club_reservations_no_truncate" ON "club_reservations";
--   DROP TRIGGER "club_reservations_guard" ON "club_reservations";
--   DROP TABLE "club_calendar_claims";              -- derived, rebuilt by triggers
--   DROP TABLE "club_reservations";                 -- DESTRUCTIVE: every booking
--   DROP TABLE "club_price_rules", "club_service_staff", "club_service_resources",
--     "club_staff_hours", "club_services", "club_location_hours";
--   DELETE FROM "club_time_blocks" WHERE "resource_id" IS NOT NULL;  -- DESTRUCTIVE
--   ALTER TABLE "club_time_blocks" DROP CONSTRAINT "club_time_blocks_one_target",
--     DROP COLUMN "resource_id", ALTER COLUMN "staff_user_id" SET NOT NULL;
--   ALTER TABLE "club_classes" DROP COLUMN "resource_id";
--   DROP TABLE "club_resources";
--   -- Functions last: the tables' triggers and CHECKs depend on them.
--   DROP FUNCTION club_claims_for_reservation(), club_claims_for_occurrence(),
--     club_claims_for_class(), club_claims_for_block(), club_claims_for_quantity(),
--     club_calendar_claims_guard(), club_calendar_no_truncate(), club_reservations_guard(),
--     club_claim_resource(uuid, uuid, tstzrange, integer, text, uuid),
--     club_weekdays_valid(smallint[]);
--   The widened club_audit_action_known and club_charges_kind_known STAY (a
--   superset is harmless; the audit log is append-only and charges are only
--   voided, so their rows cannot be removed). `reservation` charges remain as
--   open money the reverted application must still display and settle.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
CREATE TABLE "club_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_resources_club_id_unique" UNIQUE("club_id", "id"),
	-- A class claims only a resource at its own location (club_classes FK).
	CONSTRAINT "club_resources_location_unique" UNIQUE("club_id", "location_id", "id"),
	CONSTRAINT "club_resources_kind_known" CHECK ("club_resources"."kind" IN ('court', 'room', 'pitch', 'lane', 'equipment', 'other')),
	CONSTRAINT "club_resources_name_sane" CHECK (btrim("club_resources"."name") <> '' AND char_length("club_resources"."name") <= 80),
	CONSTRAINT "club_resources_quantity_sane" CHECK ("club_resources"."quantity" BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "club_resources" ADD CONSTRAINT "club_resources_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_resources" ADD CONSTRAINT "club_resources_location_fk" FOREIGN KEY ("club_id","location_id") REFERENCES "public"."club_locations"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_resources_location_idx" ON "club_resources" USING btree ("club_id","location_id","sort_order");--> statement-breakpoint
CREATE TRIGGER "club_resources_set_updated_at" BEFORE UPDATE ON "club_resources" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TABLE "club_location_hours" (
	"club_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"opens" time NOT NULL,
	"closes" time NOT NULL,
	CONSTRAINT "club_location_hours_pkey" PRIMARY KEY("club_id", "location_id", "weekday"),
	CONSTRAINT "club_location_hours_weekday_sane" CHECK ("club_location_hours"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "club_location_hours_order" CHECK ("club_location_hours"."closes" > "club_location_hours"."opens")
);
--> statement-breakpoint
ALTER TABLE "club_location_hours" ADD CONSTRAINT "club_location_hours_location_fk" FOREIGN KEY ("club_id","location_id") REFERENCES "public"."club_locations"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_time_blocks" ALTER COLUMN "staff_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "club_time_blocks" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
ALTER TABLE "club_time_blocks" ADD CONSTRAINT "club_time_blocks_one_target" CHECK (num_nonnulls("club_time_blocks"."staff_user_id", "club_time_blocks"."resource_id") = 1) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_time_blocks" VALIDATE CONSTRAINT "club_time_blocks_one_target";--> statement-breakpoint
ALTER TABLE "club_time_blocks" ADD CONSTRAINT "club_time_blocks_resource_fk" FOREIGN KEY ("club_id","resource_id") REFERENCES "public"."club_resources"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_time_blocks_resource_idx" ON "club_time_blocks" USING btree ("club_id","resource_id","starts_at") WHERE "club_time_blocks"."resource_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "club_classes" ADD COLUMN "resource_id" uuid;--> statement-breakpoint
ALTER TABLE "club_classes" ADD CONSTRAINT "club_classes_resource_fk" FOREIGN KEY ("club_id","location_id","resource_id") REFERENCES "public"."club_resources"("club_id","location_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_classes_resource_idx" ON "club_classes" USING btree ("club_id","resource_id") WHERE "club_classes"."resource_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE "club_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name_bg" text NOT NULL,
	"name_en" text,
	"description_bg" text,
	"description_en" text,
	"duration_min" integer NOT NULL,
	"duration_max" integer NOT NULL,
	"step_minutes" integer DEFAULT 30 NOT NULL,
	"buffer_minutes" integer DEFAULT 0 NOT NULL,
	"price_unit" text DEFAULT 'hour' NOT NULL,
	"price_cents" integer NOT NULL,
	"member_price_cents" integer,
	"booking_window_days" integer DEFAULT 14 NOT NULL,
	"cancel_deadline_hours" integer DEFAULT 24 NOT NULL,
	"max_upcoming_per_member" integer DEFAULT 4 NOT NULL,
	"payment" text DEFAULT 'desk' NOT NULL,
	"audience" text DEFAULT 'all' NOT NULL,
	"visibility" text DEFAULT 'public' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_services_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_services_kind_known" CHECK ("club_services"."kind" IN ('rental', 'appointment')),
	CONSTRAINT "club_services_names_sane" CHECK (btrim("club_services"."name_bg") <> '' AND char_length("club_services"."name_bg") <= 80
	      AND ("club_services"."name_en" IS NULL OR (btrim("club_services"."name_en") <> '' AND char_length("club_services"."name_en") <= 80))),
	CONSTRAINT "club_services_descriptions_sane" CHECK (("club_services"."description_bg" IS NULL OR (btrim("club_services"."description_bg") <> '' AND char_length("club_services"."description_bg") <= 500))
	      AND ("club_services"."description_en" IS NULL OR (btrim("club_services"."description_en") <> '' AND char_length("club_services"."description_en") <= 500))),
	-- Lengths in whole steps: a court sold 60–120 minutes in 30-minute steps.
	CONSTRAINT "club_services_durations_sane" CHECK ("club_services"."step_minutes" BETWEEN 5 AND 240
	      AND "club_services"."duration_min" BETWEEN 15 AND 720
	      AND "club_services"."duration_max" BETWEEN "club_services"."duration_min" AND 720
	      AND ("club_services"."duration_max" - "club_services"."duration_min") % "club_services"."step_minutes" = 0),
	CONSTRAINT "club_services_buffer_sane" CHECK ("club_services"."buffer_minutes" BETWEEN 0 AND 120),
	CONSTRAINT "club_services_price_unit_known" CHECK ("club_services"."price_unit" IN ('hour', 'booking')),
	CONSTRAINT "club_services_prices_sane" CHECK ("club_services"."price_cents" BETWEEN 0 AND 10000000
	      AND ("club_services"."member_price_cents" IS NULL OR "club_services"."member_price_cents" BETWEEN 0 AND 10000000)),
	-- 42 days: inside the 8-week class materialisation horizon (see header).
	CONSTRAINT "club_services_window_sane" CHECK ("club_services"."booking_window_days" BETWEEN 1 AND 42),
	CONSTRAINT "club_services_cancel_sane" CHECK ("club_services"."cancel_deadline_hours" BETWEEN 0 AND 168),
	-- How many upcoming bookings of this service one account may hold online
	-- (the desk is not capped): without it one account could empty a calendar.
	CONSTRAINT "club_services_upcoming_cap_sane" CHECK ("club_services"."max_upcoming_per_member" BETWEEN 1 AND 50),
	CONSTRAINT "club_services_payment_known" CHECK ("club_services"."payment" IN ('desk', 'online_optional', 'online_required')),
	CONSTRAINT "club_services_audience_known" CHECK ("club_services"."audience" IN ('all', 'adults', 'minors')),
	CONSTRAINT "club_services_visibility_known" CHECK ("club_services"."visibility" IN ('public', 'private'))
);
--> statement-breakpoint
ALTER TABLE "club_services" ADD CONSTRAINT "club_services_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_services" ADD CONSTRAINT "club_services_location_fk" FOREIGN KEY ("club_id","location_id") REFERENCES "public"."club_locations"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_services_club_idx" ON "club_services" USING btree ("club_id","sort_order") WHERE "club_services"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "club_services_location_idx" ON "club_services" USING btree ("club_id","location_id");--> statement-breakpoint
CREATE TRIGGER "club_services_set_updated_at" BEFORE UPDATE ON "club_services" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TABLE "club_service_resources" (
	"club_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	CONSTRAINT "club_service_resources_pkey" PRIMARY KEY("club_id", "service_id", "resource_id")
);
--> statement-breakpoint
ALTER TABLE "club_service_resources" ADD CONSTRAINT "club_service_resources_service_fk" FOREIGN KEY ("club_id","service_id") REFERENCES "public"."club_services"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_service_resources" ADD CONSTRAINT "club_service_resources_resource_fk" FOREIGN KEY ("club_id","resource_id") REFERENCES "public"."club_resources"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_service_resources_resource_idx" ON "club_service_resources" USING btree ("club_id","resource_id");--> statement-breakpoint
CREATE TABLE "club_service_staff" (
	"club_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"staff_user_id" text NOT NULL,
	CONSTRAINT "club_service_staff_pkey" PRIMARY KEY("club_id", "service_id", "staff_user_id")
);
--> statement-breakpoint
ALTER TABLE "club_service_staff" ADD CONSTRAINT "club_service_staff_service_fk" FOREIGN KEY ("club_id","service_id") REFERENCES "public"."club_services"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A trainer who leaves the club stops being offered; past reservations keep
-- their staff id by value.
ALTER TABLE "club_service_staff" ADD CONSTRAINT "club_service_staff_staff_fk" FOREIGN KEY ("club_id","staff_user_id") REFERENCES "public"."club_staff"("club_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_service_staff_staff_idx" ON "club_service_staff" USING btree ("club_id","staff_user_id");--> statement-breakpoint
-- One-dimensional, 1..7, no repeats — a CHECK cannot hold the subquery.
CREATE FUNCTION club_weekdays_valid(w smallint[]) RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT array_ndims(w) = 1 AND cardinality(w) BETWEEN 1 AND 7
     AND w <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]
     AND cardinality(w) = (SELECT count(DISTINCT x) FROM unnest(w) AS x)
$$;--> statement-breakpoint
CREATE TABLE "club_price_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"weekdays" smallint[] NOT NULL,
	"from_local" time NOT NULL,
	"to_local" time NOT NULL,
	"price_cents" integer NOT NULL,
	"member_price_cents" integer,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_price_rules_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_price_rules_weekdays_sane" CHECK (club_weekdays_valid("club_price_rules"."weekdays")),
	CONSTRAINT "club_price_rules_window_order" CHECK ("club_price_rules"."to_local" > "club_price_rules"."from_local"),
	CONSTRAINT "club_price_rules_prices_sane" CHECK ("club_price_rules"."price_cents" BETWEEN 0 AND 10000000
	      AND ("club_price_rules"."member_price_cents" IS NULL OR "club_price_rules"."member_price_cents" BETWEEN 0 AND 10000000)),
	CONSTRAINT "club_price_rules_priority_sane" CHECK ("club_price_rules"."priority" BETWEEN -100 AND 100)
);
--> statement-breakpoint
ALTER TABLE "club_price_rules" ADD CONSTRAINT "club_price_rules_service_fk" FOREIGN KEY ("club_id","service_id") REFERENCES "public"."club_services"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_price_rules_service_idx" ON "club_price_rules" USING btree ("club_id","service_id");--> statement-breakpoint
CREATE TABLE "club_staff_hours" (
	"club_id" uuid NOT NULL,
	"staff_user_id" text NOT NULL,
	"location_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"opens" time NOT NULL,
	"closes" time NOT NULL,
	CONSTRAINT "club_staff_hours_pkey" PRIMARY KEY("club_id", "staff_user_id", "location_id", "weekday"),
	CONSTRAINT "club_staff_hours_weekday_sane" CHECK ("club_staff_hours"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "club_staff_hours_order" CHECK ("club_staff_hours"."closes" > "club_staff_hours"."opens")
);
--> statement-breakpoint
ALTER TABLE "club_staff_hours" ADD CONSTRAINT "club_staff_hours_staff_fk" FOREIGN KEY ("club_id","staff_user_id") REFERENCES "public"."club_staff"("club_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_staff_hours" ADD CONSTRAINT "club_staff_hours_location_fk" FOREIGN KEY ("club_id","location_id") REFERENCES "public"."club_locations"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_staff_hours_location_idx" ON "club_staff_hours" USING btree ("club_id","location_id");--> statement-breakpoint
CREATE TABLE "club_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"member_id" uuid,
	"resource_id" uuid,
	"staff_user_id" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"buffer_minutes" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'confirmed' NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"price_cents" integer NOT NULL,
	"cancel_deadline_hours" integer NOT NULL,
	"charge_id" uuid,
	"booked_by" text,
	"cancel_kind" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_reservations_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_reservations_window_sane" CHECK (isfinite("club_reservations"."starts_at") AND isfinite("club_reservations"."ends_at")
	      AND "club_reservations"."ends_at" > "club_reservations"."starts_at"
	      AND "club_reservations"."ends_at" - "club_reservations"."starts_at" <= interval '12 hours'),
	CONSTRAINT "club_reservations_buffer_sane" CHECK ("club_reservations"."buffer_minutes" BETWEEN 0 AND 120),
	CONSTRAINT "club_reservations_state_known" CHECK ("club_reservations"."state" IN ('held', 'confirmed', 'cancelled', 'late_cancelled', 'expired')),
	CONSTRAINT "club_reservations_hold_pair" CHECK (("club_reservations"."state" = 'held') = ("club_reservations"."hold_expires_at" IS NOT NULL)),
	CONSTRAINT "club_reservations_cancel_facts" CHECK ((("club_reservations"."state" IN ('cancelled', 'late_cancelled')) = ("club_reservations"."cancelled_at" IS NOT NULL))
	      AND (("club_reservations"."state" IN ('cancelled', 'late_cancelled')) = ("club_reservations"."cancel_kind" IS NOT NULL))
	      AND ("club_reservations"."cancel_kind" IS NULL OR "club_reservations"."cancel_kind" IN ('member', 'staff'))),
	CONSTRAINT "club_reservations_price_sane" CHECK ("club_reservations"."price_cents" BETWEEN 0 AND 10000000),
	-- Snapshotted like the price: a deadline the member never saw never binds them.
	CONSTRAINT "club_reservations_cancel_sane" CHECK ("club_reservations"."cancel_deadline_hours" BETWEEN 0 AND 168),
	-- A reservation takes something: a resource, a trainer, or both. Neither
	-- is ever nulled by a cascade (resources are archived; staff by value).
	CONSTRAINT "club_reservations_takes_something" CHECK (num_nonnulls("club_reservations"."resource_id", "club_reservations"."staff_user_id") >= 1)
);
--> statement-breakpoint
ALTER TABLE "club_reservations" ADD CONSTRAINT "club_reservations_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_reservations" ADD CONSTRAINT "club_reservations_service_fk" FOREIGN KEY ("club_id","service_id") REFERENCES "public"."club_services"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Erasing the client keeps the slot (the club's calendar, its books), anonymised.
ALTER TABLE "club_reservations" ADD CONSTRAINT "club_reservations_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE set null ("member_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_reservations" ADD CONSTRAINT "club_reservations_resource_fk" FOREIGN KEY ("club_id","resource_id") REFERENCES "public"."club_resources"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_reservations" ADD CONSTRAINT "club_reservations_charge_fk" FOREIGN KEY ("club_id","charge_id") REFERENCES "public"."club_charges"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_reservations_day_idx" ON "club_reservations" USING btree ("club_id","starts_at");--> statement-breakpoint
CREATE INDEX "club_reservations_member_idx" ON "club_reservations" USING btree ("club_id","member_id") WHERE "club_reservations"."member_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_reservations_service_idx" ON "club_reservations" USING btree ("club_id","service_id");--> statement-breakpoint
CREATE INDEX "club_reservations_resource_idx" ON "club_reservations" USING btree ("club_id","resource_id","starts_at") WHERE "club_reservations"."resource_id" IS NOT NULL;--> statement-breakpoint
-- One booking per charge: cancelling voids it, paying confirms it — a shared
-- charge would do both to a booking nobody touched.
CREATE UNIQUE INDEX "club_reservations_charge_idx" ON "club_reservations" USING btree ("club_id","charge_id") WHERE "club_reservations"."charge_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_reservations_holds_idx" ON "club_reservations" USING btree ("hold_expires_at") WHERE "club_reservations"."state" = 'held';--> statement-breakpoint
CREATE TRIGGER "club_reservations_set_updated_at" BEFORE UPDATE ON "club_reservations" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- What was booked is a fact: the price, buffer, cancel deadline and length
-- are the snapshot the member agreed to; the row's identity never changes
-- (its claims point at it by id); the charge is attached once and never
-- re-pointed (every hold path locks charge → reservation, and a moved charge
-- would reverse that order); the client may only be cleared, by erasure.
-- States move only forward: held → confirmed | cancelled | expired, confirmed →
-- cancelled | late_cancelled. An ended booking (its slot may already be
-- resold, and refunds and reports read it) changes in nothing but the
-- erasure of its client. A live booking's time, resource and trainer may
-- still move — the claim triggers re-check.
CREATE FUNCTION club_reservations_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  probe public.club_reservations%ROWTYPE;
BEGIN
  IF OLD.state IN ('cancelled', 'late_cancelled', 'expired') THEN
    probe := NEW;
    probe.member_id := OLD.member_id;
    probe.updated_at := OLD.updated_at;
    IF probe IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'club_reservations: an ended booking stays as it ended'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_reservations_booked_terms';
    END IF;
  ELSIF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.club_id IS DISTINCT FROM OLD.club_id OR NEW.service_id IS DISTINCT FROM OLD.service_id
     OR NEW.price_cents IS DISTINCT FROM OLD.price_cents
     OR NEW.buffer_minutes IS DISTINCT FROM OLD.buffer_minutes
     OR NEW.cancel_deadline_hours IS DISTINCT FROM OLD.cancel_deadline_hours
     OR NEW.booked_by IS DISTINCT FROM OLD.booked_by
     OR (NEW.ends_at - NEW.starts_at) IS DISTINCT FROM (OLD.ends_at - OLD.starts_at)
     OR (OLD.charge_id IS NOT NULL AND NEW.charge_id IS DISTINCT FROM OLD.charge_id)
     OR (NEW.state = 'held' AND OLD.state <> 'held')
     OR (NEW.state = 'expired' AND OLD.state <> 'held')
     OR (NEW.state = 'late_cancelled' AND OLD.state <> 'confirmed') THEN
    RAISE EXCEPTION 'club_reservations: what was booked never changes, and states only move forward'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_reservations_booked_terms';
  END IF;
  IF NEW.member_id IS DISTINCT FROM OLD.member_id AND NEW.member_id IS NOT NULL THEN
    RAISE EXCEPTION 'club_reservations: the client may only be cleared'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_reservations_booked_terms';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_reservations_guard" BEFORE UPDATE ON "club_reservations" FOR EACH ROW EXECUTE FUNCTION club_reservations_guard();--> statement-breakpoint
CREATE TABLE "club_calendar_claims" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
	"club_id" uuid NOT NULL,
	"resource_id" uuid,
	"staff_user_id" text,
	"exclusive" boolean NOT NULL,
	-- How many units of a pool this claim takes (a block takes them all).
	"units" integer DEFAULT 1 NOT NULL,
	"during" tstzrange NOT NULL,
	"source" text NOT NULL,
	"source_id" uuid NOT NULL,
	CONSTRAINT "club_calendar_claims_one_target" CHECK (num_nonnulls("club_calendar_claims"."resource_id", "club_calendar_claims"."staff_user_id") = 1),
	CONSTRAINT "club_calendar_claims_units_sane" CHECK ("club_calendar_claims"."units" BETWEEN 1 AND 500),
	CONSTRAINT "club_calendar_claims_source_known" CHECK ("club_calendar_claims"."source" IN ('occurrence', 'reservation', 'block')),
	CONSTRAINT "club_calendar_claims_during_sane" CHECK (NOT isempty("club_calendar_claims"."during") AND NOT lower_inf("club_calendar_claims"."during") AND NOT upper_inf("club_calendar_claims"."during")),
	-- THE RULE: one claim at a time on an exclusive resource, and on a trainer.
	CONSTRAINT "club_calendar_claims_resource_free" EXCLUDE USING gist ("resource_id" WITH =, "during" WITH &&) WHERE ("resource_id" IS NOT NULL AND "exclusive"),
	CONSTRAINT "club_calendar_claims_staff_free" EXCLUDE USING gist ("club_id" WITH =, "staff_user_id" WITH =, "during" WITH &&) WHERE ("staff_user_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "club_calendar_claims" ADD CONSTRAINT "club_calendar_claims_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_calendar_claims" ADD CONSTRAINT "club_calendar_claims_resource_fk" FOREIGN KEY ("club_id","resource_id") REFERENCES "public"."club_resources"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_calendar_claims_source_idx" ON "club_calendar_claims" USING btree ("source","source_id");--> statement-breakpoint
-- Every resource read (pool counts, availability, the FK cascade) and the
-- purge's club_id cascade use these; the EXCLUDE indexes are partial.
CREATE INDEX "club_calendar_claims_resource_idx" ON "club_calendar_claims" USING gist ("resource_id", "during") WHERE "resource_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_calendar_claims_club_idx" ON "club_calendar_claims" USING gist ("club_id", "during");--> statement-breakpoint
-- Written ONLY by the claim triggers (depth ≥ 2) and foreign-key cascades
-- (run by the system's own triggers); a direct statement would silently
-- re-open double booking.
CREATE FUNCTION club_calendar_claims_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'club_calendar_claims is written only by the calendar triggers';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;--> statement-breakpoint
CREATE FUNCTION club_calendar_no_truncate() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated: the calendar''s claims are derived row by row', TG_TABLE_NAME;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_calendar_claims_no_truncate" BEFORE TRUNCATE ON "club_calendar_claims" FOR EACH STATEMENT EXECUTE FUNCTION club_calendar_no_truncate();--> statement-breakpoint
CREATE TRIGGER "club_reservations_no_truncate" BEFORE TRUNCATE ON "club_reservations" FOR EACH STATEMENT EXECUTE FUNCTION club_calendar_no_truncate();--> statement-breakpoint
-- Claim a resource for an interval: an exclusive one through the EXCLUDE, a
-- pool under a lock on its row, refused once the units taken at some moment
-- of the interval (the most concurrent instant, not a mere overlap count)
-- plus this claim's would exceed the pool. FOR NO KEY UPDATE serialises the
-- count without deadlocking against the FOR KEY SHARE of the writer's own
-- foreign-key check on the same row. Called only by the claim triggers.
CREATE FUNCTION club_claim_resource(p_club uuid, p_resource uuid, p_during tstzrange, p_units integer, p_source text, p_source_id uuid) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  pool integer;
  busiest integer;
  taking integer;
BEGIN
  SELECT r.quantity INTO pool FROM public.club_resources r
   WHERE r.club_id = p_club AND r.id = p_resource
     FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RETURN;  -- the foreign key reports it as 23503
  END IF;
  -- A block (p_units NULL) takes the whole resource.
  taking := least(coalesce(p_units, pool), pool);
  IF pool > 1 THEN
    SELECT coalesce(max((SELECT sum(c2.units) FROM public.club_calendar_claims c2
                          WHERE c2.resource_id = p_resource AND c2.during @> pt.at)), 0)
      INTO busiest
      FROM (SELECT lower(p_during) AS at
            UNION
            SELECT lower(c.during) FROM public.club_calendar_claims c
             WHERE c.resource_id = p_resource AND c.during && p_during
               AND lower(c.during) > lower(p_during)) pt;
    IF busiest + taking > pool THEN
      RAISE EXCEPTION 'every unit of this resource is taken at that time'
        USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'club_calendar_claims_pool_full';
    END IF;
  END IF;
  INSERT INTO public.club_calendar_claims (club_id, resource_id, exclusive, units, during, source, source_id)
  VALUES (p_club, p_resource, pool = 1, taking, p_during, p_source, p_source_id);
END;
$$;--> statement-breakpoint
CREATE FUNCTION club_claims_for_reservation() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  span tstzrange;
BEGIN
  -- Live before and after, same span and targets (a hold confirmed by its
  -- payment): the claim stands as it is — nothing is re-checked.
  IF TG_OP = 'UPDATE' AND OLD.state IN ('held', 'confirmed') AND NEW.state IN ('held', 'confirmed')
     AND OLD.starts_at = NEW.starts_at AND OLD.ends_at = NEW.ends_at
     AND OLD.buffer_minutes = NEW.buffer_minutes
     AND OLD.resource_id IS NOT DISTINCT FROM NEW.resource_id
     AND OLD.staff_user_id IS NOT DISTINCT FROM NEW.staff_user_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    DELETE FROM public.club_calendar_claims WHERE source = 'reservation' AND source_id = OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.state NOT IN ('held', 'confirmed') THEN
    RETURN NEW;
  END IF;
  -- The resource is taken through the buffer (turnover, cleaning); the
  -- trainer only for the session itself.
  span := tstzrange(NEW.starts_at, NEW.ends_at + make_interval(mins => NEW.buffer_minutes), '[)');
  IF NEW.resource_id IS NOT NULL THEN
    PERFORM public.club_claim_resource(NEW.club_id, NEW.resource_id, span, 1, 'reservation', NEW.id);
  END IF;
  IF NEW.staff_user_id IS NOT NULL THEN
    INSERT INTO public.club_calendar_claims (club_id, staff_user_id, exclusive, during, source, source_id)
    VALUES (NEW.club_id, NEW.staff_user_id, true, tstzrange(NEW.starts_at, NEW.ends_at, '[)'), 'reservation', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Not on every UPDATE: an erasure (member_id SET NULL) or a charge attached
-- must never re-run the claim against today's settings.
CREATE TRIGGER "club_reservations_claims" AFTER INSERT OR DELETE OR UPDATE OF "state", "starts_at", "ends_at", "buffer_minutes", "resource_id", "staff_user_id" ON "club_reservations" FOR EACH ROW EXECUTE FUNCTION club_claims_for_reservation();--> statement-breakpoint
-- Money on a held booking's charge — online or at the desk — confirms it, so
-- a hold the club was paid for is never released by the sweep. It runs after
-- 0041's within-charge trigger has locked the charge, so the lock order is
-- charge → reservation, the order every hold path uses.
CREATE FUNCTION club_payments_confirm_hold() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.club_reservations SET state = 'confirmed', hold_expires_at = NULL
   WHERE club_id = NEW.club_id AND charge_id = NEW.charge_id AND state = 'held';
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_payments_confirm_hold" AFTER INSERT ON "club_payments" FOR EACH ROW WHEN (NEW.kind = 'payment') EXECUTE FUNCTION club_payments_confirm_hold();--> statement-breakpoint
CREATE FUNCTION club_claims_for_occurrence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  room uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    DELETE FROM public.club_calendar_claims WHERE source = 'occurrence' AND source_id = OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.status <> 'scheduled' THEN
    RETURN NEW;
  END IF;
  SELECT k.resource_id INTO room FROM public.club_classes k
   WHERE k.club_id = NEW.club_id AND k.id = NEW.class_id;
  IF room IS NOT NULL THEN
    PERFORM public.club_claim_resource(NEW.club_id, room, tstzrange(NEW.starts_at, NEW.ends_at, '[)'),
                                       1, 'occurrence', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_class_occurrences_claims" AFTER INSERT OR UPDATE OF "starts_at", "ends_at", "status" OR DELETE ON "club_class_occurrences" FOR EACH ROW EXECUTE FUNCTION club_claims_for_occurrence();--> statement-breakpoint
-- A class moved to another room (or out of one) re-claims its FUTURE
-- scheduled occurrences; the past keeps its history.
CREATE FUNCTION club_claims_for_class() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  occ record;
BEGIN
  DELETE FROM public.club_calendar_claims c
   USING public.club_class_occurrences o
   WHERE c.source = 'occurrence' AND c.source_id = o.id
     AND o.club_id = NEW.club_id AND o.class_id = NEW.id AND o.starts_at > now();
  IF NEW.resource_id IS NOT NULL THEN
    FOR occ IN
      SELECT o.id, o.starts_at, o.ends_at FROM public.club_class_occurrences o
       WHERE o.club_id = NEW.club_id AND o.class_id = NEW.id AND o.status = 'scheduled'
         AND o.starts_at > now()
       ORDER BY o.starts_at
    LOOP
      PERFORM public.club_claim_resource(NEW.club_id, NEW.resource_id,
                                         tstzrange(occ.starts_at, occ.ends_at, '[)'), 1, 'occurrence', occ.id);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_classes_resource_claims" AFTER UPDATE OF "resource_id" ON "club_classes" FOR EACH ROW WHEN (OLD.resource_id IS DISTINCT FROM NEW.resource_id) EXECUTE FUNCTION club_claims_for_class();--> statement-breakpoint
CREATE FUNCTION club_claims_for_block() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    DELETE FROM public.club_calendar_claims WHERE source = 'block' AND source_id = OLD.id;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.resource_id IS NOT NULL THEN
    -- A block closes the resource: every unit of a pool.
    PERFORM public.club_claim_resource(NEW.club_id, NEW.resource_id,
                                       tstzrange(NEW.starts_at, NEW.ends_at, '[)'), NULL, 'block', NEW.id);
  ELSE
    INSERT INTO public.club_calendar_claims (club_id, staff_user_id, exclusive, during, source, source_id)
    VALUES (NEW.club_id, NEW.staff_user_id, true, tstzrange(NEW.starts_at, NEW.ends_at, '[)'), 'block', NEW.id);
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_time_blocks_claims" AFTER INSERT OR DELETE OR UPDATE OF "starts_at", "ends_at", "staff_user_id", "resource_id" ON "club_time_blocks" FOR EACH ROW EXECUTE FUNCTION club_claims_for_block();--> statement-breakpoint
-- A resource's quantity may change. Its future claims are re-marked
-- exclusive or not (the EXCLUDE then re-checks each exclusive one), and a
-- pool may not shrink below what is already booked at any moment.
CREATE FUNCTION club_claims_for_quantity() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  busiest integer;
BEGIN
  -- A closure takes every unit of the pool, however many there now are; a
  -- booking keeps its one.
  UPDATE public.club_calendar_claims
     SET exclusive = (NEW.quantity = 1),
         units = CASE WHEN source = 'block' THEN NEW.quantity ELSE least(units, NEW.quantity) END
   WHERE resource_id = NEW.id AND upper(during) > now();
  IF NEW.quantity > 1 THEN
    -- Measured only at moments still to come: overlap that has already
    -- ended refuses nothing.
    SELECT coalesce(max((SELECT sum(c2.units) FROM public.club_calendar_claims c2
                          WHERE c2.resource_id = NEW.id
                            AND c2.during @> greatest(lower(c.during), now()))), 0)
      INTO busiest
      FROM public.club_calendar_claims c
     WHERE c.resource_id = NEW.id AND upper(c.during) > now();
    IF busiest > NEW.quantity THEN
      RAISE EXCEPTION 'more units are already booked at one time than the new quantity'
        USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'club_calendar_claims_pool_full';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_resources_quantity_claims" AFTER UPDATE OF "quantity" ON "club_resources" FOR EACH ROW WHEN (OLD.quantity IS DISTINCT FROM NEW.quantity) EXECUTE FUNCTION club_claims_for_quantity();--> statement-breakpoint
-- Backfill: the trainer leave 0045 already holds is busy time from now on.
-- Leave that overlaps itself cannot be claimed twice; name the clash first.
DO $$
DECLARE
  clash record;
BEGIN
  SELECT a.club_id, a.id AS first_id, b.id AS second_id INTO clash
    FROM "club_time_blocks" a
    JOIN "club_time_blocks" b ON b.club_id = a.club_id AND b.staff_user_id = a.staff_user_id
                             AND a.id < b.id
                             AND tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION '0048: overlapping staff leave in club % (blocks % and %) — merge them first',
      clash.club_id, clash.first_id, clash.second_id;
  END IF;
END;
$$;--> statement-breakpoint
INSERT INTO "club_calendar_claims" (club_id, staff_user_id, exclusive, during, source, source_id)
SELECT b.club_id, b.staff_user_id, true, tstzrange(b.starts_at, b.ends_at, '[)'), 'block', b.id
  FROM "club_time_blocks" b
 WHERE b.staff_user_id IS NOT NULL;--> statement-breakpoint
-- From here on, only the claim triggers write the calendar.
CREATE TRIGGER "club_calendar_claims_guard" BEFORE INSERT OR UPDATE OR DELETE ON "club_calendar_claims" FOR EACH ROW EXECUTE FUNCTION club_calendar_claims_guard();--> statement-breakpoint

ALTER TABLE "club_charges" DROP CONSTRAINT "club_charges_kind_known";--> statement-breakpoint
ALTER TABLE "club_charges" ADD CONSTRAINT "club_charges_kind_known" CHECK ("club_charges"."kind" IN ('membership', 'drop_in', 'product', 'fee', 'reservation', 'other')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_charges" VALIDATE CONSTRAINT "club_charges_kind_known";--> statement-breakpoint
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
	    'reservation_created', 'reservation_cancelled')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_audit" VALIDATE CONSTRAINT "club_audit_action_known";--> statement-breakpoint
COMMENT ON TABLE "club_resources" IS 'A bookable court, room, pitch, lane or piece of equipment at a club location (0048). quantity 1 = one booking at a time; >1 = a pool counted under a row lock. Archived, never deleted, once booked.';--> statement-breakpoint
COMMENT ON TABLE "club_reservations" IS 'A booked slot (0048): service, member (SET NULL on erasure), resource and/or trainer (staff id by value); price, buffer and cancel deadline snapshotted at booking and guarded; a payment on its charge confirms a hold (trigger on club_payments). Its busy time lives in club_calendar_claims, written by trigger.';--> statement-breakpoint
COMMENT ON TABLE "club_calendar_claims" IS 'Every busy interval on a club resource or trainer (0048), written ONLY by triggers on reservations, class occurrences and time blocks. Two EXCLUDE constraints make double booking impossible; a pool resource is refused at capacity by club_claim_resource. Derived: rebuilt from its sources, never edited.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
