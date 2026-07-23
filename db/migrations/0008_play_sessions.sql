-- 0008_play_sessions: the play layer — recurring pickup sessions, materialized
-- occurrences, RSVP/waitlist and check-ins (docs/ROADMAP.md §6, Stage 4.1).
-- Four new tables, one new sequence, one view, five triggers, three counters on
-- the GDPR tombstone. No existing row is rewritten and no data is destroyed.
--
-- NAMING: `sessions` is better-auth's table (migration 0005), so everything here
-- is prefixed `play_session*`.
--
-- THE TIME MODEL. A session is scheduled in WALL CLOCK time:
-- play_sessions.starts_at_local is `timestamp` WITHOUT time zone, a reading on a
-- Sofia clock, and `rrule` is expanded against it in pure civil arithmetic
-- (lib/src/recurrence). Only finished candidates become instants. A weekly 18:00
-- session is 18:00 in January and 18:00 in July even though those are different
-- UTC instants — which no implementation that adds 7 × 86 400 000 ms to an
-- instant can produce. play_session_occurrences stores BOTH the instant
-- (starts_at) and the wall clock it resolved to (starts_at_local).
--
-- THAT PAIR IS VERIFIED BY A TRIGGER, NOT A CHECK, and deliberately so: the test
-- is `starts_at AT TIME ZONE <session tz>`, and `timezone(text, timestamptz)` is
-- STABLE — PostgreSQL refuses non-IMMUTABLE functions in a CHECK. The trigger
-- makes "Node's ICU and PostgreSQL's tzdata disagree about Bulgarian time" a
-- loud failure instead of silently wrong session times. Occurrence rows are
-- written ONLY by the pg-boss job `session.materialize`, so the blast radius of
-- a false positive is a failed job in the logs, never a user-facing request.
--
-- The verification is split across two triggers on purpose. The INSERT one is
-- unconditional; the UPDATE one fires ONLY when starts_at or starts_at_local is
-- actually touched. It is not a pure function of the row — it reads the server's
-- tz database — so an unconditional UPDATE trigger would re-litigate old rows
-- during the cancellation cascade, which is reached from `DELETE FROM users`.
-- New tzdata (a minor-version image bump, or the EU abolishing DST) would then
-- make GDPR erasure fail from three levels down a cascade. Erasure must never be
-- blockable; see the GDPR paragraph below.
--
-- WAITLIST. play_session_rsvps stores the ORDER and nothing else: an arrival
-- ticket from play_session_rsvp_seq. There is no going/waitlisted column and no
-- promotion logic — position is row_number() over the active rows and the view
-- play_session_rsvp_positions derives the rest. Over-booking is therefore
-- impossible (no counter to race on: everyone gets a ticket, the ordering
-- decides) and a withdrawal promotes the next person with no code running at
-- all. Re-joining after withdrawing draws a FRESH ticket, so it goes to the back
-- of the queue — which is why this is a real SEQUENCE and not the identity key.
-- play_session_rsvps_queue_idx is UNIQUE because that ordering must be TOTAL:
-- `nextval` never repeating is a property of the default, not of the column, and
-- a tie at the capacity boundary would let two people swap between "going" and
-- "waitlisted" from one query plan to the next.
--
-- CANCELLATION. Cancelling a series cancels its FUTURE occurrences through
-- play_sessions_cancel_cascade; past ones are untouched because they happened.
-- Cancelling one occurrence is a row update with scope='occurrence', and the
-- materializer never resurrects it (the UNIQUE on (session_id, starts_at) makes
-- every run an INSERT ... ON CONFLICT DO NOTHING). Un-cancelling a series is
-- deliberately not modelled — create a new one.
--
-- GDPR. organizer_id is ON DELETE SET NULL, not CASCADE: other people's past
-- attendance is THEIR data, and CASCADE would destroy it to erase the organiser.
-- play_sessions_orphan_cancel turns the resulting NULL into a cancelled series
-- inside the same statement, so no live session is ever left with nobody
-- answerable for it — enforced by the database, with no application code that
-- can forget to run. RSVPs and check-ins ARE the person's own data and leave
-- with the account (CASCADE). Nothing in this migration can abort a
-- `DELETE FROM users`: play_sessions_live_has_organizer is evaluated on the row
-- as the BEFORE trigger left it, play_session_rsvps_occurrence_open is
-- INSERT/UPDATE only so cascaded deletes never fire it, and the local-clock
-- verification no longer runs on the cascade's UPDATE (see above).
--
-- KNOWN drizzle-kit ISSUE: the generator truncates a CHECK expression at the
-- first ';' inside a string literal, which mangles play_sessions_rrule_supported
-- (the RRULE grammar regex) into invalid SQL on every regeneration. It is
-- written out correctly below and matches meta/0008_snapshot.json character for
-- character. db/src/sessions-schema.test.ts asserts the live constraint really
-- rejects FREQ=MONTHLY, BYSETPOS and ordinal BYDAY, so a regeneration that
-- reintroduces the truncation fails a test rather than shipping.
--
-- Locking. The four CREATE TABLEs, the sequence, the types, every index and the
-- view are new objects and lock nothing anyone else uses. Two statements do
-- touch existing tables:
--   * the six ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY take SHARE ROW
--     EXCLUSIVE on the REFERENCED tables — `users` (four of them) and
--     `facilities` — which blocks writes to both (reads are unaffected) for the
--     rest of the transaction, since drizzle runs the migration as one. They are
--     therefore placed as late as possible, immediately before the
--     account_deletions block, rather than in drizzle's default position.
--   * the three ADD COLUMN on account_deletions are catalog-only in PG 16
--     (constant defaults) and the re-added CHECK scans a table with a handful of
--     rows — but the ACCESS EXCLUSIVE lock is held to COMMIT all the same.
-- lock_timeout makes queueing behind a long reader fail fast instead of blocking
-- sign-in and erasure.
--
-- rollback (compensating SQL, reverse order; DESTRUCTIVE where noted):
--   ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";
--   ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
--             AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
--             AND "account_deletions"."moderation_decisions_preserved" >= 0);
--   ALTER TABLE "account_deletions" DROP COLUMN "checkins_erased";   -- DESTRUCTIVE:
--   ALTER TABLE "account_deletions" DROP COLUMN "rsvps_erased";      -- erasure receipts
--   ALTER TABLE "account_deletions" DROP COLUMN "sessions_cancelled";-- recorded since
--       this migration. Small, and unrecoverable: the accounts they describe are
--       gone, so the counts cannot be recomputed from anything.
--   DROP VIEW "play_session_rsvp_positions";
--   DROP TRIGGER "play_session_rsvps_occurrence_open" ON "play_session_rsvps";
--   DROP TRIGGER "play_sessions_cancel_cascade" ON "play_sessions";
--   DROP TRIGGER "play_sessions_orphan_cancel" ON "play_sessions";
--   DROP TRIGGER "play_session_occurrences_verify_local_update" ON "play_session_occurrences";
--   DROP TRIGGER "play_session_occurrences_verify_local_insert" ON "play_session_occurrences";
--   DROP FUNCTION play_session_rsvp_requires_open_occurrence();
--   DROP FUNCTION play_session_cancel_future_occurrences();
--   DROP FUNCTION play_session_orphan_cancels();
--   DROP FUNCTION play_session_verify_local_clock();
--   DROP TABLE "play_session_checkins";   -- DESTRUCTIVE: attendance history
--   DROP TABLE "play_session_rsvps";      -- DESTRUCTIVE: every RSVP and its
--       queue position; the ordering cannot be reconstructed from anything else
--   DROP TABLE "play_session_occurrences";-- occurrences are re-derivable from
--       the rules, but the cancellations recorded on them are NOT
--   DROP TABLE "play_sessions";           -- DESTRUCTIVE: every session
--   DROP SEQUENCE "play_session_rsvp_seq";
--   DROP TYPE "play_session_visibility"; DROP TYPE "play_session_status";
--   DROP TYPE "play_session_skill"; DROP TYPE "play_session_rsvp_state";
--   DROP TYPE "play_session_dst_resolution"; DROP TYPE "play_session_checkin_method";
--   DROP TYPE "play_session_cancel_scope";
SET lock_timeout = '3s';--> statement-breakpoint
CREATE TYPE "public"."play_session_cancel_scope" AS ENUM('occurrence', 'series');--> statement-breakpoint
CREATE TYPE "public"."play_session_checkin_method" AS ENUM('self', 'organizer', 'qr');--> statement-breakpoint
CREATE TYPE "public"."play_session_dst_resolution" AS ENUM('exact', 'gap_shifted', 'fold_first');--> statement-breakpoint
CREATE TYPE "public"."play_session_rsvp_state" AS ENUM('active', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."play_session_skill" AS ENUM('any', 'beginner', 'intermediate', 'advanced');--> statement-breakpoint
CREATE TYPE "public"."play_session_status" AS ENUM('scheduled', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."play_session_visibility" AS ENUM('public', 'unlisted');--> statement-breakpoint
CREATE SEQUENCE "public"."play_session_rsvp_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "play_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"facility_id" uuid NOT NULL,
	"sport" text NOT NULL,
	"organizer_id" text,
	"title" text NOT NULL,
	"description" text,
	"starts_at_local" timestamp NOT NULL,
	"timezone" text DEFAULT 'Europe/Sofia' NOT NULL,
	"rrule" text,
	"duration_minutes" integer NOT NULL,
	"capacity" integer,
	"skill_level" "play_session_skill" DEFAULT 'any' NOT NULL,
	"visibility" "play_session_visibility" DEFAULT 'public' NOT NULL,
	"status" "play_session_status" DEFAULT 'scheduled' NOT NULL,
	"materialized_through" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "play_sessions_live_has_organizer" CHECK ("play_sessions"."status" = 'cancelled' OR "play_sessions"."organizer_id" IS NOT NULL),
	CONSTRAINT "play_sessions_title_not_blank" CHECK (btrim("play_sessions"."title") <> ''),
	CONSTRAINT "play_sessions_title_len" CHECK (char_length("play_sessions"."title") <= 120),
	CONSTRAINT "play_sessions_description_sane" CHECK ("play_sessions"."description" IS NULL OR (btrim("play_sessions"."description") <> '' AND char_length("play_sessions"."description") <= 2000)),
	CONSTRAINT "play_sessions_sport_format" CHECK ("play_sessions"."sport" ~ '^[a-z][a-z0-9_]{1,29}$'),
	CONSTRAINT "play_sessions_timezone_supported" CHECK ("play_sessions"."timezone" = 'Europe/Sofia'),
	CONSTRAINT "play_sessions_duration_sane" CHECK ("play_sessions"."duration_minutes" BETWEEN 15 AND 480),
	CONSTRAINT "play_sessions_capacity_sane" CHECK ("play_sessions"."capacity" IS NULL OR "play_sessions"."capacity" BETWEEN 1 AND 500),
	CONSTRAINT "play_sessions_rrule_supported" CHECK ("play_sessions"."rrule" IS NULL OR "play_sessions"."rrule" ~ '^FREQ=(DAILY|WEEKLY)(;(INTERVAL=[1-9][0-9]{0,2}|COUNT=[1-9][0-9]{0,2}|UNTIL=[0-9]{4}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]Z|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*|WKST=MO))*$'),
	CONSTRAINT "play_sessions_rrule_count_xor_until" CHECK ("play_sessions"."rrule" IS NULL OR NOT ("play_sessions"."rrule" LIKE '%COUNT=%' AND "play_sessions"."rrule" LIKE '%UNTIL=%')),
	CONSTRAINT "play_sessions_rrule_byday_weekly_only" CHECK ("play_sessions"."rrule" IS NULL OR "play_sessions"."rrule" NOT LIKE '%BYDAY=%' OR "play_sessions"."rrule" LIKE 'FREQ=WEEKLY%'),
	CONSTRAINT "play_sessions_rrule_no_repeats" CHECK ("play_sessions"."rrule" IS NULL OR (
            (char_length("play_sessions"."rrule") - char_length(replace("play_sessions"."rrule", 'INTERVAL=', ''))) <= 9
        AND (char_length("play_sessions"."rrule") - char_length(replace("play_sessions"."rrule", 'BYDAY=', ''))) <= 6
        AND (char_length("play_sessions"."rrule") - char_length(replace("play_sessions"."rrule", 'WKST=', ''))) <= 5
        AND (char_length("play_sessions"."rrule") - char_length(replace("play_sessions"."rrule", 'COUNT=', ''))) <= 6
        AND (char_length("play_sessions"."rrule") - char_length(replace("play_sessions"."rrule", 'UNTIL=', ''))) <= 6))
);
--> statement-breakpoint
CREATE TABLE "play_session_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"starts_at_local" timestamp NOT NULL,
	"dst_resolution" "play_session_dst_resolution" DEFAULT 'exact' NOT NULL,
	"status" "play_session_status" DEFAULT 'scheduled' NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancellation_scope" "play_session_cancel_scope",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "play_session_occurrences_ends_after_start" CHECK ("play_session_occurrences"."ends_at" > "play_session_occurrences"."starts_at"),
	CONSTRAINT "play_session_occurrences_cancel_fields" CHECK (("play_session_occurrences"."status" = 'cancelled') = ("play_session_occurrences"."cancelled_at" IS NOT NULL)
          AND ("play_session_occurrences"."status" = 'cancelled') = ("play_session_occurrences"."cancellation_scope" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "play_session_rsvps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"seq" bigint DEFAULT nextval('play_session_rsvp_seq') NOT NULL,
	"state" "play_session_rsvp_state" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "play_session_rsvps_withdrawn_pair" CHECK (("play_session_rsvps"."state" = 'withdrawn') = ("play_session_rsvps"."withdrawn_at" IS NOT NULL)),
	CONSTRAINT "play_session_rsvps_seq_positive" CHECK ("play_session_rsvps"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "play_session_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"method" "play_session_checkin_method" NOT NULL,
	"recorded_by" text,
	"checked_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "play_session_checkins_self_has_no_recorder" CHECK ("play_session_checkins"."method" <> 'self' OR "play_session_checkins"."recorded_by" IS NULL)
);
--> statement-breakpoint
CREATE INDEX "play_sessions_facility_status_idx" ON "play_sessions" USING btree ("facility_id","status");--> statement-breakpoint
CREATE INDEX "play_sessions_materialize_idx" ON "play_sessions" USING btree ("materialized_through" NULLS FIRST) WHERE "play_sessions"."status" = 'scheduled';--> statement-breakpoint
CREATE INDEX "play_sessions_organizer_idx" ON "play_sessions" USING btree ("organizer_id") WHERE "play_sessions"."organizer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "play_session_occurrences_session_start_unique" ON "play_session_occurrences" USING btree ("session_id","starts_at");--> statement-breakpoint
CREATE INDEX "play_session_occurrences_upcoming_idx" ON "play_session_occurrences" USING btree ("starts_at") WHERE "play_session_occurrences"."status" = 'scheduled';--> statement-breakpoint
CREATE UNIQUE INDEX "play_session_rsvps_occurrence_user_unique" ON "play_session_rsvps" USING btree ("occurrence_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "play_session_rsvps_queue_idx" ON "play_session_rsvps" USING btree ("occurrence_id","seq") WHERE "play_session_rsvps"."state" = 'active';--> statement-breakpoint
CREATE INDEX "play_session_rsvps_user_idx" ON "play_session_rsvps" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "play_session_checkins_occurrence_user_unique" ON "play_session_checkins" USING btree ("occurrence_id","user_id");--> statement-breakpoint
CREATE INDEX "play_session_checkins_user_idx" ON "play_session_checkins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "play_session_checkins_recorded_by_idx" ON "play_session_checkins" USING btree ("recorded_by") WHERE "play_session_checkins"."recorded_by" IS NOT NULL;--> statement-breakpoint
-- The instant and the wall clock it reads as must agree, checked against
-- PostgreSQL's own tz database rather than trusting the writer. See the header
-- for why this is a trigger and not a CHECK, and why the UPDATE case is
-- narrowed. search_path is pinned so the function cannot be steered by the
-- caller's session.
CREATE FUNCTION play_session_verify_local_clock() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  session_tz text;
  expected timestamp;
BEGIN
  SELECT s.timezone INTO session_tz
  FROM public.play_sessions s WHERE s.id = NEW.session_id;
  -- Not dead code: foreign keys are AFTER-row constraint triggers, so at BEFORE
  -- INSERT time session_id is still unvalidated. play_sessions.timezone is NOT
  -- NULL, so a NULL here means only "no such series".
  IF session_tz IS NULL THEN
    RAISE EXCEPTION 'play_session_occurrences.session_id % has no series', NEW.session_id;
  END IF;
  expected := NEW.starts_at AT TIME ZONE session_tz;
  IF NEW.starts_at_local IS DISTINCT FROM expected THEN
    RAISE EXCEPTION
      'occurrence local clock % disagrees with % in % (expected %) — the writer''s tz database and this server''s do not match',
      NEW.starts_at_local, NEW.starts_at, session_tz, expected;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "play_session_occurrences_verify_local_insert"
BEFORE INSERT ON "play_session_occurrences"
FOR EACH ROW EXECUTE FUNCTION play_session_verify_local_clock();--> statement-breakpoint
-- Only when the two columns in question actually move. A cancellation — which
-- is reachable from DELETE FROM users — must never be re-verified against tz
-- data that may have changed since the row was materialized.
CREATE TRIGGER "play_session_occurrences_verify_local_update"
BEFORE UPDATE ON "play_session_occurrences"
FOR EACH ROW WHEN (NEW.starts_at IS DISTINCT FROM OLD.starts_at
                OR NEW.starts_at_local IS DISTINCT FROM OLD.starts_at_local)
EXECUTE FUNCTION play_session_verify_local_clock();--> statement-breakpoint
-- A live series always has an organiser (play_sessions_live_has_organizer).
-- GDPR erasure nulls organizer_id through the foreign key, which is an UPDATE
-- this table never sees coming, so the cancellation happens here rather than in
-- application code that could be bypassed or forgotten. updated_at moves too,
-- so the row does not silently change state behind a stale change cursor.
CREATE FUNCTION play_session_orphan_cancels() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.status := 'cancelled';
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "play_sessions_orphan_cancel"
BEFORE UPDATE ON "play_sessions"
FOR EACH ROW WHEN (NEW.organizer_id IS NULL AND OLD.organizer_id IS NOT NULL)
EXECUTE FUNCTION play_session_orphan_cancels();--> statement-breakpoint
-- Cancelling a series cancels its FUTURE occurrences. Past ones are left alone:
-- they happened, and rewriting them would erase people's attendance history.
-- Plain AFTER UPDATE, not `AFTER UPDATE OF status`: when the cancellation comes
-- from play_sessions_orphan_cancel the statement's SET list names organizer_id
-- only, so an `OF status` trigger would never fire. The WHEN clause of an AFTER
-- row trigger is evaluated against the row as stored, i.e. after BEFORE
-- triggers have run.
CREATE FUNCTION play_session_cancel_future_occurrences() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.play_session_occurrences
     SET status = 'cancelled',
         cancelled_at = now(),
         cancellation_scope = 'series'
   WHERE session_id = NEW.id
     AND status = 'scheduled'
     AND starts_at > now();
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "play_sessions_cancel_cascade"
AFTER UPDATE ON "play_sessions"
FOR EACH ROW WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
EXECUTE FUNCTION play_session_cancel_future_occurrences();--> statement-breakpoint
-- Nobody joins a cancelled session, or one that already happened. Only
-- transitions INTO 'active' are blocked: withdrawing from an occurrence that was
-- cancelled under you must stay possible, and the existing RSVPs are what the
-- cancellation notification is addressed to, so they are never removed.
CREATE FUNCTION play_session_rsvp_requires_open_occurrence() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  occurrence public.play_session_occurrences%ROWTYPE;
BEGIN
  IF NEW.state <> 'active' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.state = 'active' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO occurrence
  FROM public.play_session_occurrences o WHERE o.id = NEW.occurrence_id;
  IF occurrence.status IS DISTINCT FROM 'scheduled' THEN
    RAISE EXCEPTION 'cannot RSVP to a cancelled occurrence';
  END IF;
  IF occurrence.starts_at <= now() THEN
    RAISE EXCEPTION 'cannot RSVP to an occurrence that has already started';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "play_session_rsvps_occurrence_open"
BEFORE INSERT OR UPDATE ON "play_session_rsvps"
FOR EACH ROW EXECUTE FUNCTION play_session_rsvp_requires_open_occurrence();--> statement-breakpoint
-- The one place waitlist position is written down. Everything else reads it from
-- here, so "am I going?" has exactly one answer in the system. The occurrence's
-- status and start time are projected so a caller cannot forget that an RSVP on
-- a cancelled occurrence still reads 'going' — by design, since that is who the
-- cancellation notice goes to. security_invoker so the day a read-only
-- reporting role is granted this view, it does not become a way around the
-- permissions on the tables underneath.
CREATE VIEW "play_session_rsvp_positions" WITH (security_invoker = true) AS
SELECT
  q.rsvp_id,
  q.occurrence_id,
  q.session_id,
  q.user_id,
  q.seq,
  q.created_at,
  q.capacity,
  q.occurrence_status,
  q.starts_at,
  q.position,
  CASE WHEN q.capacity IS NULL OR q.position <= q.capacity THEN 'going' ELSE 'waitlisted' END
    AS rsvp_status
FROM (
  SELECT
    r.id AS rsvp_id,
    r.occurrence_id,
    o.session_id,
    r.user_id,
    r.seq,
    r.created_at,
    s.capacity,
    o.status AS occurrence_status,
    o.starts_at,
    -- r.id only breaks a tie the unique index already forbids; it keeps the
    -- ordering total even if that index is ever relaxed.
    row_number() OVER (PARTITION BY r.occurrence_id ORDER BY r.seq, r.id) AS position
  FROM public.play_session_rsvps r
  JOIN public.play_session_occurrences o ON o.id = r.occurrence_id
  JOIN public.play_sessions s ON s.id = o.session_id
  WHERE r.state = 'active'
) q;--> statement-breakpoint
COMMENT ON TABLE "play_sessions" IS 'Recurring pickup session series. starts_at_local is a WALL CLOCK reading (timestamp without time zone) and rrule is expanded against it in civil arithmetic, so a weekly 18:00 session stays 18:00 across both DST transitions. Named play_sessions because better-auth owns `sessions`.';--> statement-breakpoint
COMMENT ON COLUMN "play_sessions"."rrule" IS 'A deliberate subset of RFC 5545: FREQ=DAILY|WEEKLY, INTERVAL, BYDAY (weekly only), COUNT xor UNTIL, WKST=MO. NULL = one-off. The CHECKs are that subset in SQL, so no writer can store a rule lib/src/recurrence cannot expand.';--> statement-breakpoint
COMMENT ON COLUMN "play_sessions"."organizer_id" IS 'ON DELETE SET NULL, never CASCADE: erasing the organiser must not destroy other people''s attendance history. The play_sessions_orphan_cancel trigger cancels the series in the same statement, so no live session is left unanswerable for.';--> statement-breakpoint
COMMENT ON COLUMN "play_sessions"."capacity" IS 'Applies to every occurrence of the series; NULL = unlimited. Lowering it does NOT drop anyone already confirmed by a statement — but because going/waitlisted is derived from position, people past the new limit do move to the waitlist, with no event to notify on. Raise deliberately; lower with a message to the group.';--> statement-breakpoint
COMMENT ON TABLE "play_session_occurrences" IS 'Materialized instances over a rolling 8-week window, written ONLY by the session.materialize job. UNIQUE (session_id, starts_at) makes that job INSERT ... ON CONFLICT DO NOTHING — idempotent, and unable to resurrect a cancelled occurrence.';--> statement-breakpoint
COMMENT ON COLUMN "play_session_occurrences"."starts_at_local" IS 'The wall clock starts_at reads as, verified against this server''s tz database by play_session_occurrences_verify_local_insert/_update. A trigger rather than a CHECK because timezone(text, timestamptz) is STABLE and CHECKs require IMMUTABLE.';--> statement-breakpoint
COMMENT ON COLUMN "play_session_occurrences"."dst_resolution" IS 'How the wall clock resolved: exact, gap_shifted (the vanished hour on the last Sunday of March — pushed forward), or fold_first (the repeated hour in October — the earlier instant). Recorded so the row can answer why a session moved.';--> statement-breakpoint
COMMENT ON TABLE "play_session_rsvps" IS 'Waitlist ORDER only: an arrival ticket per RSVP, no going/waitlisted column and no promotion logic. Position comes from play_session_rsvp_positions. Over-booking is impossible because there is no counter to race on, and a withdrawal promotes the next person with no code running.';--> statement-breakpoint
COMMENT ON COLUMN "play_session_rsvps"."seq" IS 'Arrival ticket from play_session_rsvp_seq, UNIQUE per occurrence among active rows so the ordering is total. Re-joining after withdrawing draws a FRESH ticket and goes to the back of the queue — which is why this is a sequence and not the identity key.';--> statement-breakpoint
COMMENT ON VIEW "play_session_rsvp_positions" IS 'The single definition of waitlist position and going/waitlisted. Carries no display name: who may see an attendee list is a UI rule (minors), not this view''s job.';--> statement-breakpoint
ALTER TABLE "play_sessions" ADD CONSTRAINT "play_sessions_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_sessions" ADD CONSTRAINT "play_sessions_organizer_id_users_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_session_occurrences" ADD CONSTRAINT "play_session_occurrences_session_id_play_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."play_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_session_rsvps" ADD CONSTRAINT "play_session_rsvps_occurrence_id_play_session_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."play_session_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_session_rsvps" ADD CONSTRAINT "play_session_rsvps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_session_checkins" ADD CONSTRAINT "play_session_checkins_occurrence_id_play_session_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."play_session_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_session_checkins" ADD CONSTRAINT "play_session_checkins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_session_checkins" ADD CONSTRAINT "play_session_checkins_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_deletions" DROP CONSTRAINT "account_deletions_counts_non_negative";--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "sessions_cancelled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "rsvps_erased" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD COLUMN "checkins_erased" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "account_deletions" ADD CONSTRAINT "account_deletions_counts_non_negative" CHECK ("account_deletions"."audit_rows_preserved" >= 0 AND "account_deletions"."photos_anonymized" >= 0
          AND "account_deletions"."condition_reports_anonymized" >= 0 AND "account_deletions"."points_erased" >= 0
          AND "account_deletions"."moderation_decisions_preserved" >= 0 AND "account_deletions"."sessions_cancelled" >= 0
          AND "account_deletions"."rsvps_erased" >= 0 AND "account_deletions"."checkins_erased" >= 0);
