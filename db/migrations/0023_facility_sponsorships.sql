-- 0023_facility_sponsorships: adopt-a-facility («Осинови игрище») —
-- docs/MONETISATION.md S3, phase M3a.
--
-- AN ADJACENT TABLE, NOT A COLUMN ON `facilities`, and that is the entire
-- safety argument for this feature. Sponsorship never touches a facility row, so
-- it is outside the merge policy (crowd > municipal > osm), outside
-- `facility_edits` provenance, and outside every crowd-data protection. A
-- sponsor therefore acquires zero authority over facility data or moderation —
-- no per-facility authority concept exists in this schema, and adopting a pitch
-- must not invent one.
--
-- ALWAYS BOUNDED. Both dates are NOT NULL, unlike a partner window: an adoption
-- is an annual arrangement over a piece of PUBLIC infrastructure and it must
-- lapse visibly rather than become a standing claim. A missing end date would be
-- exactly the row nobody ever revisits.
--
-- ONE ADOPTION PER FACILITY AT A TIME:
--
--   EXCLUDE USING gist (facility_id WITH =, daterange(starts_on, ends_on, '[]') WITH &&)
--
--   * Unconditional, unlike 0021's ad-slot exclusion, which is partial on
--     `visible`. There is no draft state here: a sponsorship row IS the
--     arrangement, so two overlapping rows for one facility are a double sale
--     rather than an operator preparing next year.
--   * btree_gist supplies uuid equality for GiST; PG16 supports it. This file
--     creates it too (`IF NOT EXISTS`, sub-millisecond) rather than relying on
--     0021 having run: if 0021 were ever skipped — the exact `when`-stamp trap
--     0020's header documents — this migration would fail with "data type uuid
--     has no default operator class for access method gist" and roll the whole
--     run back. A self-contained file cannot be broken by its siblings.
--   * `'[]'` keeps `ends_on` inclusive, matching the campaigns and ad-slot
--     window convention.
--   * DRIZZLE CANNOT EXPRESS THIS — hand-written here, absent from
--     meta/0023_snapshot.json. drizzle-kit will not drop what it does not know
--     about, but it will never recreate it either: a fresh database depends on
--     THIS file, so do not regenerate this migration.
--
-- RENDERING IS NOT IN THIS TABLE, and the migration says so because the rule is
-- easy to reimplement wrongly: a sponsorship shows only where the PARTNER is
-- visible AND the partner window is active AND the sponsorship window is active
-- (apps/web/lib/facility-sponsors.ts embeds `PARTNER_RENDERABLE`). Without the
-- partner half, a hidden or lapsed sponsor would keep a logo on a facility page
-- that /partnyori denies exists.
--
-- ACKNOWLEDGMENT FOLLOWS DOCUMENTED WORK (§S3). "Поддържа се от X" is a factual
-- claim on a platform whose brand is verifiable data, so the operator creates
-- the row after the funded upkeep is evidenced — the condition-report flow is
-- that evidence trail. Nothing in the schema can enforce that; it is a policy the
-- admin screen states and this comment records.
--
-- NOT ON THE OPEN-DATA ALLOWLIST (lib/src/opendata/schema.ts), like every table
-- in this plan — which is also why the facility export is byte-identical before
-- and after an adoption exists. §7.4 asked whether "adopted by" should ever
-- become a declared open-data field; the default and the recommendation is no,
-- and until an operator decision says otherwise this table stays invisible to
-- exports.
--
-- LOCKING. A new table; the two ADD CONSTRAINT … FOREIGN KEY statements take
-- ACCESS EXCLUSIVE on `facility_sponsorships` (empty) and ShareRowExclusive on
-- `facilities`/`partners` — brief, and taken while nothing is writing them.
-- Guards first, reset last (0020's pattern: one transaction for the whole run).
--
-- rollback (compensating SQL; DESTRUCTIVE once populated — it drops adoption
-- rows, which are contractual records). ONE EXPLICIT TRANSACTION, for the reason
-- 0021's header spells out: `SET LOCAL` outside a transaction block is a no-op
-- with a WARNING, so the lock guard would not exist at all.
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   DROP TABLE "facility_sponsorships";
--   COMMIT;
--
-- JOURNAL: idx 23 is hand-stamped 1785080400000 — see 0020's header.

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TABLE "facility_sponsorships" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "facility_sponsorships_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"facility_id" uuid NOT NULL,
	"partner_id" bigint NOT NULL,
	"label_bg" text,
	"label_en" text,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facility_sponsorships_label_sane" CHECK (("facility_sponsorships"."label_bg" IS NULL OR (btrim("facility_sponsorships"."label_bg") <> '' AND char_length("facility_sponsorships"."label_bg") <= 200))
          AND ("facility_sponsorships"."label_en" IS NULL OR (btrim("facility_sponsorships"."label_en") <> '' AND char_length("facility_sponsorships"."label_en") <= 200))),
	CONSTRAINT "facility_sponsorships_window_order" CHECK ("facility_sponsorships"."ends_on" >= "facility_sponsorships"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "facility_sponsorships" ADD CONSTRAINT "facility_sponsorships_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id") REFERENCES "public"."facilities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facility_sponsorships" ADD CONSTRAINT "facility_sponsorships_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "facility_sponsorships_facility_idx" ON "facility_sponsorships" USING btree ("facility_id");--> statement-breakpoint
CREATE INDEX "facility_sponsorships_partner_idx" ON "facility_sponsorships" USING btree ("partner_id");--> statement-breakpoint
ALTER TABLE "facility_sponsorships" ADD CONSTRAINT "facility_sponsorships_one_per_facility" EXCLUDE USING gist ("facility_id" WITH =, daterange("starts_on", "ends_on", '[]') WITH &&);--> statement-breakpoint
COMMENT ON TABLE "facility_sponsorships" IS 'Adopt-a-facility (MONETISATION S3). ADJACENT to facilities, never a column on it: sponsorship stays outside the merge policy, facility_edits provenance and every crowd-data protection, so a sponsor gets no authority over facility data or moderation. Always time-bounded; one adoption per facility per period (facility_sponsorships_one_per_facility). Rendering additionally requires the partner to be visible and in window. Not on the open-data ALLOWED_RELATIONS.';--> statement-breakpoint
CREATE TRIGGER "facility_sponsorships_set_updated_at" BEFORE UPDATE ON "facility_sponsorships" FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
COMMENT ON COLUMN "facility_sponsorships"."updated_at" IS 'Maintained by the facility_sponsorships_set_updated_at trigger (set_updated_at() from 0001). The trigger exists because there is no UPDATE path in the application today — without it the column would permanently equal created_at and document nothing about a row that is a contractual record.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
