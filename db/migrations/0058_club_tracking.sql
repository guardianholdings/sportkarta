-- 0058_club_tracking: «Клубове» v2, wave H2 (plan 2026-10-25, operator decision 3)
-- — a paid club's OWN Google Analytics 4 measurement id and Meta Pixel id,
-- loaded on that club's PUBLIC pages only, and only after the visitor accepts
-- (a consent banner on those pages; the rest of pops.bg stays tracker-free).
-- Hand-written; do not regenerate.
--
-- WHAT THIS ADDS
--
--   clubs.ga_measurement_id   'G-' and 4–12 upper-case letters or digits
--   clubs.meta_pixel_id       6–20 digits
--   clubs.privacy_url         the club's own privacy notice (https, ≤300
--                             characters, the shape of 0046's terms_url)
--
-- A club with an id set MUST have a privacy notice: the club is the
-- controller that informs the visitor (GDPR Art. 13), and the consent banner
-- links that notice, not POPS's. A CHECK, not just the settings form, so no
-- path can leave a pixel running with nothing to point the visitor to.
--
-- IDs ONLY, by construction. The CHECKs admit the shape of an id and nothing
-- else, so no club can store a script, a URL or a tag manager container
-- (Google Tag Manager is deliberately NOT offered: a GTM container runs
-- whatever code its owner publishes, on pops.bg's origin, where members are
-- signed in). The application builds the two vendors' script addresses
-- itself (lib/src/clubs/tracking.ts).
--
-- Who sets them is the application's: the club's own management
-- (settings.manage, never the NGO admin — adding a pixel makes the club a
-- joint controller with the vendor, a decision only the club takes), on a
-- tier that includes pixels, and only while the operator has switched
-- CLUB_PIXELS_ENABLED on. Rendering checks the same tier and switch, so a
-- lapsed tier or the switch off stops every pixel at once without touching
-- these columns.
--
-- Locking: ACCESS EXCLUSIVE on clubs for the three ADD COLUMNs and their
-- CHECKs (every column is nullable with no default — catalogue-only — and
-- the CHECKs scan a table that is empty or near it; on existing rows all
-- three columns are NULL, so every CHECK holds). Alone: one lock on
-- clubs, held for milliseconds. In a batch that includes 0045 or 0052 (the
-- first deploy of this branch applies 0045–0058 in one transaction), clubs is
-- already held in ACCESS EXCLUSIVE and nothing new is acquired.
--
-- rollback, in this order:
--   (a) switch CLUB_PIXELS_ENABLED off — every pixel stops at once, no SQL;
--   (b) revert the application and LEAVE the columns: nullable, read by
--       nothing in a reverted application (0045's and 0052's convention);
--   (c) only if they must go, after (b), in ONE transaction:
--   SET LOCAL lock_timeout = '3s';
--   SET LOCAL statement_timeout = '30s';
--   -- DESTRUCTIVE: every club's entered ids and notice link (re-entry needed)
--   ALTER TABLE "clubs" DROP COLUMN "ga_measurement_id", DROP COLUMN "meta_pixel_id",
--     DROP COLUMN "privacy_url";
--   Never drop before reverting: every full-row read of clubs would fail. The
--   0058 row stays in drizzle.__drizzle_migrations: a corrective migration
--   needs a journal `when` above 1785206400000, or the migrator skips it.
SET LOCAL lock_timeout = '3s';--> statement-breakpoint
SET LOCAL statement_timeout = '30s';--> statement-breakpoint
LOCK TABLE "clubs" IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "clubs"
  ADD COLUMN "ga_measurement_id" text,
  ADD COLUMN "meta_pixel_id" text,
  ADD COLUMN "privacy_url" text,
  ADD CONSTRAINT "clubs_ga_measurement_id_shape" CHECK ("clubs"."ga_measurement_id" IS NULL OR "clubs"."ga_measurement_id" ~ '^G-[A-Z0-9]{4,12}$'),
  ADD CONSTRAINT "clubs_meta_pixel_id_shape" CHECK ("clubs"."meta_pixel_id" IS NULL OR "clubs"."meta_pixel_id" ~ '^[0-9]{6,20}$'),
  ADD CONSTRAINT "clubs_privacy_url_sane" CHECK ("clubs"."privacy_url" IS NULL OR ("clubs"."privacy_url" ~ '^https://[^\s]+$' AND char_length("clubs"."privacy_url") <= 300)),
  ADD CONSTRAINT "clubs_tracking_needs_privacy_url" CHECK (("clubs"."ga_measurement_id" IS NULL AND "clubs"."meta_pixel_id" IS NULL) OR "clubs"."privacy_url" IS NOT NULL);--> statement-breakpoint
COMMENT ON COLUMN "clubs"."ga_measurement_id" IS 'The club''s own GA4 measurement id (0058): loaded on its public pages only, after the visitor accepts, while its tier has pixels and CLUB_PIXELS_ENABLED is on. An id, never a script or a tag manager container.';--> statement-breakpoint
COMMENT ON COLUMN "clubs"."meta_pixel_id" IS 'The club''s own Meta Pixel id (0058): loaded on its public pages only, after the visitor accepts, while its tier has pixels and CLUB_PIXELS_ENABLED is on. An id, never a script.';--> statement-breakpoint
COMMENT ON COLUMN "clubs"."privacy_url" IS 'The club''s own privacy notice (0058): linked from the consent banner on its public pages. Required while either tracking id is set.';--> statement-breakpoint
SET LOCAL lock_timeout = DEFAULT;--> statement-breakpoint
SET LOCAL statement_timeout = DEFAULT;
