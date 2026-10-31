-- 0057_club_integrations: «Клубове» v2, wave H1 (plan 2026-10-25) — the club
-- API (vedro's and 1club's top tier), webhooks, and door access (1club's Salto
-- and WebLock, anolla's turnstiles). The MCP connector rides on the API keys
-- and adds nothing here. Hand-written; do not regenerate.
--
-- WHAT THIS ADDS
--
--   club_api_keys       a club's API key: `skbk_` + 43 base64url characters,
--                       stored ONLY as its SHA-256 (CHECK-pinned to 64 hex, so
--                       the column cannot hold a key — 0015's api_keys rule)
--                       and its first six characters for telling keys apart.
--                       The name may not contain a key (people paste keys into
--                       name boxes). A key ACTS AS THE MEMBER OF STAFF WHO
--                       CREATED IT (created_by, by value), narrowed to its
--                       scopes: every request runs the office's own scoped
--                       statements with that person's CURRENT role, so a key
--                       never does more than its creator may do today, and a
--                       creator who leaves the club takes their keys' power
--                       with them (the verification also refuses a key whose
--                       creator is no longer staff). Scopes are a closed list.
--                       Revoked, never deleted ("revoked on the 4th" is an
--                       answer somebody will need); last_used_at moves at most
--                       once a minute, so it is not an activity log.
--   club_api_idempotency
--                       one row per (key, Idempotency-Key) for a day: the
--                       request's SHA-256, its state, and the outcome as a
--                       status code plus the KIND and ID of what it made (or a
--                       closed error code) — never a response body, so no copy
--                       of a client's name or contact sits here. A retry with
--                       the same key replays the outcome (the record is read
--                       afresh); the same key with a different request is
--                       refused. The worker prunes rows after a day.
--   club_webhook_endpoints
--                       where a club wants to be told: an https URL (the
--                       application checks the host is public, the worker
--                       checks every address it connects to), the events it
--                       wants (closed list), a label. Its signing secret is
--                       DERIVED — HMAC(CLUB_WEBHOOK_SECRET, id, version) — so
--                       nothing stores it; rotating bumps secret_version, and
--                       for a day after a rotation both secrets sign.
--                       Disabled by hand or, after three days of failures,
--                       by the worker ('failing').
--   club_webhook_deliveries
--                       the outbox AND the delivery log: one row per event per
--                       subscribed live endpoint, written by TRIGGERS in the
--                       transaction that made the change — so every path (the
--                       desk, the kiosk, the portal, an import, the Stripe
--                       worker, the API) is covered and a rolled-back change
--                       announces nothing. THIN: the event, the subject's id
--                       and the client record's id (by value: member.deleted
--                       names a record that is gone) — the integrator fetches
--                       the rest through the API — and `seq`, the order the
--                       database saw them in (events of one transaction share
--                       its timestamp). The worker claims due rows by lease
--                       (next_attempt_at, then seq), signs, posts and backs
--                       off; after 8 attempts (about a day and a half) the
--                       row is 'failed'. Pruned after 30 days.
--                       member.deleted is the one event queued for a
--                       DISABLED endpoint too, and held there until it is
--                       enabled again: an erasure the club's integrations
--                       never hear of is the one loss that matters (GDPR art.
--                       17(2), 19). It can still be lost — to 8 failures or
--                       the prune — so the documentation tells integrators to
--                       reconcile against the member list as well.
--
-- DOOR ACCESS. club_kiosk_devices gains `kind` ('kiosk' | 'door') and, for a
-- door, `access_rule`: 'member' (any live client record) or 'covered' (a live
-- abonnement that covers a visit now). A door device is created with its
-- secret (shown once as `skbd_<device>.<secret>`), never paired by code. The
-- door controller posts the scanned card or member QR to
-- /api/clubs/v1/access/check; an allowed entry is a check-in with the new
-- method 'door' (no person recorded it — recorded_by NULL, like qr_kiosk). A
-- door entry is a scan at the club, as strong as a card at the desk, so it may
-- reach a linked, consenting member's training log: the passport CHECK and
-- 0043's training_logs_club_row_is_a_checkin admit 'door' (the function is
-- replaced with the one value added). A denied attempt records nothing. A
-- device's kind never changes (club_kiosk_devices_keep_kind): a door's secret
-- has a kiosk cookie's shape, so the application looks a device up by kind as
-- well as by id, and the kind it was created with is the one it keeps.
--
-- VOCABULARY: club_members.source + 'api' (a record created through the API);
-- club_audit.actor_kind + 'api' (the key's creator, through a key — the key id
-- is in the detail) and 'door' (no person: club_audit_actor_matches_kind
-- admits a NULL actor_id for it, beside 'system' and 'kiosk'); audit actions
-- api_key_created,
-- api_key_revoked, webhook_saved, webhook_disabled, webhook_enabled,
-- webhook_removed, webhook_secret_rotated, door_device_created,
-- door_device_revoked.
--
-- TENANCY: each new table carries club_id → clubs CASCADE, so the purge
-- empties them in its first round; the keys between them are composite
-- (club_id, …) CASCADE. No column references users: created_by and revoked_by
-- are staff ids BY VALUE (0039 rule 5). The member.deleted trigger stays
-- silent while the club itself is being purged (`pops.purging_club`), when its
-- endpoints are going too.
--
-- Locking: club_staff first (ACCESS EXCLUSIVE, 0055's order), then the five
-- tables that gain a trigger or a CHECK swap — club_members, club_memberships,
-- club_payments, club_bookings, club_checkins — then club_kiosk_devices,
-- club_audit and clubs. The CHECK swaps (club_members, club_checkins,
-- club_kiosk_devices, club_audit) need ACCESS EXCLUSIVE; a trigger alone needs
-- SHARE ROW EXCLUSIVE; clubs gets SHARE ROW EXCLUSIVE for the new keys. All are
-- taken up front and held to COMMIT: the desk, the kiosk and the portal wait
-- for the deploy's migrate step. Since ACCESS EXCLUSIVE is held anyway, each
-- table's swaps are ONE ALTER TABLE with validated constraints, so each of
-- club_checkins (the fastest-growing club table), club_members, club_audit and
-- club_kiosk_devices is scanned once. A write in flight at that instant may
-- deadlock with this file; Postgres aborts one side after ~1 s and the deploy
-- is re-run. Deploy at a quiet hour, never during a club purge.
--
-- THE ENQUEUE NEVER FAILS A WRITE. It reads the club's endpoints FOR KEY SHARE:
-- an endpoint being removed at that instant is waited for and then skipped,
-- rather than tripping the deliveries' key and failing the check-in, payment or
-- booking that fired the trigger. (Removing an endpoint waits, in turn, for
-- writes in flight; the worker's own updates of an endpoint never touch its
-- key and do not conflict.)
--
-- RESTORES: a data-only or single-table restore of club_members, club_bookings,
-- club_checkins, club_memberships or club_payments while endpoints exist would
-- post an event for every restored row to the clubs' URLs. Restore with the
-- triggers off (pg_restore --disable-triggers, or session_replication_role =
-- replica), or disable every endpoint first. A full pg_dump restore is safe —
-- it creates the triggers after the data.
--
-- rollback (after reverting the application), in TWO steps, each ONE explicit
-- transaction at a quiet hour.
--
--   Step 1 — stop everything, take no table lock beyond a row's:
--     CREATE OR REPLACE FUNCTION club_webhook_enqueue() RETURNS trigger
--       LANGUAGE plpgsql SET search_path = pg_catalog, public
--       AS $$ BEGIN RETURN NULL; END; $$;
--     UPDATE "club_webhook_endpoints" SET "disabled_at" = now(), "disabled_reason" = 'manual'
--      WHERE "disabled_at" IS NULL;
--     UPDATE "club_api_keys" SET "revoked_at" = now() WHERE "revoked_at" IS NULL;
--     -- A door's secret is a valid kiosk cookie to a reverted application,
--     -- which looks devices up without their kind: revoke every door.
--     UPDATE "club_kiosk_devices" SET "revoked_at" = now()
--      WHERE "kind" = 'door' AND "revoked_at" IS NULL;
--
--   Step 2 — a later migration drops what step 1 silenced, taking the locks
--   in this file's order (DROP TRIGGER needs ACCESS EXCLUSIVE on each table,
--   and dropping the four tables takes ACCESS EXCLUSIVE on clubs, whose key
--   triggers go with them):
--     SET LOCAL lock_timeout = '3s';
--     SET LOCAL statement_timeout = '30s';
--     LOCK TABLE "club_members", "club_memberships", "club_payments", "club_bookings",
--                "club_checkins", "clubs" IN ACCESS EXCLUSIVE MODE;
--     DROP TRIGGER "club_members_webhook_created" ON "club_members";
--     DROP TRIGGER "club_members_webhook_updated" ON "club_members";
--     DROP TRIGGER "club_members_webhook_deleted" ON "club_members";
--     DROP TRIGGER "club_memberships_webhook_created" ON "club_memberships";
--     DROP TRIGGER "club_payments_webhook_created" ON "club_payments";
--     DROP TRIGGER "club_bookings_webhook_created" ON "club_bookings";
--     DROP TRIGGER "club_bookings_webhook_reactivated" ON "club_bookings";
--     DROP TRIGGER "club_bookings_webhook_cancelled" ON "club_bookings";
--     DROP TRIGGER "club_checkins_webhook_created" ON "club_checkins";
--     DROP FUNCTION club_webhook_enqueue();
--     DROP TABLE "club_webhook_deliveries", "club_webhook_endpoints",
--                "club_api_idempotency", "club_api_keys";
--
--   The keys, endpoints and the delivery log are configuration and a 30-day
--   log, not the clubs' records — dropping them is the rollback. What STAYS:
--   the widened CHECKs (a superset is harmless; the audit log is append-only),
--   training_logs_club_row_is_a_checkin with 'door' admitted, the door
--   columns, the keep-kind guard, and any 'door' / 'api' rows — a reverted
--   application never writes them and still reads them. The 0057 row stays in
--   drizzle.__drizzle_migrations: a corrective migration needs a journal
--   `when` above 1785202800000, or the migrator skips it.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "club_staff" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_members" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_memberships" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_payments" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_bookings" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_checkins" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_kiosk_devices" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "club_audit" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
LOCK TABLE "clubs" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- ─── API keys ────────────────────────────────────────────────────────────
CREATE TABLE "club_api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	CONSTRAINT "club_api_keys_club_id_unique" UNIQUE("club_id", "id"),
	CONSTRAINT "club_api_keys_name_sane" CHECK (btrim("club_api_keys"."name") <> '' AND char_length("club_api_keys"."name") <= 60
	      AND "club_api_keys"."name" !~ '[[:cntrl:]]'),
	-- People paste keys into name boxes; stored there a key would sit in
	-- cleartext while its hash went on authenticating it (0015's rule).
	CONSTRAINT "club_api_keys_name_no_key" CHECK (strpos("club_api_keys"."name", 'skbk_') = 0),
	CONSTRAINT "club_api_keys_hash_shape" CHECK ("club_api_keys"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "club_api_keys_prefix_shape" CHECK ("club_api_keys"."prefix" ~ '^skbk_[A-Za-z0-9_-]{6}$'),
	CONSTRAINT "club_api_keys_scopes_known" CHECK (cardinality("club_api_keys"."scopes") BETWEEN 1 AND 16
	      AND "club_api_keys"."scopes" <@ ARRAY['members:read', 'members:write', 'schedule:read',
	        'bookings:write', 'attendance:read', 'attendance:write', 'payments:read']::text[]),
	CONSTRAINT "club_api_keys_created_by_not_blank" CHECK (btrim("club_api_keys"."created_by") <> ''),
	CONSTRAINT "club_api_keys_revoked_by_needs_revoked" CHECK ("club_api_keys"."revoked_by" IS NULL OR "club_api_keys"."revoked_at" IS NOT NULL),
	CONSTRAINT "club_api_keys_times_finite" CHECK (isfinite("club_api_keys"."created_at")
	      AND ("club_api_keys"."last_used_at" IS NULL OR isfinite("club_api_keys"."last_used_at"))
	      AND ("club_api_keys"."revoked_at" IS NULL OR isfinite("club_api_keys"."revoked_at")))
);
--> statement-breakpoint
ALTER TABLE "club_api_keys" ADD CONSTRAINT "club_api_keys_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The lookup: one hash, one index probe, whichever key is presented.
CREATE UNIQUE INDEX "club_api_keys_hash_unique" ON "club_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "club_api_keys_club_live_idx" ON "club_api_keys" USING btree ("club_id","created_at" DESC) WHERE "club_api_keys"."revoked_at" IS NULL;--> statement-breakpoint
-- ─── Idempotency ─────────────────────────────────────────────────────────
CREATE TABLE "club_api_idempotency" (
	"club_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"status_code" smallint,
	"result_kind" text,
	"result_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_api_idempotency_pkey" PRIMARY KEY("key_id","idempotency_key"),
	-- Printable ASCII, no spaces: a UUID, a ULID or any client's own scheme.
	CONSTRAINT "club_api_idempotency_key_shape" CHECK ("club_api_idempotency"."idempotency_key" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "club_api_idempotency_hash_shape" CHECK ("club_api_idempotency"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "club_api_idempotency_state_known" CHECK ("club_api_idempotency"."state" IN ('pending', 'done')),
	CONSTRAINT "club_api_idempotency_done_has_status" CHECK (("club_api_idempotency"."state" = 'done') = ("club_api_idempotency"."status_code" IS NOT NULL)),
	CONSTRAINT "club_api_idempotency_status_sane" CHECK ("club_api_idempotency"."status_code" IS NULL OR "club_api_idempotency"."status_code" BETWEEN 200 AND 599),
	CONSTRAINT "club_api_idempotency_result_kind_known" CHECK ("club_api_idempotency"."result_kind" IS NULL OR "club_api_idempotency"."result_kind" IN ('member', 'booking', 'checkin')),
	CONSTRAINT "club_api_idempotency_result_pair" CHECK (("club_api_idempotency"."result_kind" IS NULL) = ("club_api_idempotency"."result_id" IS NULL)),
	CONSTRAINT "club_api_idempotency_result_id_shape" CHECK ("club_api_idempotency"."result_id" IS NULL OR "club_api_idempotency"."result_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
	CONSTRAINT "club_api_idempotency_error_shape" CHECK ("club_api_idempotency"."error_code" IS NULL OR "club_api_idempotency"."error_code" ~ '^[a-z_]{1,40}$'),
	-- An outcome belongs to a finished request only.
	CONSTRAINT "club_api_idempotency_pending_has_no_outcome" CHECK ("club_api_idempotency"."state" = 'done'
	      OR ("club_api_idempotency"."result_kind" IS NULL AND "club_api_idempotency"."error_code" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "club_api_idempotency" ADD CONSTRAINT "club_api_idempotency_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_api_idempotency" ADD CONSTRAINT "club_api_idempotency_key_fk" FOREIGN KEY ("club_id","key_id") REFERENCES "public"."club_api_keys"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "club_api_idempotency_key_idx" ON "club_api_idempotency" USING btree ("club_id","key_id");--> statement-breakpoint
CREATE INDEX "club_api_idempotency_created_idx" ON "club_api_idempotency" USING btree ("created_at");--> statement-breakpoint
-- ─── Webhook endpoints ───────────────────────────────────────────────────
CREATE TABLE "club_webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"club_id" uuid NOT NULL,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"description" text,
	"secret_version" integer DEFAULT 1 NOT NULL,
	"secret_rotated_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"failing_since" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	CONSTRAINT "club_webhook_endpoints_club_id_unique" UNIQUE("club_id", "id"),
	-- The coarse shape only: https, a host, no credentials, no whitespace. That
	-- the host is PUBLIC is the application's check at save and the worker's at
	-- every connection (a name can resolve anywhere later).
	CONSTRAINT "club_webhook_endpoints_url_shape" CHECK (char_length("club_webhook_endpoints"."url") <= 500
	      AND "club_webhook_endpoints"."url" ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[!-~]*)?$'),
	CONSTRAINT "club_webhook_endpoints_events_known" CHECK (cardinality("club_webhook_endpoints"."events") BETWEEN 1 AND 16
	      AND "club_webhook_endpoints"."events" <@ ARRAY['member.created', 'member.updated', 'member.deleted',
	        'booking.created', 'booking.cancelled', 'checkin.created', 'membership.created',
	        'payment.created']::text[]),
	CONSTRAINT "club_webhook_endpoints_description_sane" CHECK ("club_webhook_endpoints"."description" IS NULL OR (btrim("club_webhook_endpoints"."description") <> ''
	      AND char_length("club_webhook_endpoints"."description") <= 60 AND "club_webhook_endpoints"."description" !~ '[[:cntrl:]]')),
	CONSTRAINT "club_webhook_endpoints_version_sane" CHECK ("club_webhook_endpoints"."secret_version" BETWEEN 1 AND 1000000),
	CONSTRAINT "club_webhook_endpoints_rotation_pair" CHECK (("club_webhook_endpoints"."secret_version" = 1) = ("club_webhook_endpoints"."secret_rotated_at" IS NULL)),
	CONSTRAINT "club_webhook_endpoints_created_by_not_blank" CHECK (btrim("club_webhook_endpoints"."created_by") <> ''),
	CONSTRAINT "club_webhook_endpoints_disabled_pair" CHECK (("club_webhook_endpoints"."disabled_at" IS NULL) = ("club_webhook_endpoints"."disabled_reason" IS NULL)),
	CONSTRAINT "club_webhook_endpoints_disabled_reason_known" CHECK ("club_webhook_endpoints"."disabled_reason" IS NULL OR "club_webhook_endpoints"."disabled_reason" IN ('manual', 'failing'))
);
--> statement-breakpoint
ALTER TABLE "club_webhook_endpoints" ADD CONSTRAINT "club_webhook_endpoints_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- What every enqueue trigger probes: does this club have a live endpoint?
CREATE INDEX "club_webhook_endpoints_live_idx" ON "club_webhook_endpoints" USING btree ("club_id") WHERE "club_webhook_endpoints"."disabled_at" IS NULL;--> statement-breakpoint
-- ─── Webhook deliveries (outbox and log) ─────────────────────────────────
CREATE TABLE "club_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
	"club_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event" text NOT NULL,
	"subject_id" text NOT NULL,
	"member_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_status" smallint,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "club_webhook_deliveries_event_known" CHECK ("club_webhook_deliveries"."event" IN ('member.created', 'member.updated', 'member.deleted',
	        'booking.created', 'booking.cancelled', 'checkin.created', 'membership.created',
	        'payment.created')),
	-- A uuid, or a club_payments id (bigint).
	CONSTRAINT "club_webhook_deliveries_subject_shape" CHECK ("club_webhook_deliveries"."subject_id" ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[1-9][0-9]{0,18})$'),
	CONSTRAINT "club_webhook_deliveries_state_known" CHECK ("club_webhook_deliveries"."state" IN ('pending', 'delivered', 'failed')),
	CONSTRAINT "club_webhook_deliveries_delivered_pair" CHECK (("club_webhook_deliveries"."state" = 'delivered') = ("club_webhook_deliveries"."delivered_at" IS NOT NULL)),
	CONSTRAINT "club_webhook_deliveries_attempts_sane" CHECK ("club_webhook_deliveries"."attempts" BETWEEN 0 AND 50),
	CONSTRAINT "club_webhook_deliveries_status_sane" CHECK ("club_webhook_deliveries"."last_status" IS NULL OR "club_webhook_deliveries"."last_status" BETWEEN 100 AND 599),
	CONSTRAINT "club_webhook_deliveries_error_known" CHECK ("club_webhook_deliveries"."last_error" IS NULL OR "club_webhook_deliveries"."last_error" IN (
	        'timeout', 'dns', 'address_blocked', 'connection', 'tls', 'http_status', 'redirect',
	        'endpoint_disabled', 'not_configured')),
	CONSTRAINT "club_webhook_deliveries_times_finite" CHECK (isfinite("club_webhook_deliveries"."occurred_at") AND isfinite("club_webhook_deliveries"."next_attempt_at"))
);
--> statement-breakpoint
ALTER TABLE "club_webhook_deliveries" ADD CONSTRAINT "club_webhook_deliveries_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_webhook_deliveries" ADD CONSTRAINT "club_webhook_deliveries_endpoint_fk" FOREIGN KEY ("club_id","endpoint_id") REFERENCES "public"."club_webhook_endpoints"("club_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The worker's claim: due rows, oldest first, in the order they were made.
CREATE INDEX "club_webhook_deliveries_due_idx" ON "club_webhook_deliveries" USING btree ("next_attempt_at","seq") WHERE "club_webhook_deliveries"."state" = 'pending';--> statement-breakpoint
-- The office's log per endpoint, and the endpoint key's own index.
CREATE INDEX "club_webhook_deliveries_endpoint_idx" ON "club_webhook_deliveries" USING btree ("club_id","endpoint_id","occurred_at" DESC);--> statement-breakpoint
CREATE INDEX "club_webhook_deliveries_occurred_idx" ON "club_webhook_deliveries" USING btree ("occurred_at");--> statement-breakpoint
-- ─── The enqueue triggers ────────────────────────────────────────────────
-- One function, the event name as the trigger's argument. The subject is the
-- row's id; the client record is the row's member_id (club_members: its own
-- id). Nothing is read beyond the endpoint probe when the club has no live
-- endpoint for the event. member.deleted is queued for a disabled endpoint
-- too (held until it is enabled — the header). The endpoints are read FOR KEY
-- SHARE, so one removed at this instant is skipped, never a failed write.
CREATE FUNCTION club_webhook_enqueue() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_club uuid;
  v_row jsonb;
  v_event text := TG_ARGV[0];
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_club := OLD.club_id;
    -- The purge takes the club's endpoints with it: nothing to tell.
    IF v_club::text = current_setting('pops.purging_club', true) THEN
      RETURN NULL;
    END IF;
  ELSE
    v_club := NEW.club_id;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.club_webhook_endpoints e
                  WHERE e.club_id = v_club AND v_event = ANY(e.events)
                    AND (e.disabled_at IS NULL OR v_event = 'member.deleted')) THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' THEN
    v_row := to_jsonb(OLD);
  ELSE
    v_row := to_jsonb(NEW);
  END IF;
  INSERT INTO public.club_webhook_deliveries (club_id, endpoint_id, event, subject_id, member_id)
  SELECT e.club_id, e.id, v_event, v_row->>'id',
         CASE WHEN TG_TABLE_NAME = 'club_members' THEN (v_row->>'id')::uuid
              ELSE (v_row->>'member_id')::uuid END
    FROM public.club_webhook_endpoints e
   WHERE e.club_id = v_club AND v_event = ANY(e.events)
     AND (e.disabled_at IS NULL OR v_event = 'member.deleted')
     FOR KEY SHARE OF e;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_members_webhook_created" AFTER INSERT ON "club_members"
FOR EACH ROW EXECUTE FUNCTION club_webhook_enqueue('member.created');--> statement-breakpoint
-- What an integrator mirrors: the record's identity and contact, its tags and
-- whether it is archived — not the staff note, the lead fields or a consent.
CREATE TRIGGER "club_members_webhook_updated" AFTER UPDATE ON "club_members"
FOR EACH ROW WHEN ((OLD.display_name, OLD.email, OLD.phone, OLD.is_minor, OLD.guardian_member_id,
                    OLD.tags, OLD.archived_at)
                   IS DISTINCT FROM
                   (NEW.display_name, NEW.email, NEW.phone, NEW.is_minor, NEW.guardian_member_id,
                    NEW.tags, NEW.archived_at))
EXECUTE FUNCTION club_webhook_enqueue('member.updated');--> statement-breakpoint
-- The club erased a record: its integrations must delete their copy too.
CREATE TRIGGER "club_members_webhook_deleted" AFTER DELETE ON "club_members"
FOR EACH ROW EXECUTE FUNCTION club_webhook_enqueue('member.deleted');--> statement-breakpoint
CREATE TRIGGER "club_bookings_webhook_created" AFTER INSERT ON "club_bookings"
FOR EACH ROW EXECUTE FUNCTION club_webhook_enqueue('booking.created');--> statement-breakpoint
-- A cancelled place booked again is the same row back to 'active'.
CREATE TRIGGER "club_bookings_webhook_reactivated" AFTER UPDATE OF "state" ON "club_bookings"
FOR EACH ROW WHEN (OLD.state <> 'active' AND NEW.state = 'active')
EXECUTE FUNCTION club_webhook_enqueue('booking.created');--> statement-breakpoint
CREATE TRIGGER "club_bookings_webhook_cancelled" AFTER UPDATE OF "state" ON "club_bookings"
FOR EACH ROW WHEN (OLD.state = 'active' AND NEW.state <> 'active')
EXECUTE FUNCTION club_webhook_enqueue('booking.cancelled');--> statement-breakpoint
CREATE TRIGGER "club_checkins_webhook_created" AFTER INSERT ON "club_checkins"
FOR EACH ROW EXECUTE FUNCTION club_webhook_enqueue('checkin.created');--> statement-breakpoint
CREATE TRIGGER "club_memberships_webhook_created" AFTER INSERT ON "club_memberships"
FOR EACH ROW EXECUTE FUNCTION club_webhook_enqueue('membership.created');--> statement-breakpoint
CREATE TRIGGER "club_payments_webhook_created" AFTER INSERT ON "club_payments"
FOR EACH ROW EXECUTE FUNCTION club_webhook_enqueue('payment.created');--> statement-breakpoint
-- ─── Door devices ────────────────────────────────────────────────────────
-- One statement, one scan. A door is created with its secret; only a tablet
-- is paired by code.
ALTER TABLE "club_kiosk_devices"
  ADD COLUMN "kind" text DEFAULT 'kiosk' NOT NULL,
  ADD COLUMN "access_rule" text,
  ADD CONSTRAINT "club_kiosk_devices_kind_known" CHECK ("club_kiosk_devices"."kind" IN ('kiosk', 'door')),
  ADD CONSTRAINT "club_kiosk_devices_rule_for_doors" CHECK (("club_kiosk_devices"."kind" = 'door') = ("club_kiosk_devices"."access_rule" IS NOT NULL)
      AND ("club_kiosk_devices"."access_rule" IS NULL OR "club_kiosk_devices"."access_rule" IN ('member', 'covered'))),
  ADD CONSTRAINT "club_kiosk_devices_door_never_paired_by_code" CHECK ("club_kiosk_devices"."kind" = 'kiosk' OR "club_kiosk_devices"."pairing_code_hash" IS NULL);--> statement-breakpoint
-- A tablet never becomes a door, nor a door a tablet.
CREATE FUNCTION club_kiosk_devices_keep_kind() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'club_kiosk_devices_keep_kind: a device keeps the kind it was created with'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'club_kiosk_devices_keep_kind';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "club_kiosk_devices_keep_kind" BEFORE UPDATE OF "kind" ON "club_kiosk_devices"
FOR EACH ROW EXECUTE FUNCTION club_kiosk_devices_keep_kind();--> statement-breakpoint
-- ─── Check-ins: the door ─────────────────────────────────────────────────
-- One statement, one scan of the table.
ALTER TABLE "club_checkins"
  DROP CONSTRAINT "club_checkins_method_known",
  DROP CONSTRAINT "club_checkins_recorder_matches_method",
  DROP CONSTRAINT "club_checkins_only_scans_reach_the_passport",
  ADD CONSTRAINT "club_checkins_method_known" CHECK ("club_checkins"."method" IN ('qr_kiosk', 'qr_member', 'card', 'desk', 'api', 'door')),
  ADD CONSTRAINT "club_checkins_recorder_matches_method" CHECK (("club_checkins"."method" IN ('qr_kiosk', 'api', 'door')) = ("club_checkins"."recorded_by" IS NULL)),
  ADD CONSTRAINT "club_checkins_only_scans_reach_the_passport" CHECK ("club_checkins"."training_log_id" IS NULL OR "club_checkins"."method" IN ('qr_kiosk', 'qr_member', 'card', 'door'));--> statement-breakpoint
-- 0043's guard, with 'door' admitted and nothing else changed.
CREATE OR REPLACE FUNCTION training_logs_club_row_is_a_checkin() RETURNS trigger
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
       AND c.method IN ('qr_kiosk', 'qr_member', 'card', 'door')
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
-- ─── Vocabulary ──────────────────────────────────────────────────────────
ALTER TABLE "club_members"
  DROP CONSTRAINT "club_members_source_known",
  ADD CONSTRAINT "club_members_source_known" CHECK ("club_members"."source" IN ('staff', 'import', 'self', 'api'));--> statement-breakpoint
-- One statement, one scan: the actor kinds, the NULL actor a door has (beside
-- 'system' and 'kiosk'), and the actions.
ALTER TABLE "club_audit"
  DROP CONSTRAINT "club_audit_actor_kind_known",
  DROP CONSTRAINT "club_audit_actor_matches_kind",
  DROP CONSTRAINT "club_audit_action_known",
  ADD CONSTRAINT "club_audit_actor_kind_known" CHECK ("club_audit"."actor_kind" IN ('staff', 'member', 'ngo_admin', 'system', 'kiosk', 'api', 'door')),
  ADD CONSTRAINT "club_audit_actor_matches_kind" CHECK (("club_audit"."actor_kind" IN ('system', 'kiosk', 'door')) = ("club_audit"."actor_id" IS NULL)),
  ADD CONSTRAINT "club_audit_action_known" CHECK ("club_audit"."action" IN (
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
	    'rank_saved', 'rank_moved', 'rank_removed', 'rank_awarded', 'rank_revoked',
	    'api_key_created', 'api_key_revoked', 'webhook_saved', 'webhook_disabled',
	    'webhook_enabled', 'webhook_removed', 'webhook_secret_rotated',
	    'door_device_created', 'door_device_revoked'));--> statement-breakpoint
COMMENT ON TABLE "club_api_keys" IS 'A club''s API key (0057): SHA-256 only (the column cannot hold a key), six characters to tell keys apart, closed scopes. Acts as the member of staff who created it (by value), with their CURRENT role, narrowed to its scopes; refused once they no longer work at the club. Revoked, never deleted; last_used_at moves at most once a minute.';--> statement-breakpoint
COMMENT ON TABLE "club_api_idempotency" IS 'One row per (key, Idempotency-Key) for a day (0057): the request''s hash and its outcome as a status, the kind and id of what it made, or a closed error code — never a response body. Pruned by the worker.';--> statement-breakpoint
COMMENT ON TABLE "club_webhook_endpoints" IS 'Where a club wants its events posted (0057): an https URL whose host must be public (checked at save and at every connection), closed event names. The signing secret is derived from CLUB_WEBHOOK_SECRET, the id and secret_version — never stored; for a day after a rotation both versions sign. Disabled by hand or by the worker after three failing days.';--> statement-breakpoint
COMMENT ON TABLE "club_webhook_deliveries" IS 'Outbox and delivery log (0057): written by club_webhook_enqueue in the transaction that made the change; thin (event, subject id, client record id by value). The worker claims due rows by lease, backs off, gives up after 8 attempts. Pruned after 30 days.';--> statement-breakpoint
COMMENT ON COLUMN "club_kiosk_devices"."kind" IS 'kiosk: a tablet at the desk, paired by code (0039). door: a door or turnstile controller (0057), created with its secret, posting scans to /api/clubs/v1/access/check under access_rule (member | covered).';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
