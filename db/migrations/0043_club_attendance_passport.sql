-- 0043_club_attendance_passport: attendance at a club, the derived state of a
-- membership and of a member, and the one bridge from a club into a member's
-- own POPS training log.
--
-- club_checkins. One row per person per class (or per open-gym day per
-- location). How it was recorded is `method`:
--   qr_kiosk   the member's phone scanned the rotating QR on the club's paired
--              tablet (/klubove/otmetka/<token>); identity is the session cookie
--   qr_member  the desk scanned the member's per-club QR on their phone
--   card       the desk scanned a printed member card (club_members.card_token_hash)
--   desk       a person at the desk, or the trainer on the roster, ticked «Присъства»
--   api        reserved for the phase-2 API; nothing writes it in v1
-- There is NO distance and NO coordinate column, deliberately: both QR flows
-- happen at the desk, where the tablet's screen IS the proximity proof, and the
-- check-in path of 0014 already showed a coordinate is the wrong thing to keep.
--
-- `covered` IS THE PAYMENT CHECK'S OUTCOME, NEVER A REFUSAL. The row is always
-- written — an expired or unpaid member is recorded as present and the desk is
-- told so in words — exactly the 0014 principle that "attendance is always
-- recorded and only the payment stops". consumed_membership_id names the
-- abonnement the visit counted against; a visit card's remaining visits are
-- derived by COUNTING these rows (club_membership_balances), so no counter can
-- race between two desks.
--
-- THE PASSPORT BRIDGE. When the member has LINKED their POPS account
-- (club_member_links.status = 'active') AND consented
-- (club_member_links.passport_consent_at), a qr_kiosk / qr_member / card
-- check-in also writes a training_logs row for them, in the same transaction
-- (apps/web/lib/clubs/checkin.ts):
--     source = 'club', evidence = 'qr_verified', external_id = the check-in id
-- and club_checkins.training_log_id points at it. 0027 drafted 'qr_verified'
-- and removed it "because nothing could grant it", noting it would come back
-- "when something can actually grant it, together with the source that does".
-- This is that: a scan at a club desk by a linked, consenting member — never a
-- self-reported row, never a desk tick ('desk' writes no training log, since
-- nobody but the staff member vouched for it). NO POINTS: nothing here touches
-- points_ledger (earn-only, contribution-scoped, and only for free public
-- facilities). Withdrawing consent stops future rows; existing rows are the
-- member's own diary and stay with them. The unique index
-- training_logs_user_source_external_unique (0027) makes the write idempotent.
--
-- training_logs_evidence_matches_source is REWRITTEN to admit exactly the new
-- pair, comparing AS TEXT because 'club' and 'qr_verified' were added by 0038 in
-- this same transaction. training_logs_external_id_matches_source needs no
-- change: it already demands an external_id for every non-manual source, which
-- the check-in id satisfies.
--
-- VIEWS (security_invoker, the single definitions):
--   club_membership_balances  visits used/remaining, paused days, effective end
--                             date and state (cancelled / upcoming / expired /
--                             paused / exhausted / active) against the civil
--                             Sofia date.
--   club_member_status        archived / active / trial / lapsed / lead.
--
-- Locking: club_checkins is new. The training_logs constraint swap takes ACCESS
-- EXCLUSIVE on training_logs and scans it once to validate; drizzle holds that
-- lock to the end of the batch, so /trenirovki waits for the deploy's migrate
-- step (normally well under a second). The FK to training_logs takes SHARE ROW
-- EXCLUSIVE on it until COMMIT.
--
-- TWO DATABASE GUARANTEES BACK THE BRIDGE, so it does not rest on application
-- code: club_checkins_only_scans_reach_the_passport (a desk/api row cannot
-- carry a training log) and the training_logs_club_row_is_a_checkin trigger (a
-- source='club' row must name a QR/card check-in of a consenting, linked
-- client of that very account).
--
-- rollback (ONE explicit transaction, after 0044 and the application):
--   DROP TRIGGER "training_logs_club_row_is_a_checkin" ON "training_logs";
--   DROP FUNCTION training_logs_club_row_is_a_checkin();
--   DROP VIEW "club_member_status"; DROP VIEW "club_membership_balances";
--   DROP TABLE "club_checkins";            -- DESTRUCTIVE: attendance history
--   DELETE FROM "training_logs" WHERE "source"::text = 'club';
--       -- DESTRUCTIVE, and required before the CHECK can be restored. These rows
--       -- are members' own diary entries; prefer leaving 0043 in place.
--   ALTER TABLE "training_logs" DROP CONSTRAINT "training_logs_evidence_matches_source",
--     ADD CONSTRAINT "training_logs_evidence_matches_source" CHECK (("source" = 'manual' AND "evidence" = 'self_reported') OR ("source" <> 'manual' AND "evidence" = 'connected_app'));
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE TABLE "club_checkins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"occurrence_id" uuid,
	"location_id" uuid NOT NULL,
	"method" text NOT NULL,
	"recorded_by" text,
	"consumed_membership_id" uuid,
	"charge_id" uuid,
	"covered" boolean NOT NULL,
	"training_log_id" uuid,
	"sofia_day" date NOT NULL,
	"checked_in_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_checkins_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_checkins_method_known" CHECK ("club_checkins"."method" IN ('qr_kiosk', 'qr_member', 'card', 'desk', 'api')),
	CONSTRAINT "club_checkins_recorder_matches_method" CHECK (("club_checkins"."method" IN ('qr_kiosk', 'api')) = ("club_checkins"."recorded_by" IS NULL)),
	CONSTRAINT "club_checkins_recorder_not_blank" CHECK ("club_checkins"."recorded_by" IS NULL OR btrim("club_checkins"."recorded_by") <> ''),
	CONSTRAINT "club_checkins_day_sane" CHECK (isfinite("club_checkins"."sofia_day") AND "club_checkins"."sofia_day" BETWEEN DATE '2020-01-01' AND DATE '2100-01-01'),
	-- Only a scan at the club may carry a training log (the 0014
	-- only_qr_scores pattern): a desk tick never mints qr_verified. A NULL
	-- passes, so the training_logs SET NULL cascade can never violate it.
	CONSTRAINT "club_checkins_only_scans_reach_the_passport" CHECK ("club_checkins"."training_log_id" IS NULL OR "club_checkins"."method" IN ('qr_kiosk', 'qr_member', 'card')),
	CONSTRAINT "club_checkins_checked_in_finite" CHECK (isfinite("club_checkins"."checked_in_at"))
);
--> statement-breakpoint
-- Once per class, once per open-gym day per location. INSERT ... ON CONFLICT DO
-- NOTHING against these is what makes a double scan harmless.
CREATE UNIQUE INDEX "club_checkins_member_occurrence_unique" ON "club_checkins" USING btree ("member_id","occurrence_id") WHERE "club_checkins"."occurrence_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "club_checkins_member_open_day_unique" ON "club_checkins" USING btree ("member_id","location_id","sofia_day") WHERE "club_checkins"."occurrence_id" IS NULL;--> statement-breakpoint
CREATE INDEX "club_checkins_club_day_idx" ON "club_checkins" USING btree ("club_id","sofia_day");--> statement-breakpoint
CREATE INDEX "club_checkins_occurrence_idx" ON "club_checkins" USING btree ("club_id","occurrence_id") WHERE "club_checkins"."occurrence_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_checkins_member_idx" ON "club_checkins" USING btree ("club_id","member_id","checked_in_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "club_checkins_location_idx" ON "club_checkins" USING btree ("club_id","location_id");--> statement-breakpoint
-- club_membership_balances counts visits through this.
CREATE INDEX "club_checkins_membership_idx" ON "club_checkins" USING btree ("consumed_membership_id") WHERE "club_checkins"."consumed_membership_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_checkins_charge_idx" ON "club_checkins" USING btree ("club_id","charge_id") WHERE "club_checkins"."charge_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "club_checkins_training_log_idx" ON "club_checkins" USING btree ("training_log_id") WHERE "club_checkins"."training_log_id" IS NOT NULL;--> statement-breakpoint
CREATE VIEW "club_membership_balances" WITH (security_invoker = true) AS
SELECT
  m.id AS membership_id,
  m.club_id,
  m.member_id,
  m.plan_id,
  m.plan_name,
  m.kind,
  m.audience,
  m.price_cents,
  m.starts_on,
  m.ends_on,
  m.visits_total,
  m.cancelled_at,
  m.cancel_reason,
  m.created_at,
  (m.visits_used_offset + coalesce(u.used, 0))::integer AS visits_used,
  CASE WHEN m.visits_total IS NULL THEN NULL
       ELSE greatest(m.visits_total - m.visits_used_offset - coalesce(u.used, 0), 0)::integer
  END AS visits_remaining,
  coalesce(p.paused_days, 0)::integer AS paused_days,
  (m.ends_on + coalesce(p.paused_days, 0)::integer) AS effective_ends_on,
  coalesce(p.paused_today, false) AS paused_today,
  CASE
    WHEN m.cancelled_at IS NOT NULL THEN 'cancelled'
    WHEN m.starts_on > d.today THEN 'upcoming'
    WHEN m.ends_on + coalesce(p.paused_days, 0)::integer < d.today THEN 'expired'
    WHEN coalesce(p.paused_today, false) THEN 'paused'
    WHEN m.visits_total IS NOT NULL
         AND m.visits_total - m.visits_used_offset - coalesce(u.used, 0) <= 0 THEN 'exhausted'
    ELSE 'active'
  END AS state
FROM public.club_memberships m
CROSS JOIN LATERAL (SELECT (now() AT TIME ZONE 'Europe/Sofia')::date AS today) d
LEFT JOIN LATERAL (
  SELECT count(*) AS used
    FROM public.club_checkins ch
   WHERE ch.consumed_membership_id = m.id AND ch.club_id = m.club_id
) u ON true
LEFT JOIN LATERAL (
  SELECT sum(ps.ends_on - ps.starts_on + 1) AS paused_days,
         bool_or(d.today BETWEEN ps.starts_on AND ps.ends_on) AS paused_today
    FROM public.club_membership_pauses ps
   WHERE ps.club_id = m.club_id AND ps.membership_id = m.id
) p ON true;--> statement-breakpoint
CREATE VIEW "club_member_status" WITH (security_invoker = true) AS
SELECT
  mem.id AS member_id,
  mem.club_id,
  CASE
    WHEN mem.archived_at IS NOT NULL THEN 'archived'
    WHEN coalesce(s.has_live, false) THEN 'active'
    WHEN coalesce(s.has_trial, false) THEN 'trial'
    WHEN coalesce(s.has_any, false) THEN 'lapsed'
    ELSE 'lead'
  END AS status,
  s.last_ends_on
FROM public.club_members mem
LEFT JOIN LATERAL (
  SELECT
    bool_or(b.kind <> 'trial' AND b.state IN ('active', 'paused', 'upcoming')) AS has_live,
    bool_or(b.kind = 'trial' AND b.state IN ('active', 'upcoming')) AS has_trial,
    bool_or(b.cancel_reason IS DISTINCT FROM 'mistake') AS has_any,
    max(b.effective_ends_on) FILTER (WHERE b.state <> 'cancelled') AS last_ends_on
  FROM public.club_membership_balances b
  -- club_id first: club_memberships_member_idx is (club_id, member_id), so one
  -- club's member list never scans another club's sales.
  WHERE b.club_id = mem.club_id AND b.member_id = mem.id
) s ON true;--> statement-breakpoint
ALTER TABLE "club_checkins" ADD CONSTRAINT "club_checkins_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_checkins" ADD CONSTRAINT "club_checkins_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_checkins" ADD CONSTRAINT "club_checkins_occurrence_fk" FOREIGN KEY ("club_id","occurrence_id") REFERENCES "public"."club_class_occurrences"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_checkins" ADD CONSTRAINT "club_checkins_location_fk" FOREIGN KEY ("club_id","location_id") REFERENCES "public"."club_locations"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The visit counts against an abonnement of THE SAME CLIENT: the key includes
-- member_id, so a desk picking the wrong card in a household is refused
-- (23503) rather than silently using up somebody else's visits.
ALTER TABLE "club_checkins" ADD CONSTRAINT "club_checkins_membership_fk" FOREIGN KEY ("club_id","member_id","consumed_membership_id") REFERENCES "public"."club_memberships"("club_id","member_id","id") ON DELETE set null ("consumed_membership_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_checkins" ADD CONSTRAINT "club_checkins_charge_fk" FOREIGN KEY ("club_id","charge_id") REFERENCES "public"."club_charges"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
COMMENT ON TABLE "club_checkins" IS 'Attendance at a club: always recorded, never refused — covered says whether an abonnement or a drop-in charge paid for it. No distance, no coordinates. A qr_kiosk/qr_member/card row for a linked member who consented also writes their training_logs row (source club, evidence qr_verified) in the same transaction; never points_ledger.';--> statement-breakpoint
COMMENT ON COLUMN "club_checkins"."consumed_membership_id" IS 'The abonnement this visit counted against. A visit card''s remaining visits are the COUNT of rows pointing at it (club_membership_balances) — there is no counter to race on.';--> statement-breakpoint
COMMENT ON VIEW "club_membership_balances" IS 'The single definition of a membership''s visits used/remaining, paused days, effective end date and state (cancelled, upcoming, expired, paused, exhausted, active) against the civil Sofia date.';--> statement-breakpoint
COMMENT ON VIEW "club_member_status" IS 'The single definition of a club client''s status: archived, active (a live non-trial abonnement, paused or upcoming included), trial, lapsed (had one), lead (never had one).';--> statement-breakpoint
ALTER TABLE "training_logs" DROP CONSTRAINT "training_logs_evidence_matches_source",
	ADD CONSTRAINT "training_logs_evidence_matches_source" CHECK (("training_logs"."source"::text = 'manual' AND "training_logs"."evidence"::text = 'self_reported')
	      OR ("training_logs"."source"::text = 'club' AND "training_logs"."evidence"::text = 'qr_verified')
	      OR ("training_logs"."source"::text NOT IN ('manual', 'club') AND "training_logs"."evidence"::text = 'connected_app'));--> statement-breakpoint
COMMENT ON COLUMN "training_logs"."evidence" IS 'How far the row can be trusted, pinned EXACTLY by training_logs_evidence_matches_source: a manual entry is self_reported, an import is connected_app, and a club check-in is qr_verified — and each can be nothing else. 0027 removed qr_verified "because nothing could grant it"; 0043 restored it with the one thing that does: a QR or card check-in at a club desk by a member who linked their POPS account and consented (club_member_links.passport_consent_at). A desk tick never grants it.';--> statement-breakpoint
ALTER TABLE "club_checkins" ADD CONSTRAINT "club_checkins_training_log_id_training_logs_id_fk" FOREIGN KEY ("training_log_id") REFERENCES "public"."training_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- THE TOP EVIDENCE TIER IS NOT A STRING ANYONE CAN WRITE. 0027's lesson was
-- that pinning evidence to a source only moves the forgery to the source
-- column. So a training_logs row with source 'club' must BE a scan at a club:
-- its external_id names a club_checkins row recorded by QR or card, for a
-- client record linked (active) to THIS account, whose holder consented to the
-- passport bridge. Checked on INSERT and whenever those columns change; never
-- on DELETE, so no erasure cascade can be refused by it.
CREATE FUNCTION training_logs_club_row_is_a_checkin() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.source::text <> 'club' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.club_checkins c
      JOIN public.club_member_links l ON l.club_id = c.club_id AND l.member_id = c.member_id
     WHERE c.id::text = NEW.external_id
       AND c.method IN ('qr_kiosk', 'qr_member', 'card')
       AND l.user_id = NEW.user_id
       AND l.status = 'active'
       AND l.passport_consent_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'training_logs_club_row_is_a_checkin: a club training log must be a consented QR or card check-in'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'training_logs_club_row_is_a_checkin';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "training_logs_club_row_is_a_checkin"
BEFORE INSERT OR UPDATE OF "source", "evidence", "external_id", "user_id" ON "training_logs"
FOR EACH ROW EXECUTE FUNCTION training_logs_club_row_is_a_checkin();--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
