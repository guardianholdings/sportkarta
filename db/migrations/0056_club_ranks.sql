-- 0056_club_ranks: «Клубове» v2, wave G2 (plan 2026-10-25) — ranks and belts
-- (1club's belt tracking): a club's grading ladders (judo's kyu belts, BJJ's
-- belts and stripes), what each rank asks before it is awarded, the ranks its
-- clients were awarded, and a «Готови за изпит» list DERIVED from attendance.
-- Hand-written; do not regenerate.
--
-- WHAT THIS ADDS
--
--   club_rank_ladders   a grading ladder: its name (bg, optional en) and the
--                       sport whose classes count toward it (a club_classes
--                       sport; NULL — every check-in at the club counts, open
--                       gym included). Archived, it leaves the award forms and
--                       the exam list; its ranks and awards stay.
--   club_ranks          one rank of a ladder: its place (`position`, the next
--                       one at the end, numbered by the database under the
--                       ladder's row lock; a move swaps two places in one
--                       statement — the place key is DEFERRABLE INITIALLY
--                       IMMEDIATE so a swap is checked at the statement's
--                       end), its name, its colour and an optional accent (a
--                       two-tone kids' belt, a tip) from a CLOSED palette — CSS
--                       tokens, never a colour a club types — and stripes (0–6,
--                       a BJJ belt's degrees). What it asks before it is
--                       awarded: min_attendances check-ins and/or min_months
--                       at the rank before it (both NULL: the coach decides,
--                       and the rank never shows on the exam list). At most 40
--                       to a ladder. A rank that has an award (a revoked one
--                       too) cannot be removed (the awards' key, NO ACTION) —
--                       it can be renamed and recoloured; once its holders'
--                       records are erased, it can go. A rank never moves to
--                       another ladder (club_ranks_keep_ladder).
--   club_member_ranks   an award: the client, the rank (of THIS ladder — a
--                       composite key), the day (awarded_on, a civil Sofia
--                       date, never in the future; a past day records a rank
--                       held before, reason 'prior'), why (exam | promotion |
--                       prior), who recorded it (staff id BY VALUE, 0039 rule
--                       5; NULL for a future integration) and when (the
--                       database's clock). Append-only: an award is never
--                       edited — a mistaken one is REVOKED (revoked_at, stamped
--                       by the database, and revoked_by, once) and stops
--                       counting. One live award of a rank per client per day
--                       (a second submit is the same award). Only for a live
--                       record on a live ladder (read, not locked: an archive
--                       committing at that instant may let one land, which is
--                       harmless). It goes with the client's
--                       record when the club erases it (CASCADE — 0055's rule)
--                       and with the club.
--   club_member_rank_progress
--                       derived (0039 rule 3, security_invoker): each live
--                       client's CURRENT rank on each live ladder — their
--                       newest award not revoked, by awarded_on, then by when
--                       it was recorded — the next rank by position, their
--                       check-ins on or after that day (at a class of the
--                       ladder's sport, when it has one), the day the months
--                       ask is met, and `ready`: a next rank exists, it asks
--                       something, and every ask is met. The exam list, the
--                       member card and the portal read it; nothing stores
--                       "ready", and nothing is refused for it — the coach
--                       awards whatever rank they decide.
--
-- "Current" is the newest award by date, not the highest place: a rank held
-- before and recorded later ('prior') or a revoked mistake both resolve the
-- way the history reads, and a reordered ladder changes only what comes NEXT.
--
--   Vocabulary: audit actions ladder_saved, ladder_archived, ladder_restored,
--   rank_saved, rank_moved, rank_removed, rank_awarded, rank_revoked.
--
-- TENANCY: each new table carries club_id with its own club_id → clubs
-- CASCADE, so the purge empties all three in its first round (0049's header);
-- the keys between them are composite (club_id, …) and NO ACTION — a rank
-- names its own club's ladder, an award that ladder's rank and the club's own
-- client (CASCADE: the record's erasure takes it). No column references users:
-- created_by, awarded_by and revoked_by are staff ids BY VALUE.
--
-- Locking: 0055's order — club_staff first (ACCESS EXCLUSIVE; every
-- staff-scoped statement reads it, which serialises a client's erasure with
-- this file), then SHARE ROW EXCLUSIVE on club_members (a new key), then
-- club_audit (a CHECK swap — VALIDATE scans it), then SHARE ROW EXCLUSIVE on
-- clubs (the new keys). The view reads club_checkins, club_class_occurrences
-- and club_classes and locks none of them beyond ACCESS SHARE. A client edit,
-- or a write to clubs followed by an audit row, in flight at that instant may
-- deadlock with this file; Postgres aborts one side after ~1 s and the deploy
-- is re-run. Deploy at a quiet hour, never during a club purge.
--
-- rollback (after reverting the application), in ONE explicit transaction, at
-- a quiet hour. The awards are the clubs' records of their students' grades:
-- RETIRE the three tables (renamed, with their indexes, their triggers dropped
-- with the functions) and drop them in a later migration once the clubs have
-- exported them. The member key STAYS, so a client's erasure still takes their
-- awards from the retired table. A rename is catalogue-only. COPYING rows
-- back (a re-creation, a data-only or single-table restore, an INSERT …
-- SELECT) must run with the triggers off (pg_restore --disable-triggers, or
-- session_replication_role = replica — superuser, or a granted SET on PG15+;
-- replica mode skips the key checks too): the insert stamps re-number the ranks,
-- re-stamp created_at and un-revoke every award. A full pg_dump restore is
-- safe — it creates the triggers after the data.
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   DROP VIEW "club_member_rank_progress";
--   ALTER TABLE "club_member_ranks" RENAME TO "club_member_ranks_0056_retired";
--   ALTER TABLE "club_ranks" RENAME TO "club_ranks_0056_retired";
--   ALTER TABLE "club_rank_ladders" RENAME TO "club_rank_ladders_0056_retired";
--   -- Indexes keep their names on a rename; free them for a re-creation:
--   ALTER INDEX "club_rank_ladders_pkey" RENAME TO "club_rank_ladders_0056_retired_pkey";
--   ALTER INDEX "club_rank_ladders_club_id_unique" RENAME TO "club_rank_ladders_0056_retired_club_id_unique";
--   ALTER INDEX "club_ranks_pkey" RENAME TO "club_ranks_0056_retired_pkey";
--   ALTER INDEX "club_ranks_club_id_unique" RENAME TO "club_ranks_0056_retired_club_id_unique";
--   ALTER INDEX "club_ranks_ladder_unique" RENAME TO "club_ranks_0056_retired_ladder_unique";
--   ALTER INDEX "club_ranks_position_unique" RENAME TO "club_ranks_0056_retired_position_unique";
--   ALTER INDEX "club_member_ranks_pkey" RENAME TO "club_member_ranks_0056_retired_pkey";
--   ALTER INDEX "club_member_ranks_club_id_unique" RENAME TO "club_member_ranks_0056_retired_club_id_unique";
--   ALTER INDEX "club_member_ranks_once" RENAME TO "club_member_ranks_0056_retired_once";
--   ALTER INDEX "club_member_ranks_current_idx" RENAME TO "club_member_ranks_0056_retired_current_idx";
--   ALTER INDEX "club_member_ranks_rank_idx" RENAME TO "club_member_ranks_0056_retired_rank_idx";
--   DROP FUNCTION club_ranks_stamp() CASCADE; DROP FUNCTION club_ranks_keep_ladder() CASCADE;
--   DROP FUNCTION club_member_ranks_stamp() CASCADE; DROP FUNCTION club_member_ranks_fixed() CASCADE;
--   The widened club_audit_action_known STAYS (a superset is harmless; the
--   audit log is append-only). The 0056 row stays in
--   drizzle.__drizzle_migrations: a corrective migration needs a journal
--   `when` above 1785199200000, or the migrator skips it.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_members" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_audit" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "clubs" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- ─── Ladders ─────────────────────────────────────────────────────────────
CREATE TABLE "club_rank_ladders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name_bg" text NOT NULL,
	"name_en" text,
	"sport" text,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_rank_ladders_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_rank_ladders_name_sane" CHECK (btrim("club_rank_ladders"."name_bg") <> '' AND char_length("club_rank_ladders"."name_bg") <= 80
	      AND "club_rank_ladders"."name_bg" !~ '[[:cntrl:]]'
	      AND ("club_rank_ladders"."name_en" IS NULL OR (btrim("club_rank_ladders"."name_en") <> '' AND char_length("club_rank_ladders"."name_en") <= 80
	           AND "club_rank_ladders"."name_en" !~ '[[:cntrl:]]'))),
	-- club_classes_sport_format (0042): the classes it counts are matched by it.
	CONSTRAINT "club_rank_ladders_sport_format" CHECK ("club_rank_ladders"."sport" IS NULL OR "club_rank_ladders"."sport" ~ '^[a-z][a-z0-9_]{1,29}$'),
	CONSTRAINT "club_rank_ladders_archived_finite" CHECK ("club_rank_ladders"."archived_at" IS NULL OR isfinite("club_rank_ladders"."archived_at"))
);
--> statement-breakpoint
ALTER TABLE "club_rank_ladders" ADD CONSTRAINT "club_rank_ladders_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER "club_rank_ladders_set_updated_at" BEFORE UPDATE ON "club_rank_ladders" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- ─── Ranks ───────────────────────────────────────────────────────────────
CREATE TABLE "club_ranks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"ladder_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"name_bg" text NOT NULL,
	"name_en" text,
	"colour" text NOT NULL,
	"accent" text,
	"stripes" smallint DEFAULT 0 NOT NULL,
	"min_attendances" integer,
	"min_months" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_ranks_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_ranks_ladder_unique" UNIQUE("club_id", "ladder_id", "id"),
	-- Checked at the end of a statement, so one UPDATE can swap two places.
	CONSTRAINT "club_ranks_position_unique" UNIQUE("club_id", "ladder_id", "position") DEFERRABLE INITIALLY IMMEDIATE,
	CONSTRAINT "club_ranks_position_sane" CHECK ("club_ranks"."position" BETWEEN 1 AND 32767),
	CONSTRAINT "club_ranks_name_sane" CHECK (btrim("club_ranks"."name_bg") <> '' AND char_length("club_ranks"."name_bg") <= 60
	      AND "club_ranks"."name_bg" !~ '[[:cntrl:]]'
	      AND ("club_ranks"."name_en" IS NULL OR (btrim("club_ranks"."name_en") <> '' AND char_length("club_ranks"."name_en") <= 60
	           AND "club_ranks"."name_en" !~ '[[:cntrl:]]'))),
	-- The belt palette: CSS tokens (--belt-*), never a colour a club types.
	CONSTRAINT "club_ranks_colour_known" CHECK ("club_ranks"."colour" IN ('white', 'grey', 'yellow', 'orange', 'red', 'green', 'blue', 'purple', 'brown', 'black')),
	CONSTRAINT "club_ranks_accent_known" CHECK ("club_ranks"."accent" IS NULL OR ("club_ranks"."accent" IN ('white', 'grey', 'yellow', 'orange', 'red', 'green', 'blue', 'purple', 'brown', 'black')
	      AND "club_ranks"."accent" <> "club_ranks"."colour")),
	CONSTRAINT "club_ranks_stripes_sane" CHECK ("club_ranks"."stripes" BETWEEN 0 AND 6),
	CONSTRAINT "club_ranks_attendances_sane" CHECK ("club_ranks"."min_attendances" IS NULL OR "club_ranks"."min_attendances" BETWEEN 1 AND 1000),
	CONSTRAINT "club_ranks_months_sane" CHECK ("club_ranks"."min_months" IS NULL OR "club_ranks"."min_months" BETWEEN 1 AND 240)
);
--> statement-breakpoint
ALTER TABLE "club_ranks" ADD CONSTRAINT "club_ranks_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_ranks" ADD CONSTRAINT "club_ranks_ladder_fk" FOREIGN KEY ("club_id","ladder_id") REFERENCES "public"."club_rank_ladders"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER "club_ranks_set_updated_at" BEFORE UPDATE ON "club_ranks" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- A new rank goes to the end of a live ladder, numbered under the ladder's row
-- lock (so two at once never take one place — under READ COMMITTED, the app's
-- isolation; a REPEATABLE READ caller would read max() from its old snapshot
-- and fail on club_ranks_position_unique), 40 at most. Must stay VOLATILE
-- (the default): a STABLE one would read max() from before the lock wait.
CREATE FUNCTION club_ranks_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  taken integer;
BEGIN
  PERFORM 1 FROM public.club_rank_ladders l
    WHERE l.club_id = NEW.club_id AND l.id = NEW.ladder_id AND l.archived_at IS NULL
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'club_ranks: a rank is added to a live ladder only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_ranks_live_ladder';
  END IF;
  SELECT count(*), coalesce(max(r.position), 0) + 1 INTO taken, NEW.position
    FROM public.club_ranks r
   WHERE r.club_id = NEW.club_id AND r.ladder_id = NEW.ladder_id;
  IF taken >= 40 THEN
    RAISE EXCEPTION 'club_ranks: a ladder has at most 40 ranks'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_ranks_too_many';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_ranks_stamp" BEFORE INSERT ON "club_ranks" FOR EACH ROW EXECUTE FUNCTION club_ranks_stamp();--> statement-breakpoint
-- A rank stays in its club and on its ladder: moved, it would dodge the cap,
-- land on an archived ladder, or change what an award of it means.
CREATE FUNCTION club_ranks_keep_ladder() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.club_id IS DISTINCT FROM OLD.club_id OR NEW.ladder_id IS DISTINCT FROM OLD.ladder_id THEN
    RAISE EXCEPTION 'club_ranks: a rank stays on its ladder'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_ranks_keep_ladder';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_ranks_keep_ladder" BEFORE UPDATE ON "club_ranks" FOR EACH ROW EXECUTE FUNCTION club_ranks_keep_ladder();--> statement-breakpoint
-- ─── Awards ──────────────────────────────────────────────────────────────
CREATE TABLE "club_member_ranks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"ladder_id" uuid NOT NULL,
	"rank_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"awarded_on" date NOT NULL,
	"reason" text NOT NULL,
	"awarded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "club_member_ranks_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_member_ranks_reason_known" CHECK ("club_member_ranks"."reason" IN ('exam', 'promotion', 'prior')),
	CONSTRAINT "club_member_ranks_day_sane" CHECK ("club_member_ranks"."awarded_on" BETWEEN DATE '1950-01-01' AND DATE '2100-01-01'),
	-- Who revoked it only with when.
	CONSTRAINT "club_member_ranks_revoked_pair" CHECK ("club_member_ranks"."revoked_by" IS NULL OR "club_member_ranks"."revoked_at" IS NOT NULL),
	CONSTRAINT "club_member_ranks_created_finite" CHECK (isfinite("club_member_ranks"."created_at")),
	CONSTRAINT "club_member_ranks_revoked_finite" CHECK ("club_member_ranks"."revoked_at" IS NULL OR isfinite("club_member_ranks"."revoked_at"))
);
--> statement-breakpoint
ALTER TABLE "club_member_ranks" ADD CONSTRAINT "club_member_ranks_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A rank of THIS ladder; a rank an award names (a revoked one too) stays.
ALTER TABLE "club_member_ranks" ADD CONSTRAINT "club_member_ranks_rank_fk" FOREIGN KEY ("club_id","ladder_id","rank_id") REFERENCES "public"."club_ranks"("club_id","ladder_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The club's own client; the club's erasure of the record takes the award.
ALTER TABLE "club_member_ranks" ADD CONSTRAINT "club_member_ranks_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The current award per client and ladder (the progress view's DISTINCT ON),
-- a client's history, and the member key's cascade — NOT partial, so the
-- erasure and the purge use it (revoked rows are rare and filtered).
CREATE INDEX "club_member_ranks_current_idx" ON "club_member_ranks" USING btree ("club_id","member_id","ladder_id","awarded_on" DESC,"created_at" DESC,"id" DESC);--> statement-breakpoint
-- Holders of a rank, and the rank key's NO ACTION check when a rank is removed.
CREATE INDEX "club_member_ranks_rank_idx" ON "club_member_ranks" USING btree ("club_id","ladder_id","rank_id");--> statement-breakpoint
-- One live award of a rank per client per day: a second submit is the same act.
CREATE UNIQUE INDEX "club_member_ranks_once" ON "club_member_ranks" USING btree ("club_id","member_id","rank_id","awarded_on") WHERE "club_member_ranks"."revoked_at" IS NULL;--> statement-breakpoint
-- What an award says, the database decides: a live client on a live ladder,
-- a day that is not in the future (Sofia), the time read here, not revoked.
CREATE FUNCTION club_member_ranks_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.club_rank_ladders l
                  WHERE l.club_id = NEW.club_id AND l.id = NEW.ladder_id AND l.archived_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM public.club_members m
                     WHERE m.club_id = NEW.club_id AND m.id = NEW.member_id AND m.archived_at IS NULL) THEN
    RAISE EXCEPTION 'club_member_ranks: a rank is awarded to a live client on a live ladder only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_member_ranks_live';
  END IF;
  IF NEW.awarded_on > (clock_timestamp() AT TIME ZONE 'Europe/Sofia')::date THEN
    RAISE EXCEPTION 'club_member_ranks: an award is never dated in the future'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_member_ranks_not_future';
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.revoked_at := NULL;
  NEW.revoked_by := NULL;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_member_ranks_stamp" BEFORE INSERT ON "club_member_ranks" FOR EACH ROW EXECUTE FUNCTION club_member_ranks_stamp();--> statement-breakpoint
-- Never edited: the one change is a revocation, once, stamped with the
-- database's clock. Deleted only with its client's record (the record's key
-- cascades here once the record is gone) or with the club.
CREATE FUNCTION club_member_ranks_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.club_id::text = current_setting('pops.purging_club', true)
       OR NOT EXISTS (SELECT 1 FROM public.club_members m
                       WHERE m.club_id = OLD.club_id AND m.id = OLD.member_id) THEN
      RETURN OLD;
    END IF;
  -- Every column but the revocation's two is unchanged — a column a later
  -- migration adds included, without listing it here.
  ELSIF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
        AND (to_jsonb(NEW) - 'revoked_at' - 'revoked_by')
            = (to_jsonb(OLD) - 'revoked_at' - 'revoked_by') THEN
    NEW.revoked_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'club_member_ranks: an award never changes (revoke it, once)'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'club_member_ranks_fixed';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_member_ranks_fixed" BEFORE UPDATE OR DELETE ON "club_member_ranks" FOR EACH ROW EXECUTE FUNCTION club_member_ranks_fixed();--> statement-breakpoint
CREATE TRIGGER "club_member_ranks_no_truncate" BEFORE TRUNCATE ON "club_member_ranks" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
-- ─── Progress (derived) ──────────────────────────────────────────────────
-- Each live client's current rank on each live ladder, what comes next, and
-- whether they meet what it asks. A check-in counts from the day of the
-- current award (that day included), at a class of the ladder's sport when it
-- has one, anywhere at the club when it has none.
CREATE VIEW "club_member_rank_progress" WITH (security_invoker = true) AS
SELECT cur.club_id, cur.member_id, cur.ladder_id, cur.id AS award_id, cur.rank_id,
       cur.awarded_on, nx.id AS next_rank_id, nx.min_attendances, nx.min_months,
       att.attended,
       CASE WHEN nx.min_months IS NULL THEN NULL
            ELSE (cur.awarded_on + make_interval(months => nx.min_months))::date END
         AS months_met_on,
       (nx.id IS NOT NULL
        AND (nx.min_attendances IS NOT NULL OR nx.min_months IS NOT NULL)
        AND att.attended >= coalesce(nx.min_attendances, 0)
        AND (nx.min_months IS NULL
             OR (cur.awarded_on + make_interval(months => nx.min_months))::date
                <= (now() AT TIME ZONE 'Europe/Sofia')::date)) AS ready
  FROM (SELECT DISTINCT ON (a.club_id, a.member_id, a.ladder_id)
               a.club_id, a.member_id, a.ladder_id, a.id, a.rank_id, a.awarded_on
          FROM club_member_ranks a
         WHERE a.revoked_at IS NULL
         ORDER BY a.club_id, a.member_id, a.ladder_id, a.awarded_on DESC, a.created_at DESC,
                  a.id DESC) cur
  JOIN club_rank_ladders l ON l.club_id = cur.club_id AND l.id = cur.ladder_id
                          AND l.archived_at IS NULL
  JOIN club_members m ON m.club_id = cur.club_id AND m.id = cur.member_id
                     AND m.archived_at IS NULL
  JOIN club_ranks r ON r.club_id = cur.club_id AND r.id = cur.rank_id
  LEFT JOIN LATERAL (SELECT nr.id, nr.min_attendances, nr.min_months FROM club_ranks nr
                      WHERE nr.club_id = r.club_id AND nr.ladder_id = r.ladder_id
                        AND nr.position > r.position
                      ORDER BY nr.position LIMIT 1) nx ON true
  CROSS JOIN LATERAL (SELECT count(*)::int AS attended FROM club_checkins ci
                       WHERE ci.club_id = cur.club_id AND ci.member_id = cur.member_id
                         AND ci.sofia_day >= cur.awarded_on
                         AND (l.sport IS NULL OR EXISTS (
                               SELECT 1 FROM club_class_occurrences o
                                 JOIN club_classes k ON k.club_id = o.club_id AND k.id = o.class_id
                                WHERE o.club_id = ci.club_id AND o.id = ci.occurrence_id
                                  AND k.sport = l.sport))) att;--> statement-breakpoint
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
	    'tournament_drawn', 'match_recorded', 'name_visibility_changed',
	    'document_saved', 'document_versioned', 'document_archived', 'document_restored',
	    'document_signed',
	    'ladder_saved', 'ladder_archived', 'ladder_restored',
	    'rank_saved', 'rank_moved', 'rank_removed', 'rank_awarded', 'rank_revoked')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_audit" VALIDATE CONSTRAINT "club_audit_action_known";--> statement-breakpoint
COMMENT ON TABLE "club_rank_ladders" IS 'A club''s grading ladder (0056): its name and the sport whose classes count toward it (NULL: every check-in). Archived, it leaves the award forms and the exam list; its ranks and awards stay.';--> statement-breakpoint
COMMENT ON TABLE "club_ranks" IS 'One rank of a ladder (0056): place (numbered by club_ranks_stamp, 40 at most), name, colour and accent from the closed belt palette, stripes, and what it asks — check-ins and/or months at the rank before. Removable only while no award names it (a revoked one too); never moves to another ladder.';--> statement-breakpoint
COMMENT ON CONSTRAINT "club_ranks_position_unique" ON "club_ranks" IS 'DEFERRABLE INITIALLY IMMEDIATE so one UPDATE can swap two places (0056). It cannot be an ON CONFLICT arbiter: an ON CONFLICT with no target, or naming this key, fails — name (id) instead.';--> statement-breakpoint
COMMENT ON TABLE "club_member_ranks" IS 'A rank awarded to a client (0056): the day (Sofia, never in the future), exam | promotion | prior, the recording member of staff by value. Append-only; a mistake is revoked once and stops counting. Goes with the client''s record or the club.';--> statement-breakpoint
COMMENT ON VIEW "club_member_rank_progress" IS 'Derived (0056): each live client''s current rank per live ladder (newest award not revoked), the next rank, check-ins since that day in the ladder''s sport, the day the months ask is met, and ready. The «Готови за изпит» list reads it.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
