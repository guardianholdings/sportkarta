-- 0055_club_documents: «Клубове» v2, wave G1 (plan 2026-10-25) — waivers and
-- the club's documents (1club's waivers): a declaration of health, the house
-- rules, a parent's consent, each in versions, signed by the client (or a
-- parent for a child) from the portal or at the desk, and a «Липсва
-- декларация» warning wherever the front of house meets the client.
-- Hand-written; do not regenerate.
--
-- WHAT THIS ADDS
--
--   club_documents         a document of the club: its kind (waiver | rules |
--                          consent | other), its CURRENT title (copied from
--                          its latest version by the version's AFTER INSERT
--                          trigger), and who
--                          must sign it (nobody | every client | minors |
--                          clients with a trial abonnement). Archived, it asks
--                          nobody any more; its signatures stay.
--   club_document_versions the TEXT of a document — its title and its body in
--                          both languages — append-only: version 1, 2, …
--                          numbered by the database under the document's row
--                          lock, never edited, never deleted (a purge of the
--                          club excepted). A renamed document is a new version,
--                          so a signature's printout keeps the title it was
--                          signed under. A new version says whether it needs a
--                          new signature (a typo fix need not; a changed
--                          clause does). Its body_sha256 is computed by the
--                          database, never sent — the hash of the four texts'
--                          own hashes, a missing English text hashed as '' (an
--                          empty text is never stored, so '' means "none"):
--                            sha256( H(title_bg) || H(coalesce(title_en, ''))
--                                 || H(body_bg)  || H(coalesce(body_en, '')) )
--                          with H = sha256 of the UTF-8 bytes, the four RAW
--                          32-byte digests concatenated (not their hex), the
--                          result stored as lowercase hex — so no two
--                          different texts share it (republishing the same
--                          text, to ask for a new signature, gives the same
--                          one), and anyone can recompute what a signer saw. A
--                          body holds no carriage return and a title no
--                          control character (CHECKs): the form sends \n, and
--                          every writer must store what it does.
--   club_document_signatures
--                          one signature: the client, the version, who signed
--                          (the client, or a guardian for a minor), the name
--                          they TYPED, how (the portal, or the desk — then the
--                          member of staff who witnessed it, by value, 0039
--                          rule 5) and when (the database's clock). The
--                          version's hash is copied in by trigger. Only the
--                          LATEST version of a live document can be signed,
--                          once per client (a second submit is the same
--                          signature). A MINOR signs their own record like
--                          anyone else (operator decision 2026-10-30, in line
--                          with 0020: minors are treated as adults); a
--                          guardian MAY sign for a minor (e.g. a child without
--                          an account) and never for an adult (refused). A
--                          signature is never edited; it goes with the
--                          client's record when the club erases it (CASCADE —
--                          the inbox's rule, 0052; the erase screen says so),
--                          and with the club. Erasing a GUARDIAN's record
--                          keeps the name they typed on their child's
--                          signatures: it is the child's record's evidence.
--   club_documents_missing a derived view (0039 rule 3, security_invoker):
--                          every client a live document asks for who has not
--                          signed a version at or after the document's latest
--                          version that needs a new signature. "Every client"
--                          is every live record — an open prospect included
--                          (they may walk in), a LOST one not (0052's
--                          lead_lost_at). "Trial" means a trial ABONNEMENT
--                          (not one cancelled as a mistake — 0052's rule); a
--                          trial class booking alone asks for nothing. The
--                          warning reads it; nothing stores "missing".
--
-- A missing signature WARNS and never refuses: the desk still checks the client
-- in, the class still takes the booking (the attendance rule of 0042).
--
--   Vocabulary: audit actions document_saved, document_versioned,
--   document_archived, document_restored, document_signed.
--
-- TENANCY: each new table carries club_id with its own club_id → clubs
-- CASCADE, so the purge empties all three in its first round (0049's header);
-- the keys between them are composite (club_id, …) and NO ACTION — a version
-- names its own club's document, a signature that document's version and the
-- club's own client (CASCADE: the record's erasure takes it). No column
-- references users: published_by and witnessed_by are staff ids BY VALUE.
--
-- Locking: club_staff first (ACCESS EXCLUSIVE), the order 0045–0054 keep for
-- account erasure — and every staff-scoped statement reads club_staff, which
-- serialises a client's erasure (it writes club_audit before it deletes the
-- record) with this file; then SHARE ROW EXCLUSIVE on club_members (a new key)
-- — before club_audit, the order of the portal, claim and edit paths that
-- write a client before its audit row (0054); then club_audit (a CHECK swap —
-- VALIDATE scans it); then SHARE ROW EXCLUSIVE on clubs (the new keys). A
-- client edit, or a write to clubs followed by an audit row, in flight at that
-- instant may deadlock with this file; Postgres aborts one side after ~1 s and
-- the deploy is re-run. Deploy at a quiet hour, never during a club purge.
--
-- rollback (after reverting the application), in ONE explicit transaction, at
-- a quiet hour. The signatures are the clubs' evidence if a waiver is ever
-- disputed: RETIRE the three tables (renamed, with their indexes, their
-- triggers dropped with the functions) and drop them in a later migration
-- once the clubs have exported them — a backup restore would roll back
-- everything else. The member key STAYS, so a client's erasure still takes
-- their signatures from the retired table. A rename is catalogue-only: it
-- locks the three tables alone.
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   DROP VIEW "club_documents_missing";
--   ALTER TABLE "club_document_signatures" RENAME TO "club_document_signatures_0055_retired";
--   ALTER TABLE "club_document_versions" RENAME TO "club_document_versions_0055_retired";
--   ALTER TABLE "club_documents" RENAME TO "club_documents_0055_retired";
--   -- Indexes keep their names on a rename; free them for a re-creation:
--   ALTER INDEX "club_documents_pkey" RENAME TO "club_documents_0055_retired_pkey";
--   ALTER INDEX "club_documents_club_id_unique" RENAME TO "club_documents_0055_retired_club_id_unique";
--   ALTER INDEX "club_document_versions_pkey" RENAME TO "club_document_versions_0055_retired_pkey";
--   ALTER INDEX "club_document_versions_club_id_unique" RENAME TO "club_document_versions_0055_retired_club_id_unique";
--   ALTER INDEX "club_document_versions_document_unique" RENAME TO "club_document_versions_0055_retired_document_unique";
--   ALTER INDEX "club_document_versions_number_unique" RENAME TO "club_document_versions_0055_retired_number_unique";
--   ALTER INDEX "club_document_signatures_pkey" RENAME TO "club_document_signatures_0055_retired_pkey";
--   ALTER INDEX "club_document_signatures_club_id_unique" RENAME TO "club_document_signatures_0055_retired_club_id_unique";
--   ALTER INDEX "club_document_signatures_once" RENAME TO "club_document_signatures_0055_retired_once";
--   ALTER INDEX "club_document_signatures_member_idx" RENAME TO "club_document_signatures_0055_retired_member_idx";
--   ALTER INDEX "club_document_signatures_document_idx" RENAME TO "club_document_signatures_0055_retired_document_idx";
--   DROP FUNCTION club_document_versions_stamp() CASCADE; DROP FUNCTION club_document_versions_retitle() CASCADE;
--   DROP FUNCTION club_document_versions_fixed() CASCADE;
--   DROP FUNCTION club_document_signatures_stamp() CASCADE; DROP FUNCTION club_document_signatures_fixed() CASCADE;
--   The widened club_audit_action_known STAYS (a superset is harmless; the
--   audit log is append-only). The 0055 row stays in
--   drizzle.__drizzle_migrations: a corrective migration needs a journal
--   `when` above 1785195600000, or the migrator skips it.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_members" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_audit" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "clubs" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- ─── Documents ───────────────────────────────────────────────────────────
CREATE TABLE "club_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title_bg" text NOT NULL,
	"title_en" text,
	"required_for" text DEFAULT 'none' NOT NULL,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_documents_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_documents_kind_known" CHECK ("club_documents"."kind" IN ('waiver', 'rules', 'consent', 'other')),
	CONSTRAINT "club_documents_required_known" CHECK ("club_documents"."required_for" IN ('none', 'all', 'minors', 'trial')),
	CONSTRAINT "club_documents_title_sane" CHECK (btrim("club_documents"."title_bg") <> '' AND char_length("club_documents"."title_bg") <= 120
	      AND "club_documents"."title_bg" !~ '[[:cntrl:]]'
	      AND ("club_documents"."title_en" IS NULL OR (btrim("club_documents"."title_en") <> '' AND char_length("club_documents"."title_en") <= 120
	           AND "club_documents"."title_en" !~ '[[:cntrl:]]'))),
	CONSTRAINT "club_documents_archived_finite" CHECK ("club_documents"."archived_at" IS NULL OR isfinite("club_documents"."archived_at"))
);
--> statement-breakpoint
ALTER TABLE "club_documents" ADD CONSTRAINT "club_documents_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER "club_documents_set_updated_at" BEFORE UPDATE ON "club_documents" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
-- ─── Versions ────────────────────────────────────────────────────────────
CREATE TABLE "club_document_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title_bg" text NOT NULL,
	"title_en" text,
	"body_bg" text NOT NULL,
	"body_en" text,
	"requires_resign" boolean DEFAULT true NOT NULL,
	"body_sha256" text NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_document_versions_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_document_versions_document_unique" UNIQUE("club_id", "document_id", "id"),
	CONSTRAINT "club_document_versions_number_unique" UNIQUE("club_id", "document_id", "version"),
	CONSTRAINT "club_document_versions_number_sane" CHECK ("club_document_versions"."version" BETWEEN 1 AND 1000),
	-- The first version is what everybody signs.
	CONSTRAINT "club_document_versions_first_signed" CHECK ("club_document_versions"."version" > 1 OR "club_document_versions"."requires_resign"),
	CONSTRAINT "club_document_versions_title_sane" CHECK (btrim("club_document_versions"."title_bg") <> '' AND char_length("club_document_versions"."title_bg") <= 120
	      AND "club_document_versions"."title_bg" !~ '[[:cntrl:]]'
	      AND ("club_document_versions"."title_en" IS NULL OR (btrim("club_document_versions"."title_en") <> '' AND char_length("club_document_versions"."title_en") <= 120
	           AND "club_document_versions"."title_en" !~ '[[:cntrl:]]'))),
	CONSTRAINT "club_document_versions_body_sane" CHECK (btrim("club_document_versions"."body_bg") <> '' AND char_length("club_document_versions"."body_bg") <= 20000
	      AND ("club_document_versions"."body_en" IS NULL OR (btrim("club_document_versions"."body_en") <> '' AND char_length("club_document_versions"."body_en") <= 20000))),
	-- The canonical form the hash covers: line feeds only.
	CONSTRAINT "club_document_versions_body_lf" CHECK (strpos("club_document_versions"."body_bg", E'\r') = 0
	      AND ("club_document_versions"."body_en" IS NULL OR strpos("club_document_versions"."body_en", E'\r') = 0)),
	CONSTRAINT "club_document_versions_hash_format" CHECK ("club_document_versions"."body_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "club_document_versions_published_finite" CHECK (isfinite("club_document_versions"."published_at"))
);
--> statement-breakpoint
ALTER TABLE "club_document_versions" ADD CONSTRAINT "club_document_versions_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_document_versions" ADD CONSTRAINT "club_document_versions_document_fk" FOREIGN KEY ("club_id","document_id") REFERENCES "public"."club_documents"("club_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The number, the hash and the time are the database's: the next number under
-- the document's row lock (a signature takes that lock too, so it never signs
-- a version that is no longer the latest), the hash of exactly what is stored,
-- the clock read after the lock (so times follow the lock order). A text is
-- never added to an archived document. Both stamps must stay VOLATILE (the
-- default): a STABLE one would read max() from before the lock wait.
CREATE FUNCTION club_document_versions_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM 1 FROM public.club_documents d
    WHERE d.club_id = NEW.club_id AND d.id = NEW.document_id AND d.archived_at IS NULL
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'club_document_versions: a text is added to a live document only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_document_versions_live';
  END IF;
  SELECT coalesce(max(v.version), 0) + 1 INTO NEW.version
    FROM public.club_document_versions v
   WHERE v.club_id = NEW.club_id AND v.document_id = NEW.document_id;
  IF NEW.version = 1 THEN
    NEW.requires_resign := true;
  END IF;
  NEW.body_sha256 := encode(sha256(
       sha256(convert_to(NEW.title_bg, 'UTF8'))
    || sha256(convert_to(coalesce(NEW.title_en, ''), 'UTF8'))
    || sha256(convert_to(NEW.body_bg, 'UTF8'))
    || sha256(convert_to(coalesce(NEW.body_en, ''), 'UTF8'))), 'hex');
  NEW.published_at := clock_timestamp();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_document_versions_stamp" BEFORE INSERT ON "club_document_versions" FOR EACH ROW EXECUTE FUNCTION club_document_versions_stamp();--> statement-breakpoint
