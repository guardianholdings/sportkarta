-- 0052_club_inbox_leads_feedback: «Клубове» v2, wave F2 (plan 2026-10-25) — a
-- club and its clients write to each other (1club's inbox), a visitor asks
-- for a hall, a party or a camp from the club's page (anolla's quote
-- requests), the desk works its prospects through a pipeline (1club's leads),
-- and clients rate the classes they came to (1club's and anolla's feedback,
-- reputation management).
-- Hand-written; do not regenerate.
--
-- WHAT THIS ADDS
--
--   club_threads           a conversation between the club and ONE of its
--                          client records: a message the member started from
--                          the portal, one the office started to a linked
--                          member, or an INQUIRY from the club's public page
--                          (a hall, an event, a corporate group, a party, a
--                          camp — with a wished-for date and a party size).
--                          Only signed-in people write: an inquiry from
--                          somebody the club does not know creates their own
--                          record first (source 'self', the trial booking's
--                          path), so a thread always belongs to a record the
--                          club controls, and erasing that record (members
--                          .erase) erases the conversation with it (CASCADE).
--                          Read markers on both sides; a member writing to a
--                          closed thread re-opens it.
--   club_thread_messages   what was written, by whom (the member, or the club
--                          — with the member of staff kept BY VALUE, 0039 rule
--                          5). A message is never edited (a trigger); no
--                          application path deletes one — it goes with its
--                          thread or its record. The thread's markers follow
--                          every message by trigger (and only ever forward),
--                          so no writer can forget them.
--   club_members.lead_*    the prospects pipeline: when the record entered it
--                          and from where (an inquiry, a trial, the desk, the
--                          phone, a referral …), when somebody first called,
--                          the next agreed step, who of the staff owns it (by
--                          value), and — closed list — why it was lost. Only
--                          the facts a person decides are stored.
--   club_lead_stages       the pipeline's STAGE, derived, never stored (0039
--                          rule 3): won once a non-trial abonnement was sold
--                          after the lead opened (a lost prospect who buys
--                          later is won, not lost); lost if marked lost; visited
--                          once they checked in; trial booked once a trial
--                          class or trial abonnement exists; contacted once
--                          somebody called; else new. A sale, a visit, a trial
--                          booking moves the card by itself — the desk never
--                          drags a card to say what the books already say.
--   club_feedback          a client's rating (1–5, an optional comment of at
--                          most 500 characters) of ONE class they came to or
--                          ONE court / appointment they had. A trigger admits
--                          only somebody who came: a check-in at that class,
--                          or their own confirmed reservation that has ended.
--                          The same trigger records the trainer, by value —
--                          the substitute that day, else the class's
--                          instructor; the appointment's member of staff —
--                          whatever the application sent, for the per-trainer
--                          average. Comments are the club's to read and never
--                          public; the club's page shows an average only (the
--                          application decides when: five ratings in twelve
--                          months). A rating is not edited; no application
--                          path deletes one — it goes with the client's record.
--   clubs.google_review_url
--                          a plain link to the club's own Google review page,
--                          shown after a good rating. A CHECK admits only the
--                          three shapes Google hands a business for this (a
--                          g.page review link, a writereview place link, a
--                          maps.app.goo.gl short link) — not any page on a
--                          Google host, where a redirector or an AMP viewer
--                          could put another site in front of a member as
--                          "rate us".
--
--   club_automations_feedback_by_email, club_automations_delay_sane
--                          a request to rate goes by e-mail — its button opens
--                          the rating page, which an SMS could only link to at
--                          the cost of its length — and at most 7 days after
--                          the class: later there is nothing left to rate
--                          (the portal takes ratings for 14 days).
--
--   Vocabulary: automation trigger feedback_request; notification kinds
--   inbox_message (to staff), inbox_reply (to the member), leads_due (the
--   daily list of prospects to call, to staff); audit actions thread_started,
--   thread_closed, thread_reopened, inquiry_received, lead_opened,
--   lead_updated, lead_lost, lead_reopened, feedback_settings_changed. The twin
--   lists live in lib/src/clubs/vocab.ts and lib/src/clubs/messaging.ts;
--   lib/src/clubs/clubs.test.ts reads the LAST definition of each constraint.
--
-- TENANCY: every new table carries club_id with its own club_id → clubs
-- CASCADE, so the purge empties them in its first round (0049's header).
-- Their keys to club_members, club_threads, club_class_occurrences and
-- club_reservations are composite (club_id, id), so no row can name another
-- club's client, thread, class or booking. The member keys CASCADE (erasing a
-- record erases its conversations and ratings); the class and booking keys
-- are NO ACTION — an occurrence somebody checked in to and a confirmed
-- reservation are never deleted. No new column references users: staff and
-- trainer ids are BY VALUE (0039 rule 5), so account erasure has no new rows
-- to count.
--
-- Locking: club_staff first (ACCESS EXCLUSIVE), the order 0045–0051 keep for
-- account erasure; then club_audit — the next table erasure writes — and
-- club_notifications (reached by erasure through the users cascade); then
-- clubs, club_members and club_automations (ACCESS EXCLUSIVE), and
-- club_class_occurrences and club_reservations (SHARE ROW EXCLUSIVE, for the
-- new feedback keys) — all until COMMIT. The view takes ACCESS SHARE on
-- club_memberships, club_checkins and club_bookings. The new CHECKs scan
-- club_audit, club_notifications, club_automations, clubs and club_members;
-- clubs ship switched off (CLUBS_ENABLED), so in production these are empty
-- or near it. Locking club_staff first serialises account erasure and the
-- staff-scoped statements only: a portal, kiosk or worker transaction that
-- reads clubs / club_members or writes club_reservations before writing
-- club_audit or club_notifications holds them in the reverse order, and one
-- running at that instant may deadlock with this file — Postgres aborts one
-- side after ~1 s, a red deploy is simply re-run and pg-boss retries a job.
-- No order of these statements removes that; deploy at a quiet hour. Do not
-- purge a club while this deploy migrates (0045).
--
-- rollback (ONE explicit transaction, at a quiet hour, right after reverting
-- the application). The reverted application reads none of the new columns or
-- tables — but its worker DOES read club_automations, and the 0051 code has no
-- case for 'feedback_request': one such row makes automationCandidates throw
-- and stops EVERY club's daily automations, on every retry. That holds from
-- the moment the application is reverted, so the DELETE below is not
-- optional. Dropping the new tables' keys takes ACCESS EXCLUSIVE on
-- clubs, club_members, club_class_occurrences and club_reservations for the
-- rest of the transaction:
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;
--   LOCK TABLE "clubs", "club_members", "club_class_occurrences", "club_reservations", "club_automations"
--     IN ACCESS EXCLUSIVE MODE;
--   DELETE FROM "club_automations" WHERE "trigger" = 'feedback_request';
--                         -- the 0051 worker has no case for it (see above)
--   DROP TABLE "club_feedback";                 -- DESTRUCTIVE: every rating
--   DROP FUNCTION club_feedback_attended(), club_feedback_fixed();
--   DROP TABLE "club_thread_messages";          -- DESTRUCTIVE: every conversation
--   DROP TABLE "club_threads";
--   DROP FUNCTION club_thread_messages_touch(), club_thread_messages_fixed();
--   DROP VIEW "club_lead_stages";
--   Leave club_members.lead_* (with their CHECKs and index) and
--   clubs.google_review_url: harmless to the old code, and the pipeline is the
--   club's working data.
--   Keep the widened CHECKs on club_audit (append-only), club_notifications
--   and club_automations, and the two automation CHECKs (they only bind
--   feedback_request rows, now deleted; narrowing a list needs deleting the
--   rows of the new kinds — 0044's caveat).
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
-- Erasure's first club-table lock, taken first (see the header), then the
-- tables erasure writes, in its order.
LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_audit", "club_notifications" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "clubs", "club_members", "club_automations" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_class_occurrences", "club_reservations" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- ─── The prospects pipeline ──────────────────────────────────────────────
ALTER TABLE "club_members" ADD COLUMN "lead_opened_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "lead_source" text;--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "lead_contacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "lead_next_action_on" date;--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "lead_assigned_to" text;--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "lead_lost_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "club_members" ADD COLUMN "lead_lost_reason" text;--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_lead_source_known" CHECK ("club_members"."lead_source" IS NULL OR "club_members"."lead_source" IN (
	    'inquiry', 'trial', 'desk', 'phone', 'referral', 'social', 'event', 'other')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_members" VALIDATE CONSTRAINT "club_members_lead_source_known";--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_lead_lost_reason_known" CHECK ("club_members"."lead_lost_reason" IS NULL OR "club_members"."lead_lost_reason" IN (
	    'price', 'schedule', 'location', 'no_answer', 'chose_other', 'not_interested', 'other')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_members" VALIDATE CONSTRAINT "club_members_lead_lost_reason_known";--> statement-breakpoint
-- The pipeline's facts exist only for a record in the pipeline, and a lost
-- lead always says why.
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_lead_fields_need_lead" CHECK ("club_members"."lead_opened_at" IS NOT NULL
	    OR num_nonnulls("club_members"."lead_source", "club_members"."lead_contacted_at",
	                    "club_members"."lead_next_action_on", "club_members"."lead_assigned_to",
	                    "club_members"."lead_lost_at", "club_members"."lead_lost_reason") = 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_members" VALIDATE CONSTRAINT "club_members_lead_fields_need_lead";--> statement-breakpoint
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_lead_lost_pair" CHECK (("club_members"."lead_lost_at" IS NULL) = ("club_members"."lead_lost_reason" IS NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_members" VALIDATE CONSTRAINT "club_members_lead_lost_pair";--> statement-breakpoint
-- No infinite date: '-infinity' as the next step would be due forever, an
-- infinite opening would freeze the stage (the 0041/0043 isfinite rule).
ALTER TABLE "club_members" ADD CONSTRAINT "club_members_lead_dates_finite" CHECK (("club_members"."lead_opened_at" IS NULL OR isfinite("club_members"."lead_opened_at"))
	    AND ("club_members"."lead_contacted_at" IS NULL OR isfinite("club_members"."lead_contacted_at"))
	    AND ("club_members"."lead_lost_at" IS NULL OR isfinite("club_members"."lead_lost_at"))
	    AND ("club_members"."lead_next_action_on" IS NULL OR isfinite("club_members"."lead_next_action_on"))) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_members" VALIDATE CONSTRAINT "club_members_lead_dates_finite";--> statement-breakpoint
CREATE INDEX "club_members_leads_idx" ON "club_members" USING btree ("club_id","lead_opened_at") WHERE "club_members"."lead_opened_at" IS NOT NULL;--> statement-breakpoint
-- The stage, derived from the books. Every lookup leads with club_id, so it
-- uses the (club_id, member_id) indexes of the four tables it reads.
CREATE VIEW "club_lead_stages" WITH (security_invoker = true) AS
SELECT
  m.id AS member_id,
  m.club_id,
  CASE
    WHEN f.won_at IS NOT NULL AND (m.lead_lost_at IS NULL OR f.won_at > m.lead_lost_at) THEN 'won'
    WHEN m.lead_lost_at IS NOT NULL THEN 'lost'
    WHEN f.visited_at IS NOT NULL THEN 'visited'
    WHEN f.trial_at IS NOT NULL THEN 'trial_booked'
    WHEN m.lead_contacted_at IS NOT NULL THEN 'contacted'
    ELSE 'new'
  END AS stage,
  f.won_at,
  f.visited_at,
  f.trial_at
FROM public.club_members m
CROSS JOIN LATERAL (
  SELECT
    (SELECT min(ms.created_at) FROM public.club_memberships ms
      WHERE ms.club_id = m.club_id AND ms.member_id = m.id AND ms.kind <> 'trial'
        AND ms.created_at >= m.lead_opened_at
        AND ms.cancel_reason IS DISTINCT FROM 'mistake') AS won_at,
    (SELECT min(ci.checked_in_at) FROM public.club_checkins ci
      WHERE ci.club_id = m.club_id AND ci.member_id = m.id
        AND ci.checked_in_at >= m.lead_opened_at) AS visited_at,
    LEAST(
      (SELECT min(b.created_at) FROM public.club_bookings b
        WHERE b.club_id = m.club_id AND b.member_id = m.id AND b.is_trial AND b.state = 'active'
          AND b.created_at >= m.lead_opened_at),
      (SELECT min(ms.created_at) FROM public.club_memberships ms
        WHERE ms.club_id = m.club_id AND ms.member_id = m.id AND ms.kind = 'trial'
          AND ms.created_at >= m.lead_opened_at
          AND ms.cancel_reason IS DISTINCT FROM 'mistake')) AS trial_at
) f
WHERE m.lead_opened_at IS NOT NULL;--> statement-breakpoint
-- ─── Conversations ───────────────────────────────────────────────────────
CREATE TABLE "club_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"started_by" text NOT NULL,
	"subject" text NOT NULL,
	"inquiry_kind" text,
	"inquiry_on" date,
	"party_size" smallint,
	"last_member_at" timestamp with time zone,
	"last_club_at" timestamp with time zone,
	"member_read_at" timestamp with time zone,
	"club_read_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"closed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_threads_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_threads_kind_known" CHECK ("club_threads"."kind" IN ('message', 'inquiry')),
	CONSTRAINT "club_threads_started_by_known" CHECK ("club_threads"."started_by" IN ('member', 'club')
	      AND ("club_threads"."kind" <> 'inquiry' OR "club_threads"."started_by" = 'member')),
	CONSTRAINT "club_threads_subject_sane" CHECK (btrim("club_threads"."subject") <> '' AND char_length("club_threads"."subject") <= 120),
	CONSTRAINT "club_threads_inquiry_kind_known" CHECK ("club_threads"."inquiry_kind" IS NULL OR "club_threads"."inquiry_kind" IN (
	      'rental', 'event', 'corporate', 'party', 'camp', 'other')),
	-- An inquiry says what it is about; only an inquiry carries a date and a party.
	CONSTRAINT "club_threads_inquiry_fields" CHECK (("club_threads"."kind" = 'inquiry') = ("club_threads"."inquiry_kind" IS NOT NULL)
	      AND ("club_threads"."kind" = 'inquiry' OR ("club_threads"."inquiry_on" IS NULL AND "club_threads"."party_size" IS NULL))),
	CONSTRAINT "club_threads_party_size_sane" CHECK ("club_threads"."party_size" IS NULL OR "club_threads"."party_size" BETWEEN 1 AND 1000),
	CONSTRAINT "club_threads_inquiry_on_finite" CHECK ("club_threads"."inquiry_on" IS NULL OR isfinite("club_threads"."inquiry_on")),
	CONSTRAINT "club_threads_closed_pair" CHECK ("club_threads"."closed_at" IS NOT NULL OR "club_threads"."closed_by" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "club_thread_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"author" text NOT NULL,
	"staff_user_id" text,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_thread_messages_club_id_unique" UNIQUE("club_id", "id"),
	-- The club's side always names who answered (by value); the member's never does.
	CONSTRAINT "club_thread_messages_author_known" CHECK ("club_thread_messages"."author" IN ('member', 'club')
	      AND ("club_thread_messages"."author" = 'club') = ("club_thread_messages"."staff_user_id" IS NOT NULL)),
	CONSTRAINT "club_thread_messages_body_sane" CHECK (btrim("club_thread_messages"."body") <> '' AND char_length("club_thread_messages"."body") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "club_threads" ADD CONSTRAINT "club_threads_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_threads" ADD CONSTRAINT "club_threads_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_thread_messages" ADD CONSTRAINT "club_thread_messages_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_thread_messages" ADD CONSTRAINT "club_thread_messages_thread_fk" FOREIGN KEY ("club_id","thread_id") REFERENCES "public"."club_threads"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_threads_member_idx" ON "club_threads" USING btree ("club_id","member_id");--> statement-breakpoint
CREATE INDEX "club_threads_club_idx" ON "club_threads" USING btree ("club_id","created_at");--> statement-breakpoint
CREATE INDEX "club_thread_messages_thread_idx" ON "club_thread_messages" USING btree ("club_id","thread_id","created_at");--> statement-breakpoint
-- A message is what was said: never edited. It goes with its thread.
CREATE FUNCTION club_thread_messages_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'club_thread_messages: a message is not edited'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'club_thread_messages_fixed';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_thread_messages_fixed" BEFORE UPDATE ON "club_thread_messages" FOR EACH ROW EXECUTE FUNCTION club_thread_messages_fixed();--> statement-breakpoint
-- The thread's markers follow every message: its author has read up to it,
-- and a member writing re-opens a closed thread. Only ever FORWARD:
-- created_at is the writing transaction's start, and two messages (or a
-- message and a read) may commit in the other order.
CREATE FUNCTION club_thread_messages_touch() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.author = 'member' THEN
    UPDATE public.club_threads
       SET last_member_at = greatest(coalesce(last_member_at, '-infinity'), NEW.created_at),
           member_read_at = greatest(coalesce(member_read_at, '-infinity'), NEW.created_at),
           closed_at = NULL, closed_by = NULL
     WHERE club_id = NEW.club_id AND id = NEW.thread_id;
  ELSE
    UPDATE public.club_threads
       SET last_club_at = greatest(coalesce(last_club_at, '-infinity'), NEW.created_at),
           club_read_at = greatest(coalesce(club_read_at, '-infinity'), NEW.created_at)
     WHERE club_id = NEW.club_id AND id = NEW.thread_id;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_thread_messages_touch" AFTER INSERT ON "club_thread_messages" FOR EACH ROW EXECUTE FUNCTION club_thread_messages_touch();--> statement-breakpoint
-- ─── Feedback ────────────────────────────────────────────────────────────
CREATE TABLE "club_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"occurrence_id" uuid,
	"reservation_id" uuid,
	"instructor_user_id" text,
	"rating" smallint NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_feedback_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_feedback_one_subject" CHECK (num_nonnulls("club_feedback"."occurrence_id", "club_feedback"."reservation_id") = 1),
	CONSTRAINT "club_feedback_rating_sane" CHECK ("club_feedback"."rating" BETWEEN 1 AND 5),
	CONSTRAINT "club_feedback_comment_sane" CHECK ("club_feedback"."comment" IS NULL OR (btrim("club_feedback"."comment") <> '' AND char_length("club_feedback"."comment") <= 500))
);
--> statement-breakpoint
ALTER TABLE "club_feedback" ADD CONSTRAINT "club_feedback_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_feedback" ADD CONSTRAINT "club_feedback_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_feedback" ADD CONSTRAINT "club_feedback_occurrence_fk" FOREIGN KEY ("club_id","occurrence_id") REFERENCES "public"."club_class_occurrences"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_feedback" ADD CONSTRAINT "club_feedback_reservation_fk" FOREIGN KEY ("club_id","reservation_id") REFERENCES "public"."club_reservations"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- One rating per client per class, and per booking. Keyed (club, subject,
-- member) so the NO ACTION checks on an occurrence or a reservation (the
-- materializer deletes future occurrences) find their rows directly; the
-- member index serves the member CASCADE.
CREATE UNIQUE INDEX "club_feedback_occurrence_unique" ON "club_feedback" USING btree ("club_id","occurrence_id","member_id") WHERE "club_feedback"."occurrence_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "club_feedback_reservation_unique" ON "club_feedback" USING btree ("club_id","reservation_id","member_id") WHERE "club_feedback"."reservation_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_feedback_member_idx" ON "club_feedback" USING btree ("club_id","member_id");--> statement-breakpoint
CREATE INDEX "club_feedback_club_idx" ON "club_feedback" USING btree ("club_id","created_at");--> statement-breakpoint
-- Only somebody who came rates: a check-in at that class by that record, or
-- that record's own confirmed reservation, already over. The trainer is the
-- database's to record, not the form's: a rating cannot be pinned on the
-- wrong person (and, never edited, stay there).
CREATE FUNCTION club_feedback_attended() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.occurrence_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.club_checkins ci
       WHERE ci.club_id = NEW.club_id AND ci.member_id = NEW.member_id
         AND ci.occurrence_id = NEW.occurrence_id
    ) THEN
      RAISE EXCEPTION 'club_feedback: only a client who came rates the class'
        USING ERRCODE = '23514', CONSTRAINT = 'club_feedback_attended';
    END IF;
    SELECT coalesce(o.instructor_user_id, k.instructor_user_id) INTO NEW.instructor_user_id
      FROM public.club_class_occurrences o
      JOIN public.club_classes k ON k.club_id = o.club_id AND k.id = o.class_id
     WHERE o.club_id = NEW.club_id AND o.id = NEW.occurrence_id;
  ELSE
    IF NOT EXISTS (
      SELECT 1 FROM public.club_reservations r
       WHERE r.club_id = NEW.club_id AND r.id = NEW.reservation_id
         AND r.member_id = NEW.member_id AND r.state = 'confirmed' AND r.ends_at <= now()
    ) THEN
      RAISE EXCEPTION 'club_feedback: only the client of a past booking rates it'
        USING ERRCODE = '23514', CONSTRAINT = 'club_feedback_attended';
    END IF;
    SELECT r.staff_user_id INTO NEW.instructor_user_id
      FROM public.club_reservations r
     WHERE r.club_id = NEW.club_id AND r.id = NEW.reservation_id;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_feedback_attended" BEFORE INSERT ON "club_feedback" FOR EACH ROW EXECUTE FUNCTION club_feedback_attended();--> statement-breakpoint
CREATE FUNCTION club_feedback_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'club_feedback: a rating is not edited'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'club_feedback_fixed';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_feedback_fixed" BEFORE UPDATE ON "club_feedback" FOR EACH ROW EXECUTE FUNCTION club_feedback_fixed();--> statement-breakpoint
-- The three shapes Google hands a business as its review link, nothing else:
-- no other page on a Google host (a redirector, an AMP viewer) can put
-- another site in front of a member as "rate us".
ALTER TABLE "clubs" ADD COLUMN "google_review_url" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD CONSTRAINT "clubs_google_review_url_sane" CHECK ("clubs"."google_review_url" IS NULL
	    OR "clubs"."google_review_url" ~ '^https://(g\.page/r/[A-Za-z0-9_-]{4,120}/review|search\.google\.com/local/writereview\?placeid=[A-Za-z0-9_-]{4,200}|maps\.app\.goo\.gl/[A-Za-z0-9]{4,40})$') NOT VALID;--> statement-breakpoint
ALTER TABLE "clubs" VALIDATE CONSTRAINT "clubs_google_review_url_sane";--> statement-breakpoint
-- ─── Vocabulary ──────────────────────────────────────────────────────────
ALTER TABLE "club_automations" DROP CONSTRAINT "club_automations_trigger_known";--> statement-breakpoint
ALTER TABLE "club_automations" ADD CONSTRAINT "club_automations_trigger_known" CHECK ("club_automations"."trigger" IN (
	    'welcome', 'trial_follow_up', 'expired_follow_up', 'win_back', 'feedback_request')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_automations" VALIDATE CONSTRAINT "club_automations_trigger_known";--> statement-breakpoint
ALTER TABLE "club_automations" DROP CONSTRAINT "club_automations_delay_sane";--> statement-breakpoint
ALTER TABLE "club_automations" ADD CONSTRAINT "club_automations_delay_sane" CHECK ("club_automations"."delay_days" BETWEEN 0 AND 365
	    AND ("club_automations"."trigger" <> 'win_back' OR "club_automations"."delay_days" >= 14)
	    AND ("club_automations"."trigger" <> 'feedback_request' OR "club_automations"."delay_days" <= 7)) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_automations" VALIDATE CONSTRAINT "club_automations_delay_sane";--> statement-breakpoint
ALTER TABLE "club_automations" ADD CONSTRAINT "club_automations_feedback_by_email" CHECK ("club_automations"."trigger" <> 'feedback_request' OR "club_automations"."channel" = 'email') NOT VALID;--> statement-breakpoint
ALTER TABLE "club_automations" VALIDATE CONSTRAINT "club_automations_feedback_by_email";--> statement-breakpoint
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
	    'inbox_message', 'inbox_reply', 'leads_due')) NOT VALID;--> statement-breakpoint
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
	    'feedback_settings_changed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_audit" VALIDATE CONSTRAINT "club_audit_action_known";--> statement-breakpoint
COMMENT ON TABLE "club_threads" IS 'A conversation between a club and one of its client records (0052): a portal message, an office message to a linked member, or an inquiry from the public page. Erased with the record.';--> statement-breakpoint
COMMENT ON TABLE "club_thread_messages" IS 'What was written in a club thread (0052), by the member or by the club (staff by value). Never edited; no application path deletes one — it goes with its thread.';--> statement-breakpoint
COMMENT ON TABLE "club_feedback" IS 'A client''s 1–5 rating of a class they came to or a past reservation of theirs (0052). Comments are private to the club; the public page shows an average only.';--> statement-breakpoint
COMMENT ON VIEW "club_lead_stages" IS 'The prospects pipeline''s stage, derived from the books (0052): won, lost, visited, trial_booked, contacted, new.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
