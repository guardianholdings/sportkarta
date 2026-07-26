-- 0021_ad_placements: direct-sold, first-party-served ad slots
-- (docs/MONETISATION.md S5, phase M4).
--
-- WHY THIS IS NOT AN AD SERVER. The table holds a creative FILE we host, a
-- link, an alt text and a window. It has no impression counter, no click
-- counter, no viewer attribute and no third-party script URL, and the slot is
-- chosen by PAGE CONTEXT alone — never by anything about the person reading.
-- That is the whole reason the platform still needs no consent banner and the
-- privacy page's "не проследяваме потребителите" survives this feature. A
-- future migration that adds an impressions column to this table is changing
-- that posture and must say so out loud.
--
-- AN ADVERTISER IS A PARTNER. `partners.tier` gains 'advertiser' rather than
-- getting its own table: same creative pipeline, same acceptance policy, same
-- deliberate absence of contact columns. That is the payoff of 0019's decision
-- to make `tier` TEXT + CHECK instead of an enum — adding a tier is the single
-- DROP/ADD CONSTRAINT pair below, not the two-invocation enum dance 0014's
-- header documents.
--
-- EXCLUSIVITY IS A CONSTRAINT, NOT APPLICATION CODE:
--
--   EXCLUDE USING gist (slot WITH =, daterange(starts_on, ends_on, '[]') WITH &&)
--     WHERE (visible)
--
--   * `WHERE (visible)` is deliberate. Two DRAFT placements may overlap — an
--     operator preparing next month's sale while this month runs is normal, and
--     a constraint that forbade it would make the admin screen unusable. What
--     cannot happen is two VISIBLE placements colliding on a slot: the second
--     one fails at the moment somebody tries to publish it, which is exactly
--     when a human is present to be told "that slot is taken".
--   * `'[]'` — both ends inclusive, matching the campaigns window convention
--     (`ends_on` inclusive as authored). A slot sold "1–31 March" is free on
--     1 April and not before.
--   * DRIZZLE CANNOT EXPRESS THIS. It is hand-written here and therefore absent
--     from meta/0021_snapshot.json. That is safe in one direction only:
--     drizzle-kit will not drop what it does not know about, but it will also
--     never recreate it, so a future `db:reset` depends on THIS file — do not
--     "regenerate" this migration.
--
-- btree_gist IS THE FIRST POST-INIT EXTENSION. 0000 creates only postgis, and a
-- GiST exclusion over `slot WITH =` (text equality) needs btree_gist. It is a
-- TRUSTED extension in PG13+, so the database owner can create it without
-- superuser, and the prod image (postgis/postgis:16-3.4) ships it. The
-- alternative the plan named — a partial unique index plus an application check
-- — was rejected: it cannot express range overlap, so it would only catch
-- identical windows and would let 1–15 March and 10–20 March both go live.
--
-- NOT ON THE OPEN-DATA ALLOWLIST (lib/src/opendata/schema.ts), like every table
-- in this plan. The allowlist makes that structural rather than a promise.
--
-- LOCKING, AND THE HOLD IS LONGER THAN THIS FILE. `SET LOCAL` first (0020's
-- corrected pattern: session-scoped `SET` would outlive the file, and even SET
-- LOCAL leaks into the later migrations of the same run, since drizzle wraps
-- them all in ONE transaction — hence the explicit reset at the end).
--
-- CREATE TABLE and its constraints take locks on a table nothing can be reading
-- yet. The statements that touch a LIVE table are the DROP/ADD of
-- `partners_tier_known`: ADD CONSTRAINT … CHECK takes ACCESS EXCLUSIVE on
-- `partners` and full-scans it (a handful of rows).
--
-- BE PRECISE ABOUT THE RELEASE POINT, because the obvious sentence is wrong.
-- Placing these at the end of THIS file does not bound the hold to a few
-- milliseconds: drizzle runs the entire migration RUN in one transaction, so the
-- ACCESS EXCLUSIVE lock taken here is held until the LAST file of the run
-- commits — through 0022's ADD COLUMN, its FK validation and index build, and
-- all of 0023. Every one of those statements can itself wait up to its own 3 s
-- lock_timeout, so the worst case is on the order of ten seconds during which
-- every read of `partners` blocks: `/partnyori`, plus every facility, city and
-- weekly page, since the ad slot and the sponsor block both JOIN it.
--
-- That is ACCEPTED here rather than engineered away, and the reasoning is
-- recorded so the next author does not inherit a false comfort: these three
-- migrations deploy together on a site whose `partners` table has single-digit
-- rows, every statement in the run is catalog-only or scans tens of rows, and
-- the alternative (splitting the tier swap into its own trailing migration)
-- buys a few seconds at the cost of a migration whose only content is one
-- CHECK. If a future run adds a real backfill AFTER this file, move the tier
-- swap into that run's last migration — the window is bounded by whatever
-- finishes last, not by where this statement sits.
--
-- rollback (compensating SQL; DESTRUCTIVE once sold — it drops operator-entered
-- placements and their creative keys, orphaning the files in storage).
--
-- IT MUST RUN INSIDE ONE EXPLICIT TRANSACTION, and the BEGIN/COMMIT is not
-- decoration. psql autocommits each statement, and `SET LOCAL` outside a
-- transaction block is a WARNING and a no-op — so run statement by statement,
-- the lock_timeout guard would not exist (the ALTERs on `partners` would wait
-- unbounded and queue every reader behind them), and a failure partway would
-- leave `ad_placements` dropped and `partners` carrying NO tier CHECK at all,
-- silently accepting any string in `tier` from then on. The tier repair is
-- inside the transaction for the same reason: it is what makes the re-ADD
-- succeed, and if the operator does not want it, the whole rollback should abort
-- rather than half-apply.
--
--   BEGIN;
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   -- Who blocks the re-ADD (an advertiser is not a valid pre-0021 tier):
--   --   SELECT slug FROM partners WHERE tier = 'advertiser';
--   -- The operator's decision, if it is to retire them rather than abort:
--   UPDATE partners SET tier = 'supporter', visible = false WHERE tier = 'advertiser';
--   DROP TABLE "ad_placements";
--   ALTER TABLE "partners" DROP CONSTRAINT "partners_tier_known";
--   ALTER TABLE "partners" ADD CONSTRAINT "partners_tier_known"
--     CHECK ("partners"."tier" IN ('headline', 'category', 'supporter', 'institutional'));
--   COMMIT;
--   -- btree_gist is left installed: dropping an extension another migration may
--   -- come to depend on buys nothing.
--
-- JOURNAL: idx 21 is hand-stamped 1785073200000 because drizzle applies a file
-- only when its `when` exceeds the newest applied `created_at`, and 0019/0020
-- are stamped ahead of the wall clock (see 0020's header). Every later
-- migration must keep clearing that bar.

SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS btree_gist;--> statement-breakpoint
CREATE TABLE "ad_placements" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ad_placements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"partner_id" bigint NOT NULL,
	"slot" text NOT NULL,
	"creative_path" text NOT NULL,
	"url" text NOT NULL,
	"alt_bg" text NOT NULL,
	"alt_en" text,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"visible" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_placements_slot_known" CHECK ("ad_placements"."slot" IN ('facility_page', 'city_page', 'weekly_page', 'map_panel')),
	CONSTRAINT "ad_placements_creative_path_sane" CHECK ("ad_placements"."creative_path" <> '' AND "ad_placements"."creative_path" !~ '^/' AND "ad_placements"."creative_path" !~ '(^|/)\.\.(/|$)'),
	CONSTRAINT "ad_placements_url_shape" CHECK ("ad_placements"."url" ~ '^https?://[^[:space:]]+$' AND char_length("ad_placements"."url") <= 300),
	CONSTRAINT "ad_placements_alt_sane" CHECK (btrim("ad_placements"."alt_bg") <> '' AND char_length("ad_placements"."alt_bg") <= 200 AND ("ad_placements"."alt_en" IS NULL OR (btrim("ad_placements"."alt_en") <> '' AND char_length("ad_placements"."alt_en") <= 200))),
	CONSTRAINT "ad_placements_window_order" CHECK ("ad_placements"."ends_on" >= "ad_placements"."starts_on")
);
--> statement-breakpoint
ALTER TABLE "ad_placements" ADD CONSTRAINT "ad_placements_partner_id_partners_id_fk" FOREIGN KEY ("partner_id") REFERENCES "public"."partners"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_placements" ADD CONSTRAINT "ad_placements_one_visible_per_slot" EXCLUDE USING gist ("slot" WITH =, daterange("starts_on", "ends_on", '[]') WITH &&) WHERE ("visible");--> statement-breakpoint
CREATE INDEX "ad_placements_partner_idx" ON "ad_placements" USING btree ("partner_id");--> statement-breakpoint
CREATE INDEX "ad_placements_slot_idx" ON "ad_placements" USING btree ("slot");--> statement-breakpoint
COMMENT ON TABLE "ad_placements" IS 'Direct-sold, first-party-served display advertising (MONETISATION S5). Deliberately holds NO impression or click counter and no viewer attribute: a slot is selected by page context only, which is why no consent banner is needed. One visible placement per slot per period (ad_placements_one_visible_per_slot). Not on the open-data ALLOWED_RELATIONS.';--> statement-breakpoint
COMMENT ON COLUMN "ad_placements"."creative_path" IS 'Storage-adapter key (ads/yyyy/mm/<uuid>.webp), written by the admin upload through the EXIF-stripping webp pipeline and served by a row-decides route. Never interpolated from a URL.';--> statement-breakpoint
COMMENT ON COLUMN "ad_placements"."visible" IS 'Publication switch AND the exclusion constraint''s predicate: draft placements may overlap freely, two visible ones may not. Default false — a placement goes live as an act.';--> statement-breakpoint
ALTER TABLE "partners" DROP CONSTRAINT "partners_tier_known";--> statement-breakpoint
ALTER TABLE "partners" ADD CONSTRAINT "partners_tier_known" CHECK ("partners"."tier" IN ('headline', 'category', 'supporter', 'institutional', 'advertiser'));--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