-- The document's current title is its latest version's — copied once the
-- version row stands (its own CHECKs passed), on the row the stamp locked. The
-- titles stay out of every unique key, so this is a non-key update.
CREATE FUNCTION club_document_versions_retitle() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.club_documents d SET title_bg = NEW.title_bg, title_en = NEW.title_en
   WHERE d.club_id = NEW.club_id AND d.id = NEW.document_id;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_document_versions_retitle" AFTER INSERT ON "club_document_versions" FOR EACH ROW EXECUTE FUNCTION club_document_versions_retitle();--> statement-breakpoint
CREATE FUNCTION club_document_versions_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.club_id::text = current_setting('pops.purging_club', true) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'club_document_versions: a published text never changes (publish a new version)'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'club_document_versions_fixed';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_document_versions_fixed" BEFORE UPDATE OR DELETE ON "club_document_versions" FOR EACH ROW EXECUTE FUNCTION club_document_versions_fixed();--> statement-breakpoint
CREATE TRIGGER "club_document_versions_no_truncate" BEFORE TRUNCATE ON "club_document_versions" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
-- ─── Signatures ──────────────────────────────────────────────────────────
CREATE TABLE "club_document_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"signer_kind" text NOT NULL,
	"signer_name" text NOT NULL,
	"method" text NOT NULL,
	"witnessed_by" text,
	"body_sha256" text NOT NULL,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_document_signatures_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_document_signatures_signer_known" CHECK ("club_document_signatures"."signer_kind" IN ('self', 'guardian')),
	CONSTRAINT "club_document_signatures_method_known" CHECK ("club_document_signatures"."method" IN ('portal', 'desk')),
	CONSTRAINT "club_document_signatures_name_sane" CHECK (btrim("club_document_signatures"."signer_name") <> '' AND char_length("club_document_signatures"."signer_name") <= 120),
	-- At the desk a member of staff witnessed it; from the portal nobody did.
	CONSTRAINT "club_document_signatures_witness_pair" CHECK (("club_document_signatures"."method" = 'desk') = ("club_document_signatures"."witnessed_by" IS NOT NULL)),
	CONSTRAINT "club_document_signatures_hash_format" CHECK ("club_document_signatures"."body_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "club_document_signatures_signed_finite" CHECK (isfinite("club_document_signatures"."signed_at"))
);
--> statement-breakpoint
ALTER TABLE "club_document_signatures" ADD CONSTRAINT "club_document_signatures_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The version of THIS document.
ALTER TABLE "club_document_signatures" ADD CONSTRAINT "club_document_signatures_version_fk" FOREIGN KEY ("club_id","document_id","version_id") REFERENCES "public"."club_document_versions"("club_id","document_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The club's own client; the club's erasure of the record takes the signature.
ALTER TABLE "club_document_signatures" ADD CONSTRAINT "club_document_signatures_member_fk" FOREIGN KEY ("club_id","member_id") REFERENCES "public"."club_members"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_document_signatures_member_idx" ON "club_document_signatures" USING btree ("club_id","member_id","document_id");--> statement-breakpoint
CREATE INDEX "club_document_signatures_document_idx" ON "club_document_signatures" USING btree ("club_id","document_id","signed_at");--> statement-breakpoint
-- One signature of a version per client: a second submit is the same act.
-- Its prefix serves the version key.
CREATE UNIQUE INDEX "club_document_signatures_once" ON "club_document_signatures" USING btree ("club_id","document_id","version_id","member_id");--> statement-breakpoint
-- What a signature says, the database decides: the document is live, the
-- version is its latest (under the document's row lock — the version stamp's
-- lock, so the two serialise), the hash is that version's, a guardian signs
-- only a minor's record (the client signs their own, whatever their age), and
-- the time is read after the lock.
CREATE FUNCTION club_document_signatures_stamp() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  latest integer;
  this public.club_document_versions%ROWTYPE;
BEGIN
  PERFORM 1 FROM public.club_documents d
    WHERE d.club_id = NEW.club_id AND d.id = NEW.document_id AND d.archived_at IS NULL
    FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'club_document_signatures: only a live document is signed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_document_signatures_current';
  END IF;
  SELECT * INTO this FROM public.club_document_versions v
   WHERE v.club_id = NEW.club_id AND v.document_id = NEW.document_id AND v.id = NEW.version_id;
  SELECT max(v.version) INTO latest FROM public.club_document_versions v
   WHERE v.club_id = NEW.club_id AND v.document_id = NEW.document_id;
  IF this.id IS NULL OR this.version IS DISTINCT FROM latest THEN
    RAISE EXCEPTION 'club_document_signatures: only the latest version is signed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_document_signatures_current';
  END IF;
  IF NEW.signer_kind = 'guardian' AND NOT EXISTS (
    SELECT 1 FROM public.club_members m
     WHERE m.club_id = NEW.club_id AND m.id = NEW.member_id AND m.is_minor
  ) THEN
    RAISE EXCEPTION 'club_document_signatures: a guardian signs only a minor''s record'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_document_signatures_guardian_minor';
  END IF;
  NEW.body_sha256 := this.body_sha256;
  NEW.signed_at := clock_timestamp();
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_document_signatures_stamp" BEFORE INSERT ON "club_document_signatures" FOR EACH ROW EXECUTE FUNCTION club_document_signatures_stamp();--> statement-breakpoint
-- Never edited. Deleted only with its client's record (the record's key
-- cascades here once the record is gone) or with the club.
CREATE FUNCTION club_document_signatures_fixed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND (
       OLD.club_id::text = current_setting('pops.purging_club', true)
       OR NOT EXISTS (SELECT 1 FROM public.club_members m
                       WHERE m.club_id = OLD.club_id AND m.id = OLD.member_id)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'club_document_signatures: a signature never changes'
    USING ERRCODE = 'check_violation', CONSTRAINT = 'club_document_signatures_fixed';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_document_signatures_fixed" BEFORE UPDATE OR DELETE ON "club_document_signatures" FOR EACH ROW EXECUTE FUNCTION club_document_signatures_fixed();--> statement-breakpoint
CREATE TRIGGER "club_document_signatures_no_truncate" BEFORE TRUNCATE ON "club_document_signatures" FOR EACH STATEMENT EXECUTE FUNCTION club_ledger_no_truncate();--> statement-breakpoint
-- ─── Who is missing what (derived) ───────────────────────────────────────
-- A live document asks: every client (all), minors, or clients who ever held a
-- trial abonnement — archived records never. A signature counts when its
-- version is at or after the document's latest version that needs a new
-- signature (version 1 always does). Whoever signed counts — a minor's own
-- signature answers a minors' document as a guardian's does (2026-10-30).
CREATE VIEW "club_documents_missing" WITH (security_invoker = true) AS
SELECT d.club_id, m.id AS member_id, d.id AS document_id
  FROM club_documents d
  -- The version a signature must reach, once per document; a document with
  -- no text yet asks nobody (nobody could sign it).
  CROSS JOIN LATERAL (SELECT max(r.version) AS needs FROM club_document_versions r
                       WHERE r.club_id = d.club_id AND r.document_id = d.id
                         AND r.requires_resign) t
  JOIN club_members m ON m.club_id = d.club_id AND m.archived_at IS NULL
                     AND m.lead_lost_at IS NULL
 WHERE d.archived_at IS NULL AND t.needs IS NOT NULL
   AND (d.required_for = 'all'
        OR (d.required_for = 'minors' AND m.is_minor)
        OR (d.required_for = 'trial' AND EXISTS (
              SELECT 1 FROM club_memberships mb
               WHERE mb.club_id = m.club_id AND mb.member_id = m.id AND mb.kind = 'trial'
                 AND mb.cancel_reason IS DISTINCT FROM 'mistake')))
   AND NOT EXISTS (
     SELECT 1 FROM club_document_signatures s
       JOIN club_document_versions v ON v.club_id = s.club_id AND v.id = s.version_id
      WHERE s.club_id = d.club_id AND s.document_id = d.id AND s.member_id = m.id
        AND v.version >= t.needs);--> statement-breakpoint
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
	    'document_signed')) NOT VALID;--> statement-breakpoint
