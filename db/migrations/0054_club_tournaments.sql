-- 0054_club_tournaments: «Клубове» v2, wave D2 (plan 2026-10-25) — a
-- tournament's draw, its results and standings, and a club rating per sport
-- (1club's tournaments and ratings; anolla's tournaments).
-- Hand-written; do not regenerate.
--
-- WHAT THIS ADDS
--
--   club_events.tournament_format
--                          single_elimination | round_robin — set when the
--                          office draws a tournament; NULL for every other
--                          event and for a tournament not drawn yet.
--   club_event_registrations.name_public_at
--                          the ENTRANT'S OWN consent to show their name in the
--                          public results («Покажи името ми»). Without it the
--                          public page says «Участник N» — the leaderboard rule
--                          of the passport (CLAUDE.md: public individual
--                          exposure needs the person's own opt-in). Only a
--                          CONFIRMED place is an entrant on any results page
--                          (apps/web/lib/clubs/tournaments.ts entrantsOf); a
--                          withdrawn one is «отказал се», never named. The
--                          registrations guard (replaced below, 0053's body
--                          plus three lines) clears the consent when the
--                          client is erased and when the place ends, and on an
--                          ended place lets it only go — so withdrawal is
--                          never refused (GDPR Art. 7(3)), and a past
--                          tournament's entrant withdraws from its page.
--                          Triggers clear it when the link it was given
--                          through goes (unlinked, the account deleted, or
--                          the link moved to another account) and when a
--                          child's guardian changes or is erased; a CHECK
--                          keeps it on live places with a client.
--   club_tournament_matches
--                          one match of a drawn tournament: round and slot, the
--                          two entrants (places of THIS event — the keys are
--                          (club_id, event_id, registration)), the scores, the
--                          winner and a status pending | played | walkover |
--                          bye, and who recorded it (staff by value). A match
--                          says what it is by CHECK: a pending match has no
--                          result; a played one two scores; a walkover a
--                          winner and no score; a bye one entrant who is its
--                          winner; a winner is always one of the two; a played
--                          match is won by the higher score and a level one is
--                          a draw. A guard keeps the flows the application
--                          keeps: a recorded result is never deleted (except by
--                          the club's purge) nor withdrawn, a match
--                          keeps its place in the draw, belongs to a DRAWN
--                          tournament, and is never a draw in an elimination;
--                          and a tournament keeps its format while it has
--                          matches. Sizes: the draw code caps a tournament at
--                          128 entrants (TOURNAMENT_ENTRANTS_MAX) — round 127
--                          and slot 63 at most, inside the CHECK's 300.
--
-- The standings and the ratings are DERIVED (0039 rule 3), never stored:
-- lib/src/clubs/tournament.ts folds the matches on every read, so a corrected
-- result corrects everything after it.
--
--   Vocabulary: audit actions tournament_drawn, match_recorded,
--   name_visibility_changed.
--
-- TENANCY: club_tournament_matches carries club_id with its own club_id →
-- clubs CASCADE (the purge empties it in its first round, 0049's header); its
-- keys to club_events and club_event_registrations are composite and NO ACTION
-- (nothing deletes an event or a place; erasure only clears a place's client,
-- so a match keeps its entrant, anonymised). No column references users:
-- recorded_by is a staff id BY VALUE (0039 rule 5).
--
-- Locking: club_staff first (ACCESS EXCLUSIVE), the order 0045–0053 keep for
-- account erasure; then SHARE ROW EXCLUSIVE on club_members and
-- club_member_links (new triggers) — BEFORE club_audit, because every path
-- that writes a client or a link (an edit, an erasure, a claim, an invite,
-- an unlink) writes it first and its audit row after; then club_audit (a
-- CHECK swap — VALIDATE scans it); then SHARE ROW EXCLUSIVE on clubs (the new
-- club_id key — 0053's order); then ACCESS EXCLUSIVE on club_events and
-- club_event_registrations (a column, a CHECK, a unique key for the new
-- foreign keys, a replaced guard, a new trigger) — the new triggers write
-- registrations after a client or a link, the order of every such path — all
-- until COMMIT. A registration, a club settings save, an unlink, a claim or
-- an erasure in flight at that instant may deadlock with this file; Postgres
-- aborts one side after ~1 s and the deploy is re-run. Deploy at a quiet
-- hour, never during a club purge.
--
-- rollback (after reverting the application), in ONE explicit transaction, at
-- a quiet hour. Dropping the table drops its keys' triggers on clubs,
-- club_events and club_event_registrations, and the dropped triggers hold
-- club_members and club_member_links — ACCESS EXCLUSIVE on all five until
-- COMMIT: every clubs-module read, and every portal read of a member's link,
-- waits meanwhile:
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;
--   LOCK TABLE "club_members", "club_member_links", "clubs", "club_events",
--     "club_event_registrations", "club_tournament_matches" IN ACCESS EXCLUSIVE MODE;
--   DROP TRIGGER "club_events_format_guard" ON "club_events";
--   DROP TRIGGER "club_member_links_clear_names" ON "club_member_links";
--   DROP TRIGGER "club_members_clear_names" ON "club_members";
--   -- before the column they clear:
--   DROP FUNCTION club_member_links_clear_names(); DROP FUNCTION club_members_clear_names();
--   DROP FUNCTION club_event_names_clear(uuid, uuid[]);
--   DROP TABLE "club_tournament_matches";        -- DESTRUCTIVE: every draw and result
--   DROP FUNCTION club_tournament_matches_guard(); DROP FUNCTION club_events_format_guard();
--   -- 0053's guard body back BEFORE the column goes — copy
--   -- 0053_club_events.sql lines 447–502 (CREATE FUNCTION
--   -- club_event_registrations_guard … $$;) with CREATE changed to CREATE OR
--   -- REPLACE, NOT this file's body: this file's names name_public_at, and
--   -- every UPDATE of a registration (a payment confirming a hold, erasure's
--   -- SET NULL) would fail without it.
--   ALTER TABLE "club_event_registrations" DROP CONSTRAINT "club_event_registrations_event_unique",
--     DROP CONSTRAINT "club_event_registrations_name_public_finite",
--     DROP CONSTRAINT "club_event_registrations_name_public_live",
--     DROP COLUMN "name_public_at";               -- DESTRUCTIVE: the consents (names
--                                                 -- revert to «Участник N», the safe way)
--   ALTER TABLE "club_events" DROP CONSTRAINT "club_events_tournament_format",
--     DROP COLUMN "tournament_format";            -- DESTRUCTIVE: which format was drawn
--   The widened club_audit_action_known STAYS (a superset is harmless; the
--   audit log is append-only). The 0054 row stays in
--   drizzle.__drizzle_migrations: a corrective migration needs a journal
--   `when` above 1785192000000, or the migrator skips it.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_members", "club_member_links" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_audit" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "clubs" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_events", "club_event_registrations" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "club_events" ADD COLUMN "tournament_format" text;--> statement-breakpoint
ALTER TABLE "club_events" ADD CONSTRAINT "club_events_tournament_format" CHECK ("club_events"."tournament_format" IS NULL
	    OR ("club_events"."kind" = 'tournament' AND "club_events"."tournament_format" IN ('single_elimination', 'round_robin'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_events" VALIDATE CONSTRAINT "club_events_tournament_format";--> statement-breakpoint
ALTER TABLE "club_event_registrations" ADD COLUMN "name_public_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "club_event_registrations" ADD CONSTRAINT "club_event_registrations_name_public_finite" CHECK ("club_event_registrations"."name_public_at" IS NULL OR isfinite("club_event_registrations"."name_public_at")) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_event_registrations" VALIDATE CONSTRAINT "club_event_registrations_name_public_finite";--> statement-breakpoint
-- The consent belongs to a live place with a client (the guard below clears
-- it before this is checked, so no withdrawal is ever refused).
ALTER TABLE "club_event_registrations" ADD CONSTRAINT "club_event_registrations_name_public_live" CHECK ("club_event_registrations"."name_public_at" IS NULL
	    OR ("club_event_registrations"."member_id" IS NOT NULL
	        AND "club_event_registrations"."state" IN ('held', 'confirmed', 'waitlisted'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_event_registrations" VALIDATE CONSTRAINT "club_event_registrations_name_public_live";--> statement-breakpoint
ALTER TABLE "club_event_registrations" ADD CONSTRAINT "club_event_registrations_event_unique" UNIQUE ("club_id", "event_id", "id");--> statement-breakpoint
-- 0053's guard, with the consent: erasure takes it with the client (as the
-- team name), a place that ends takes it with the place, and on an ended
-- place it can only go — never a new one. Everything else is 0053's body
-- unchanged.
CREATE OR REPLACE FUNCTION club_event_registrations_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  probe public.club_event_registrations%ROWTYPE;
  erased boolean := NEW.member_id IS NULL AND OLD.member_id IS NOT NULL;
BEGIN
  -- Erasing the client erases a team name with it (it may be their own name),
  -- and the consent to show a name.
  IF erased THEN
    NEW.team_name := NULL;
    NEW.name_public_at := NULL;
  END IF;
  -- Only a confirmed place is an entrant, so an ended place's consent would
  -- never be read again — and the place leaves the portal, where it is
  -- withdrawn. It ends with the place.
  IF NEW.state IN ('cancelled', 'late_cancelled', 'expired') THEN
    NEW.name_public_at := NULL;
  END IF;
  IF OLD.state IN ('cancelled', 'late_cancelled', 'expired') THEN
    probe := NEW;
    probe.member_id := OLD.member_id;
    IF erased THEN
      probe.team_name := OLD.team_name;
    END IF;
    -- Cleared just above: a consent on an ended place may only go.
    probe.name_public_at := OLD.name_public_at;
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
CREATE TABLE "club_tournament_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"round" smallint NOT NULL,
	"slot" smallint NOT NULL,
	"entrant_a" uuid,
	"entrant_b" uuid,
	"score_a" integer,
	"score_b" integer,
	"winner" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"recorded_by" text,
	"recorded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_tournament_matches_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_tournament_matches_position_unique" UNIQUE("club_id", "event_id", "round", "slot"),
	CONSTRAINT "club_tournament_matches_position_sane" CHECK ("club_tournament_matches"."round" BETWEEN 1 AND 300
	      AND "club_tournament_matches"."slot" BETWEEN 0 AND 300),
	CONSTRAINT "club_tournament_matches_status_known" CHECK ("club_tournament_matches"."status" IN ('pending', 'played', 'walkover', 'bye')),
	CONSTRAINT "club_tournament_matches_two_entrants" CHECK ("club_tournament_matches"."entrant_a" IS DISTINCT FROM "club_tournament_matches"."entrant_b"
	      OR "club_tournament_matches"."entrant_a" IS NULL),
	CONSTRAINT "club_tournament_matches_scores_sane" CHECK ((("club_tournament_matches"."score_a" IS NULL) = ("club_tournament_matches"."score_b" IS NULL))
	      AND ("club_tournament_matches"."score_a" IS NULL OR ("club_tournament_matches"."score_a" BETWEEN 0 AND 1000
	           AND "club_tournament_matches"."score_b" BETWEEN 0 AND 1000))),
	-- What the status says, the row holds.
	CONSTRAINT "club_tournament_matches_result_shape" CHECK (CASE "club_tournament_matches"."status"
	      WHEN 'pending' THEN "club_tournament_matches"."score_a" IS NULL AND "club_tournament_matches"."winner" IS NULL
	      WHEN 'played' THEN "club_tournament_matches"."score_a" IS NOT NULL
	                     AND "club_tournament_matches"."entrant_a" IS NOT NULL AND "club_tournament_matches"."entrant_b" IS NOT NULL
	      WHEN 'walkover' THEN "club_tournament_matches"."score_a" IS NULL AND "club_tournament_matches"."winner" IS NOT NULL
	                       AND "club_tournament_matches"."entrant_a" IS NOT NULL AND "club_tournament_matches"."entrant_b" IS NOT NULL
	      -- IS NOT DISTINCT FROM, not =: a NULL winner must fail here, not pass
	      -- as an unknown (the coalesce is never NULL with one entrant).
	      WHEN 'bye' THEN "club_tournament_matches"."score_a" IS NULL
	                  AND num_nonnulls("club_tournament_matches"."entrant_a", "club_tournament_matches"."entrant_b") = 1
	                  AND "club_tournament_matches"."winner" IS NOT DISTINCT FROM coalesce("club_tournament_matches"."entrant_a", "club_tournament_matches"."entrant_b")
	      ELSE false END),
	-- A winner is one of the two who played.
	CONSTRAINT "club_tournament_matches_winner_entrant" CHECK ("club_tournament_matches"."winner" IS NULL
	      OR "club_tournament_matches"."winner" IS NOT DISTINCT FROM "club_tournament_matches"."entrant_a"
	      OR "club_tournament_matches"."winner" IS NOT DISTINCT FROM "club_tournament_matches"."entrant_b"),
	-- A played match is won by the higher score, and a level one is a draw
	-- (lib/src/clubs/tournament.ts scoreWinner) — the ratings fold these rows.
	CONSTRAINT "club_tournament_matches_winner_by_score" CHECK ("club_tournament_matches"."status" <> 'played'
	      OR CASE WHEN "club_tournament_matches"."score_a" > "club_tournament_matches"."score_b"
	                THEN "club_tournament_matches"."winner" IS NOT DISTINCT FROM "club_tournament_matches"."entrant_a"
	              WHEN "club_tournament_matches"."score_b" > "club_tournament_matches"."score_a"
	                THEN "club_tournament_matches"."winner" IS NOT DISTINCT FROM "club_tournament_matches"."entrant_b"
	              ELSE "club_tournament_matches"."winner" IS NULL END),
	CONSTRAINT "club_tournament_matches_recorded_pair" CHECK (("club_tournament_matches"."status" IN ('played', 'walkover'))
	      = ("club_tournament_matches"."recorded_at" IS NOT NULL)),
	CONSTRAINT "club_tournament_matches_recorded_sane" CHECK (("club_tournament_matches"."recorded_at" IS NULL OR isfinite("club_tournament_matches"."recorded_at"))
	      AND ("club_tournament_matches"."recorded_by" IS NULL OR "club_tournament_matches"."recorded_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "club_tournament_matches" ADD CONSTRAINT "club_tournament_matches_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_tournament_matches" ADD CONSTRAINT "club_tournament_matches_event_fk" FOREIGN KEY ("club_id","event_id") REFERENCES "public"."club_events"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- An entrant and a winner are places of THIS event.
ALTER TABLE "club_tournament_matches" ADD CONSTRAINT "club_tournament_matches_entrant_a_fk" FOREIGN KEY ("club_id","event_id","entrant_a") REFERENCES "public"."club_event_registrations"("club_id","event_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_tournament_matches" ADD CONSTRAINT "club_tournament_matches_entrant_b_fk" FOREIGN KEY ("club_id","event_id","entrant_b") REFERENCES "public"."club_event_registrations"("club_id","event_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_tournament_matches" ADD CONSTRAINT "club_tournament_matches_winner_fk" FOREIGN KEY ("club_id","event_id","winner") REFERENCES "public"."club_event_registrations"("club_id","event_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_tournament_matches_entrant_a_idx" ON "club_tournament_matches" USING btree ("club_id","entrant_a") WHERE "club_tournament_matches"."entrant_a" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_tournament_matches_entrant_b_idx" ON "club_tournament_matches" USING btree ("club_id","entrant_b") WHERE "club_tournament_matches"."entrant_b" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_tournament_matches_winner_idx" ON "club_tournament_matches" USING btree ("club_id","winner") WHERE "club_tournament_matches"."winner" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_tournament_matches_recorded_idx" ON "club_tournament_matches" USING btree ("club_id","recorded_at") WHERE "club_tournament_matches"."recorded_at" IS NOT NULL;--> statement-breakpoint
CREATE TRIGGER "club_tournament_matches_set_updated_at" BEFORE UPDATE ON "club_tournament_matches" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- The flows the application keeps, held here too: a recorded result is never
-- deleted, nor turned back into a pending match, nor given other entrants (a
-- re-draw removes only pending matches and byes — the club's ratings are
-- folded from every result, so a lost one would rewrite them); a match keeps
-- its place in the draw; it belongs to a DRAWN tournament; and an elimination
-- match is never a draw. A purge of the club deletes freely. The event read
-- is FOR SHARE, so a format changing at the same instant waits (the
-- application already holds the event lock, apps/web/lib/clubs/tournaments.ts).
CREATE FUNCTION club_tournament_matches_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  fmt text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('played', 'walkover')
       AND OLD.club_id::text IS DISTINCT FROM current_setting('pops.purging_club', true) THEN
      RAISE EXCEPTION 'club_tournament_matches: a recorded result is never deleted'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'club_tournament_matches_kept';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.club_id IS DISTINCT FROM OLD.club_id OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.round IS DISTINCT FROM OLD.round OR NEW.slot IS DISTINCT FROM OLD.slot) THEN
    RAISE EXCEPTION 'club_tournament_matches: a match keeps its place in the draw'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_tournament_matches_kept';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('played', 'walkover')
     AND (NEW.status NOT IN ('played', 'walkover')
          OR NEW.entrant_a IS DISTINCT FROM OLD.entrant_a
          OR NEW.entrant_b IS DISTINCT FROM OLD.entrant_b) THEN
    RAISE EXCEPTION 'club_tournament_matches: a recorded result is corrected, never withdrawn'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_tournament_matches_kept';
  END IF;
  SELECT e.tournament_format INTO fmt FROM public.club_events e
   WHERE e.club_id = NEW.club_id AND e.id = NEW.event_id AND e.kind = 'tournament'
     FOR NO KEY UPDATE;
  IF fmt IS NULL THEN
    RAISE EXCEPTION 'club_tournament_matches: a match belongs to a drawn tournament'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_tournament_matches_drawn';
  END IF;
  IF fmt = 'single_elimination' AND NEW.status = 'played' AND NEW.winner IS NULL THEN
    RAISE EXCEPTION 'club_tournament_matches: an elimination match has a winner'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_tournament_matches_decisive';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_tournament_matches_guard" BEFORE INSERT OR UPDATE OR DELETE ON "club_tournament_matches" FOR EACH ROW EXECUTE FUNCTION club_tournament_matches_guard();--> statement-breakpoint
CREATE TRIGGER "club_tournament_matches_no_truncate" BEFORE TRUNCATE ON "club_tournament_matches" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
-- A drawn tournament keeps its format while it has matches (a re-draw
-- removes them first): the matches were drawn for it.
CREATE FUNCTION club_events_format_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.tournament_format IS DISTINCT FROM OLD.tournament_format AND EXISTS (
    SELECT 1 FROM public.club_tournament_matches tm
     WHERE tm.club_id = OLD.club_id AND tm.event_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'club_events: a drawn tournament keeps its format while it has matches'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_events_tournament_format_kept';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_events_format_guard" BEFORE UPDATE OF "tournament_format" ON "club_events" FOR EACH ROW EXECUTE FUNCTION club_events_format_guard();--> statement-breakpoint
-- A consent is withdrawn through the link it was given through. Clearing too
-- much is the safe way; a purge deletes the rows anyway. The places are locked
-- by id first (0053's order inside a set), never the event: no seat moves.
CREATE FUNCTION club_event_names_clear(p_club uuid, p_members uuid[]) RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1 FROM public.club_event_registrations er
    WHERE er.club_id = p_club AND er.member_id = ANY (p_members) AND er.name_public_at IS NOT NULL
    ORDER BY er.id FOR NO KEY UPDATE;
  UPDATE public.club_event_registrations er
     SET name_public_at = NULL
   WHERE er.club_id = p_club AND er.member_id = ANY (p_members) AND er.name_public_at IS NOT NULL;
END;
$$;--> statement-breakpoint
-- When a live link goes — unlinked from the portal or the desk, the account
-- deleted (the users key cascades here), or the link moved to another
-- account — every consent it could have given goes with it: its client's
-- and, for a guardian's link, the children's.
CREATE FUNCTION club_member_links_clear_names() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.status <> 'active'
     OR OLD.club_id::text IS NOT DISTINCT FROM current_setting('pops.purging_club', true)
     OR (TG_OP = 'UPDATE' AND NEW.status = 'active' AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id) THEN
    RETURN NULL;
  END IF;
  PERFORM club_event_names_clear(OLD.club_id, ARRAY(
    SELECT m.id FROM public.club_members m
     WHERE m.club_id = OLD.club_id
       AND (m.id = OLD.member_id OR m.guardian_member_id = OLD.member_id)));
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_member_links_clear_names" AFTER UPDATE OF "status", "user_id" OR DELETE ON "club_member_links" FOR EACH ROW EXECUTE FUNCTION club_member_links_clear_names();--> statement-breakpoint
-- And when a child's guardian changes or goes — the desk edits it, or the
-- guardian is erased (the guardian key SETs NULL, which fires this): a
-- consent the old guardian gave is not the new one's.
CREATE FUNCTION club_members_clear_names() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.guardian_member_id IS NULL
     OR NEW.guardian_member_id IS NOT DISTINCT FROM OLD.guardian_member_id
     OR OLD.club_id::text IS NOT DISTINCT FROM current_setting('pops.purging_club', true) THEN
    RETURN NULL;
  END IF;
  PERFORM club_event_names_clear(NEW.club_id, ARRAY[NEW.id]);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_members_clear_names" AFTER UPDATE OF "guardian_member_id" ON "club_members" FOR EACH ROW EXECUTE FUNCTION club_members_clear_names();--> statement-breakpoint
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
	    'event_registration_cancelled',
	    'tournament_drawn', 'match_recorded', 'name_visibility_changed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_audit" VALIDATE CONSTRAINT "club_audit_action_known";--> statement-breakpoint
COMMENT ON TABLE "club_tournament_matches" IS 'One match of a drawn club tournament (0054): round, slot, two entrants (places of the event), scores, winner, status. Standings and ratings are derived from these rows, never stored.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
