-- 0019_partners: the partners & sponsors registry (docs/MONETISATION.md M1).
--
-- WHY. Monetisation's enabler: one institutional-entity table that every
-- sponsorship surface reads — the public /partnyori page now; campaign
-- sponsorship (M2, a future partner_id FK on campaigns) and adopt-a-facility
-- (M3, a future facility_sponsorships table) later, both RESTRICTing on this
-- table, which is why a partner is HIDDEN (visible=false, the default),
-- never deleted. When M2's FK lands, THAT migration carries the index on the
-- referencing column (the every-FK-gets-an-index rule binds the child side).
--
-- Content is bilingual COLUMNS (name_bg/name_en, blurb_bg/blurb_en — the
-- campaigns pattern: admin CONTENT, not UI strings, so an untranslated
-- partner still renders and the i18n parity gate stays out of it). The blurb
-- is "how we partner", written by the operator per partner. Tier is TEXT +
-- CHECK rather than an enum: adding a tier is one ALTER of one CHECK, not
-- the two-invocation enum dance 0014's header documents.
--
-- DELIBERATE ABSENCES, decided in the plan and repeated here so a future
-- migration does not "fix" them:
--   * No contact-person columns. Sponsor contacts are natural persons; they
--     live in the offline CRM under the NGO's records of processing. This
--     table holds institutional identity only — nothing resolves to a person.
--   * NOT on the open-data ALLOWED_RELATIONS (lib/src/opendata/schema.ts) —
--     the 0018 businesses posture; the allowlist test makes silent leakage
--     impossible either way.
--
-- logo_path is a storage-adapter key (partners/yyyy/mm/<uuid>.webp), written
-- by the admin upload through the same EXIF-stripping pipeline as facility
-- photos, served by a row-decides route — same CHECK shape as
-- facility_photos_storage_path_sane. Rendering everywhere is
-- `visible AND window active` (starts_on/ends_on civil dates, NULL = open).
--
-- rollback (compensating SQL, DESTRUCTIVE once populated — it drops
-- operator-entered partner rows): DROP TABLE partners;

CREATE TABLE "partners" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "partners_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"slug" text NOT NULL,
	"tier" text NOT NULL,
	"name_bg" text NOT NULL,
	"name_en" text,
	"blurb_bg" text,
	"blurb_en" text,
	"url" text,
	"logo_path" text,
	"visible" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "partners_slug_unique" UNIQUE("slug"),
	CONSTRAINT "partners_slug_shape" CHECK ("partners"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length("partners"."slug") <= 60),
	CONSTRAINT "partners_tier_known" CHECK ("partners"."tier" IN ('headline', 'category', 'supporter', 'institutional')),
	CONSTRAINT "partners_name_sane" CHECK (btrim("partners"."name_bg") <> '' AND char_length("partners"."name_bg") <= 120 AND ("partners"."name_en" IS NULL OR (btrim("partners"."name_en") <> '' AND char_length("partners"."name_en") <= 120))),
	CONSTRAINT "partners_blurb_sane" CHECK (("partners"."blurb_bg" IS NULL OR (btrim("partners"."blurb_bg") <> '' AND char_length("partners"."blurb_bg") <= 2000)) AND ("partners"."blurb_en" IS NULL OR (btrim("partners"."blurb_en") <> '' AND char_length("partners"."blurb_en") <= 2000))),
	CONSTRAINT "partners_url_shape" CHECK ("partners"."url" IS NULL OR ("partners"."url" ~ '^https?://[^[:space:]]+$' AND char_length("partners"."url") <= 300)),
	CONSTRAINT "partners_logo_path_sane" CHECK ("partners"."logo_path" IS NULL OR ("partners"."logo_path" <> '' AND "partners"."logo_path" !~ '^/' AND "partners"."logo_path" !~ '(^|/)\.\.(/|$)')),
	CONSTRAINT "partners_window_order" CHECK ("partners"."starts_on" IS NULL OR "partners"."ends_on" IS NULL OR "partners"."ends_on" >= "partners"."starts_on")
);
