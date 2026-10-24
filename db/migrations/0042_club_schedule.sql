-- 0042_club_schedule: a club's classes, their materialized occurrences, and
-- bookings with a waitlist — the play-session engine of 0008, re-used for a
-- club's own timetable.
--
-- SAME ENGINE, SAME GUARANTEES. Everything 0008's header argues holds here and
-- is not repeated at length:
--   * starts_at_local is a WALL CLOCK reading and rrule is expanded against it
--     in civil arithmetic (lib/src/recurrence), so a Tuesday 18:00 class stays
--     18:00 across both DST transitions. club_class_occurrences stores the
--     instant AND the wall clock, verified by a TRIGGER against this server's
--     tz database (a CHECK cannot call the STABLE timezone()).
--   * the rrule CHECKs are 0008's play_sessions_rrule_* copied verbatim, so no
--     writer can store a rule lib/src/recurrence cannot expand; the drizzle-kit
--     truncation of a CHECK at the first ';' inside a literal (0008) applies, so
--     these are hand-written and db/src/club-schema.test.ts asserts the live
--     constraint rejects FREQ=MONTHLY.
--   * occurrences are written ONLY by the club.materialize job
--     (db/src/clubs/materialize.ts), INSERT ... ON CONFLICT (class_id,
--     starts_at) DO NOTHING — idempotent and unable to resurrect a cancellation.
--   * bookings store the ORDER and nothing else: an arrival ticket from
--     club_booking_seq. Going/waitlisted is derived by club_booking_positions,
--     so over-booking is impossible and a cancellation promotes the next person
--     with no code running. Re-booking draws a FRESH ticket.
--
-- WHAT IS DIFFERENT FROM PLAY SESSIONS:
--   * tenancy: composite keys on (club_id, …) as everywhere in 0039–0044.
--   * the instructor is a member of the CLUB'S STAFF — a composite foreign key
--     to club_staff (club_id, user_id), SET NULL on that one column. A class
--     cannot name somebody who does not work at that club, and removing a
--     trainer from the team (or the trainer erasing their POPS account, which
--     cascades their club_staff row) leaves the class running with no named
--     instructor rather than failing.
--   * an occurrence may override the instructor (a substitute) and the
--     capacity; NULL means "the class's". Capacity NULL on the class is an open
--     gym session with no limit.
--   * booking windows: a member books themselves only from
--     booking_opens_hours before the start (trigger); the desk may book outside
--     the window. Whether a cancellation is "late" is decided in SQL from
--     cancel_deadline_hours by the application (apps/web/lib/clubs/bookings.ts)
--     and stored as state = 'late_cancelled' — a fact about what happened, not
--     a fee; v1 charges nothing for it.
--   * club_class_plans: when a class does not accept every abonnement
--     (covers_all_plans = false), the plans that DO cover it.
--
-- Locking: every object is new; nothing existing is touched.
--
-- rollback (ONE explicit transaction, after 0043–0044 and the application):
--   DROP VIEW "club_booking_positions";
--   DROP TABLE "club_bookings", "club_class_occurrences", "club_class_plans",
--              "club_classes";   -- DESTRUCTIVE: the timetable and every booking
--   DROP SEQUENCE "club_booking_seq";
--   DROP FUNCTION club_booking_requires_open_occurrence();
--   DROP FUNCTION club_class_cancel_future_occurrences();
--   DROP FUNCTION club_occurrence_verify_local_clock();
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE SEQUENCE "public"."club_booking_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "club_classes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"sport" text NOT NULL,
	"instructor_user_id" text,
	"starts_at_local" timestamp NOT NULL,
	"timezone" text DEFAULT 'Europe/Sofia' NOT NULL,
	"rrule" text,
	"duration_minutes" integer NOT NULL,
	"capacity" integer,
	"booking_opens_hours" integer DEFAULT 168 NOT NULL,
	"cancel_deadline_hours" integer DEFAULT 2 NOT NULL,
	"drop_in_price_cents" integer,
	"covers_all_plans" boolean DEFAULT true NOT NULL,
	"trial_allowed" boolean DEFAULT true NOT NULL,
	"public" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"materialized_through" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_classes_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_classes_title_sane" CHECK (btrim("club_classes"."title") <> '' AND char_length("club_classes"."title") <= 120),
	CONSTRAINT "club_classes_description_sane" CHECK ("club_classes"."description" IS NULL OR (btrim("club_classes"."description") <> '' AND char_length("club_classes"."description") <= 2000)),
	CONSTRAINT "club_classes_sport_format" CHECK ("club_classes"."sport" ~ '^[a-z][a-z0-9_]{1,29}$'),
	CONSTRAINT "club_classes_timezone_supported" CHECK ("club_classes"."timezone" = 'Europe/Sofia'),
	CONSTRAINT "club_classes_duration_sane" CHECK ("club_classes"."duration_minutes" BETWEEN 15 AND 480),
	CONSTRAINT "club_classes_capacity_sane" CHECK ("club_classes"."capacity" IS NULL OR "club_classes"."capacity" BETWEEN 1 AND 500),
	CONSTRAINT "club_classes_booking_window_sane" CHECK ("club_classes"."booking_opens_hours" BETWEEN 1 AND 2160),
	CONSTRAINT "club_classes_cancel_deadline_sane" CHECK ("club_classes"."cancel_deadline_hours" BETWEEN 0 AND 168),
	CONSTRAINT "club_classes_drop_in_sane" CHECK ("club_classes"."drop_in_price_cents" IS NULL OR "club_classes"."drop_in_price_cents" BETWEEN 0 AND 10000000),
	CONSTRAINT "club_classes_status_known" CHECK ("club_classes"."status" IN ('scheduled', 'cancelled')),
	CONSTRAINT "club_classes_rrule_supported" CHECK ("club_classes"."rrule" IS NULL OR "club_classes"."rrule" ~ '^FREQ=(DAILY|WEEKLY)(;(INTERVAL=[1-9][0-9]{0,2}|COUNT=[1-9][0-9]{0,2}|UNTIL=[0-9]{4}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]Z|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*|WKST=MO))*$'),
	CONSTRAINT "club_classes_rrule_count_xor_until" CHECK ("club_classes"."rrule" IS NULL OR NOT ("club_classes"."rrule" LIKE '%COUNT=%' AND "club_classes"."rrule" LIKE '%UNTIL=%')),
	CONSTRAINT "club_classes_rrule_byday_weekly_only" CHECK ("club_classes"."rrule" IS NULL OR "club_classes"."rrule" NOT LIKE '%BYDAY=%' OR "club_classes"."rrule" LIKE 'FREQ=WEEKLY%'),
	CONSTRAINT "club_classes_rrule_no_repeats" CHECK ("club_classes"."rrule" IS NULL OR (
            (char_length("club_classes"."rrule") - char_length(replace("club_classes"."rrule", 'INTERVAL=', ''))) <= 9
        AND (char_length("club_classes"."rrule") - char_length(replace("club_classes"."rrule", 'BYDAY=', ''))) <= 6
        AND (char_length("club_classes"."rrule") - char_length(replace("club_classes"."rrule", 'WKST=', ''))) <= 5
        AND (char_length("club_classes"."rrule") - char_length(replace("club_classes"."rrule", 'COUNT=', ''))) <= 6
        AND (char_length("club_classes"."rrule") - char_length(replace("club_classes"."rrule", 'UNTIL=', ''))) <= 6))
);
--> statement-breakpoint
CREATE TABLE "club_class_plans" (
	"club_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	CONSTRAINT "club_class_plans_pkey" PRIMARY KEY("class_id", "plan_id")
);
--> statement-breakpoint
CREATE TABLE "club_class_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"class_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"starts_at_local" timestamp NOT NULL,
	"dst_resolution" text DEFAULT 'exact' NOT NULL,
	"instructor_user_id" text,
	"capacity" integer,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancellation_scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_class_occurrences_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_class_occurrences_ends_after_start" CHECK ("club_class_occurrences"."ends_at" > "club_class_occurrences"."starts_at"),
	CONSTRAINT "club_class_occurrences_dst_known" CHECK ("club_class_occurrences"."dst_resolution" IN ('exact', 'gap_shifted', 'fold_first')),
	CONSTRAINT "club_class_occurrences_capacity_sane" CHECK ("club_class_occurrences"."capacity" IS NULL OR "club_class_occurrences"."capacity" BETWEEN 1 AND 500),
	CONSTRAINT "club_class_occurrences_status_known" CHECK ("club_class_occurrences"."status" IN ('scheduled', 'cancelled')),
	CONSTRAINT "club_class_occurrences_scope_known" CHECK ("club_class_occurrences"."cancellation_scope" IS NULL OR "club_class_occurrences"."cancellation_scope" IN ('occurrence', 'series')),
	CONSTRAINT "club_class_occurrences_cancel_fields" CHECK (("club_class_occurrences"."status" = 'cancelled') = ("club_class_occurrences"."cancelled_at" IS NOT NULL)
	      AND ("club_class_occurrences"."status" = 'cancelled') = ("club_class_occurrences"."cancellation_scope" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "club_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"seq" bigint DEFAULT nextval('club_booking_seq') NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"booked_by" text,
	"is_trial" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	CONSTRAINT "club_bookings_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_bookings_state_known" CHECK ("club_bookings"."state" IN ('active', 'cancelled', 'late_cancelled')),
	CONSTRAINT "club_bookings_cancel_pair" CHECK (("club_bookings"."state" <> 'active') = ("club_bookings"."cancelled_at" IS NOT NULL)),
	CONSTRAINT "club_bookings_seq_positive" CHECK ("club_bookings"."seq" > 0)
);
--> statement-breakpoint
CREATE INDEX "club_classes_club_status_idx" ON "club_classes" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "club_classes_location_idx" ON "club_classes" USING btree ("club_id","location_id");--> statement-breakpoint
CREATE INDEX "club_classes_instructor_idx" ON "club_classes" USING btree ("club_id","instructor_user_id") WHERE "club_classes"."instructor_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_classes_materialize_idx" ON "club_classes" USING btree ("materialized_through" NULLS FIRST) WHERE "club_classes"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "club_class_plans_plan_idx" ON "club_class_plans" USING btree ("club_id","plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "club_class_occurrences_class_start_unique" ON "club_class_occurrences" USING btree ("class_id","starts_at");--> statement-breakpoint
CREATE INDEX "club_class_occurrences_club_start_idx" ON "club_class_occurrences" USING btree ("club_id","starts_at") WHERE "club_class_occurrences"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "club_class_occurrences_instructor_idx" ON "club_class_occurrences" USING btree ("club_id","instructor_user_id") WHERE "club_class_occurrences"."instructor_user_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "club_bookings_occurrence_member_unique" ON "club_bookings" USING btree ("occurrence_id","member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "club_bookings_queue_idx" ON "club_bookings" USING btree ("occurrence_id","seq") WHERE "club_bookings"."state" = 'active';--> statement-breakpoint
CREATE INDEX "club_bookings_member_idx" ON "club_bookings" USING btree ("club_id","member_id");--> statement-breakpoint
-- The instant and the wall clock agree, checked against PostgreSQL's own tz
-- database (0008's play_session_verify_local_clock, for club classes).
CREATE FUNCTION club_occurrence_verify_local_clock() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  class_tz text;
  expected timestamp;
BEGIN
  SELECT c.timezone INTO class_tz
    FROM public.club_classes c WHERE c.id = NEW.class_id;
  IF class_tz IS NULL THEN
    RAISE EXCEPTION 'club_class_occurrences.class_id % has no class', NEW.class_id;
  END IF;
  expected := NEW.starts_at AT TIME ZONE class_tz;
  IF NEW.starts_at_local IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'occurrence local clock % disagrees with % in % (expected %) — the writer''s tz database and this server''s do not match',
      NEW.starts_at_local, NEW.starts_at, class_tz, expected;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_class_occurrences_verify_local_insert"
BEFORE INSERT ON "club_class_occurrences"
FOR EACH ROW EXECUTE FUNCTION club_occurrence_verify_local_clock();--> statement-breakpoint
-- Narrowed exactly as in 0008: a cancellation must never be re-verified
-- against tz data that may have changed since the row was materialized.
CREATE TRIGGER "club_class_occurrences_verify_local_update"
BEFORE UPDATE ON "club_class_occurrences"
FOR EACH ROW WHEN (NEW.starts_at IS DISTINCT FROM OLD.starts_at
                OR NEW.starts_at_local IS DISTINCT FROM OLD.starts_at_local)
EXECUTE FUNCTION club_occurrence_verify_local_clock();--> statement-breakpoint
-- Cancelling a class cancels its FUTURE occurrences; past ones happened.
CREATE FUNCTION club_class_cancel_future_occurrences() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.club_class_occurrences
     SET status = 'cancelled',
         cancelled_at = now(),
         cancellation_scope = 'series'
   WHERE class_id = NEW.id
     AND status = 'scheduled'
     AND starts_at > now();
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_classes_cancel_cascade"
AFTER UPDATE ON "club_classes"
FOR EACH ROW WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
EXECUTE FUNCTION club_class_cancel_future_occurrences();--> statement-breakpoint
-- Nobody books a cancelled or started occurrence, and a member booking
-- THEMSELVES (booked_by IS NULL) does so only inside the class's booking
-- window. The desk (booked_by set) may book early. Only transitions INTO
-- 'active' are checked, so cancelling a booking on a cancelled occurrence
-- stays possible.
CREATE FUNCTION club_booking_requires_open_occurrence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  occ_status text;
  occ_starts timestamptz;
  opens_hours integer;
BEGIN
  IF NEW.state <> 'active' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'active' THEN
    RETURN NEW;
  END IF;
  SELECT o.status, o.starts_at, c.booking_opens_hours
    INTO occ_status, occ_starts, opens_hours
    FROM public.club_class_occurrences o
    JOIN public.club_classes c ON c.id = o.class_id
   WHERE o.id = NEW.occurrence_id;
  IF occ_status IS DISTINCT FROM 'scheduled' THEN
    RAISE EXCEPTION 'cannot book a cancelled occurrence'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_bookings_occurrence_scheduled';
  END IF;
  IF occ_starts <= now() THEN
    RAISE EXCEPTION 'cannot book an occurrence that has already started'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_bookings_occurrence_future';
  END IF;
  IF NEW.booked_by IS NULL AND now() < occ_starts - make_interval(hours => opens_hours) THEN
    RAISE EXCEPTION 'booking for this occurrence is not open yet'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_bookings_window_open';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_bookings_occurrence_open"
BEFORE INSERT OR UPDATE ON "club_bookings"
FOR EACH ROW EXECUTE FUNCTION club_booking_requires_open_occurrence();--> statement-breakpoint
CREATE TRIGGER "club_classes_set_updated_at" BEFORE UPDATE ON "club_classes" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER "club_bookings_set_updated_at" BEFORE UPDATE ON "club_bookings" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- The one place a booking's position and going/waitlisted are written down.
-- Partitioned by (club_id, occurrence_id) — the same partition, since an
-- occurrence belongs to one club — so a filter on either column is pushed
-- below the window function. Effective capacity is the occurrence override,
-- else the class's; NULL = no limit.
CREATE VIEW "club_booking_positions" WITH (security_invoker = true) AS
SELECT
  q.booking_id,
  q.club_id,
  q.occurrence_id,
  q.class_id,
  q.member_id,
  q.seq,
  q.booked_by,
  q.is_trial,
  q.created_at,
  q.capacity,
  q.occurrence_status,
  q.starts_at,
  q.position,
  CASE WHEN q.capacity IS NULL OR q.position <= q.capacity THEN 'going' ELSE 'waitlisted' END
    AS booking_status
FROM (
  SELECT
    b.id AS booking_id,
    b.club_id,
    b.occurrence_id,
    o.class_id,
    b.member_id,
    b.seq,
    b.booked_by,
    b.is_trial,
    b.created_at,
    coalesce(o.capacity, c.capacity) AS capacity,
    o.status AS occurrence_status,
    o.starts_at,
    row_number() OVER (PARTITION BY b.club_id, b.occurrence_id ORDER BY b.seq, b.id) AS position
  FROM public.club_bookings b
  JOIN public.club_class_occurrences o ON o.id = b.occurrence_id
  JOIN public.club_classes c ON c.id = o.class_id
  WHERE b.state = 'active'
) q;--> statement-breakpoint
ALTER TABLE "club_classes" ADD CONSTRAINT "club_classes_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_classes" ADD CONSTRAINT "club_classes_location_fk" FOREIGN KEY ("club_id","location_id") REFERENCES "public"."club_locations"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_classes" ADD CONSTRAINT "club_classes_instructor_fk" FOREIGN KEY ("club_id","instructor_user_id") REFERENCES "public"."club_staff"("club_id","user_id") ON DELETE set null ("instructor_user_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_class_plans" ADD CONSTRAINT "club_class_plans_class_fk" FOREIGN KEY ("club_id","class_id") REFERENCES "public"."club_classes"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_class_plans" ADD CONSTRAINT "club_class_plans_plan_fk" FOREIGN KEY ("club_id","plan_id") REFERENCES "public"."club_plans"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_class_occurrences" ADD CONSTRAINT "club_class_occurrences_class_fk" FOREIGN KEY ("club_id","class_id") REFERENCES "public"."club_classes"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_class_occurrences" ADD CONSTRAINT "club_class_occurrences_instructor_fk" FOREIGN KEY ("club_id","instructor_user_id") REFERENCES "public"."club_staff"("club_id","user_id") ON DELETE set null ("instructor_user_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_bookings" ADD CONSTRAINT "club_bookings_occurrence_fk" FOREIGN KEY ("club_id","occurrence_id") REFERENCES "public"."club_class_occurrences"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_bookings" ADD CONSTRAINT "club_bookings_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
COMMENT ON TABLE "club_classes" IS 'A club''s class series (a one-off when rrule is NULL). Same wall-clock time model and rrule subset as play_sessions (0008); the instructor must be the club''s own staff (composite FK to club_staff).';--> statement-breakpoint
COMMENT ON TABLE "club_class_occurrences" IS 'Materialized instances over a rolling window, written ONLY by the club.materialize job; UNIQUE (class_id, starts_at) makes it idempotent and unable to resurrect a cancellation. instructor_user_id/capacity override the class for one evening.';--> statement-breakpoint
COMMENT ON TABLE "club_bookings" IS 'Booking ORDER only: an arrival ticket per booking from club_booking_seq. Position and going/waitlisted come from club_booking_positions. booked_by NULL = the member booked themselves (inside the booking window); otherwise the staff account that booked them.';--> statement-breakpoint
COMMENT ON VIEW "club_booking_positions" IS 'The single definition of a booking''s queue position and going/waitlisted, with effective capacity = occurrence override, else the class''s. Carries no name: who may see a roster is a projection rule (trainers see display name and minor flag only).';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
