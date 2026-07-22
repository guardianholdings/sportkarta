-- 0001_core-facilities: Stage 1 data foundation (docs/ROADMAP.md §3) —
-- facilities, municipalities, facility_photos, append-only facility_edits,
-- sources lookup. All tables are NEW and empty: plain CREATE INDEX is safe
-- here (CONCURRENTLY is required only on populated tables).
--
-- Enum extension policy (no table locks): add values in a later migration via
-- ALTER TYPE ... ADD VALUE IF NOT EXISTS '<v>'; rows that USE the new value
-- must wait for the migration after that (Postgres forbids using an enum
-- value added inside the same transaction).
--
-- rollback: restore from backup — destructive. Compensating SQL, reverse order:
--   DROP TABLE facility_edits, facility_photos, facilities, sources, municipalities;
--   DROP FUNCTION forbid_facility_edits_mutation(), set_updated_at();
--   DROP TYPE photo_status, facility_source, facility_status, facility_access;
CREATE TYPE "facility_access" AS ENUM ('free', 'paid', 'restricted', 'school');
--> statement-breakpoint
CREATE TYPE "facility_status" AS ENUM ('active', 'needs_verification', 'gone');
--> statement-breakpoint
CREATE TYPE "facility_source" AS ENUM ('osm', 'municipal', 'crowd');
--> statement-breakpoint
CREATE TYPE "photo_status" AS ENUM ('pending', 'approved', 'rejected');
--> statement-breakpoint
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TABLE "municipalities" (
	"id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"ekatte_code" text NOT NULL,
	"name_bg" text NOT NULL,
	"name_en" text NOT NULL,
	"geom" geometry(MultiPolygon, 4326) NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "municipalities_ekatte_code_unique" UNIQUE ("ekatte_code"),
	CONSTRAINT "municipalities_ekatte_code_not_blank" CHECK (btrim("ekatte_code") <> ''),
	CONSTRAINT "municipalities_name_bg_not_blank" CHECK (btrim("name_bg") <> ''),
	CONSTRAINT "municipalities_name_en_not_blank" CHECK (btrim("name_en") <> ''),
	CONSTRAINT "municipalities_geom_valid" CHECK (ST_IsValid("geom"))
);
--> statement-breakpoint
CREATE INDEX "municipalities_geom_gist" ON "municipalities" USING gist ("geom");
--> statement-breakpoint
CREATE TRIGGER "municipalities_set_updated_at"
BEFORE UPDATE ON "municipalities"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TABLE "sources" (
	"code" "facility_source" PRIMARY KEY,
	"name" text NOT NULL,
	"url" text,
	"license" text,
	"attribution" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "sources_name_not_blank" CHECK (btrim("name") <> '')
);
--> statement-breakpoint
CREATE TRIGGER "sources_set_updated_at"
BEFORE UPDATE ON "sources"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Reference rows, not user data: one row per facility_source enum value.
-- Attribution strings surface on every map view/export (ODbL — CLAUDE.md).
INSERT INTO "sources" ("code", "name", "url", "license", "attribution") VALUES
	('osm', 'OpenStreetMap', 'https://www.openstreetmap.org', 'ODbL 1.0', '© OpenStreetMap contributors'),
	('municipal', 'Municipal data', NULL, NULL, NULL),
	('crowd', 'SportKarta community', NULL, NULL, NULL);
--> statement-breakpoint
CREATE TABLE "facilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"geom" geometry(Point, 4326) NOT NULL,
	"name" text,
	"sport_types" text[] NOT NULL DEFAULT '{}',
	"surface" text,
	"lighting" boolean,
	"covered" boolean NOT NULL DEFAULT false,
	"access" "facility_access" NOT NULL,
	"status" "facility_status" NOT NULL DEFAULT 'active',
	"municipality_id" integer,
	"quarter" text,
	"source" "facility_source" NOT NULL,
	"osm_type" text,
	"osm_id" bigint,
	"attrs" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	"updated_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "facilities_municipality_id_municipalities_id_fk" FOREIGN KEY ("municipality_id")
		REFERENCES "municipalities"("id") ON DELETE RESTRICT,
	-- Guarantees a sources row (attribution — ODbL) exists for every value in use.
	CONSTRAINT "facilities_source_sources_code_fk" FOREIGN KEY ("source")
		REFERENCES "sources"("code") ON DELETE RESTRICT,
	CONSTRAINT "facilities_name_not_blank" CHECK ("name" IS NULL OR btrim("name") <> ''),
	CONSTRAINT "facilities_surface_not_blank" CHECK ("surface" IS NULL OR btrim("surface") <> ''),
	CONSTRAINT "facilities_quarter_not_blank" CHECK ("quarter" IS NULL OR btrim("quarter") <> ''),
	-- Whitespace-only elements are the import layer's job to normalize (tag mapping).
	CONSTRAINT "facilities_sport_types_no_blanks"
		CHECK (array_position("sport_types", NULL) IS NULL AND array_position("sport_types", '') IS NULL),
	CONSTRAINT "facilities_geom_in_bulgaria"
		CHECK (ST_X("geom") BETWEEN 22.0 AND 29.0 AND ST_Y("geom") BETWEEN 41.0 AND 44.5),
	CONSTRAINT "facilities_osm_ref_pair" CHECK (("osm_type" IS NULL) = ("osm_id" IS NULL)),
	CONSTRAINT "facilities_osm_type_valid"
		CHECK ("osm_type" IS NULL OR "osm_type" IN ('node', 'way', 'relation')),
	CONSTRAINT "facilities_osm_source_has_ref" CHECK ("source" <> 'osm' OR "osm_id" IS NOT NULL),
	CONSTRAINT "facilities_attrs_is_object" CHECK (jsonb_typeof("attrs") = 'object')
);
--> statement-breakpoint
COMMENT ON COLUMN "facilities"."lighting" IS 'NULL = unknown';
--> statement-breakpoint
COMMENT ON COLUMN "facilities"."attrs" IS 'Raw source attributes (e.g. OSM tags) — provenance, never authoritative';
--> statement-breakpoint
CREATE INDEX "facilities_geom_gist" ON "facilities" USING gist ("geom");
--> statement-breakpoint
CREATE UNIQUE INDEX "facilities_osm_ref_unique" ON "facilities" ("osm_type", "osm_id")
	WHERE "osm_type" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "facilities_municipality_id_idx" ON "facilities" ("municipality_id");