ALTER TABLE "club_audit" VALIDATE CONSTRAINT "club_audit_action_known";--> statement-breakpoint
COMMENT ON TABLE "club_documents" IS 'A club document — waiver, rules, consent, other (0055): who must sign it (nobody, every client, minors, trial abonnements) and its current title, copied from its latest version by club_document_versions_retitle. Its text lives in club_document_versions.';--> statement-breakpoint
COMMENT ON TABLE "club_document_versions" IS 'One version of a club document''s title and text (0055), append-only. The number, the time and body_sha256 are stamped by the database: lowercase hex of sha256 over the four RAW 32-byte digests H(title_bg) || H(title_en or '''') || H(body_bg) || H(body_en or ''''), H = sha256 of the UTF-8 bytes.';--> statement-breakpoint
COMMENT ON VIEW "club_documents_missing" IS 'Derived (0055): every client a live document asks for who has not signed a version at or after its latest version that needs a new signature. The «Липсва декларация» warning reads it.';--> statement-breakpoint
COMMENT ON TABLE "club_document_signatures" IS 'A client''s signature of one version of a club document (0055): who signed (the client — a minor too — or a guardian for a minor), the typed name, portal or desk (staff witness by value), the version''s sha256, the time. Never edited; goes with the client''s record or the club.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