--> statement-breakpoint
CREATE INDEX "facilities_source_idx" ON "facilities" ("source");
--> statement-breakpoint
CREATE INDEX "facilities_sport_types_gin" ON "facilities" USING gin ("sport_types");
--> statement-breakpoint
CREATE TRIGGER "facilities_set_updated_at"
BEFORE UPDATE ON "facilities"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TABLE "facility_photos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"facility_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"status" "photo_status" NOT NULL DEFAULT 'pending',
	"uploaded_by" text,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT "facility_photos_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id")
		REFERENCES "facilities"("id") ON DELETE CASCADE,
	CONSTRAINT "facility_photos_storage_path_unique" UNIQUE ("storage_path"),
	-- Storage-adapter key: relative, forward-slash, no traversal (lib/src/storage).
	CONSTRAINT "facility_photos_storage_path_sane"
		CHECK ("storage_path" <> '' AND "storage_path" !~ '^/' AND "storage_path" !~ '(^|/)\.\.(/|$)')
);
--> statement-breakpoint
COMMENT ON COLUMN "facility_photos"."uploaded_by" IS 'better-auth user id from Stage 3; FK added when the users table exists';
--> statement-breakpoint
CREATE INDEX "facility_photos_facility_id_idx" ON "facility_photos" ("facility_id");
--> statement-breakpoint
CREATE INDEX "facility_photos_pending_created_idx" ON "facility_photos" ("created_at")
	WHERE "status" = 'pending';
--> statement-breakpoint
CREATE TABLE "facility_edits" (
	"id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	"facility_id" uuid NOT NULL,
	"actor" text,
	"source" "facility_source" NOT NULL,
	"field" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"created_at" timestamptz NOT NULL DEFAULT now(),
	-- RESTRICT on purpose: audited facilities are never hard-deleted (status='gone').
	CONSTRAINT "facility_edits_facility_id_facilities_id_fk" FOREIGN KEY ("facility_id")
		REFERENCES "facilities"("id") ON DELETE RESTRICT,
	CONSTRAINT "facility_edits_field_not_blank" CHECK (btrim("field") <> ''),
	-- A change TO null is recorded as 'null'::jsonb; SQL NULL means "no value side".
	CONSTRAINT "facility_edits_has_value" CHECK ("old_value" IS NOT NULL OR "new_value" IS NOT NULL)
);
--> statement-breakpoint
COMMENT ON TABLE "facility_edits" IS 'Append-only audit log — every field-level change with provenance; immutability enforced by triggers';
--> statement-breakpoint
CREATE INDEX "facility_edits_facility_created_idx" ON "facility_edits" ("facility_id", "created_at");
--> statement-breakpoint
-- The app connects as the table owner (single-role deployment), so GRANT/REVOKE
-- cannot enforce append-only; triggers can and do.
CREATE FUNCTION forbid_facility_edits_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'facility_edits is append-only (audit log)';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "facility_edits_no_update"
BEFORE UPDATE ON "facility_edits"
FOR EACH ROW EXECUTE FUNCTION forbid_facility_edits_mutation();
--> statement-breakpoint
CREATE TRIGGER "facility_edits_no_delete"
BEFORE DELETE ON "facility_edits"
FOR EACH ROW EXECUTE FUNCTION forbid_facility_edits_mutation();
--> statement-breakpoint
CREATE TRIGGER "facility_edits_no_truncate"
BEFORE TRUNCATE ON "facility_edits"
FOR EACH STATEMENT EXECUTE FUNCTION forbid_facility_edits_mutation();
