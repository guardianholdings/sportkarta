-- 0002_facility_slugs: public URL slug for facilities (docs/ROADMAP.md Stage 2).
-- Nullable — every existing row's slug is NULL, so ADD COLUMN needs no rewrite
-- and the partial unique index / CHECK validate instantly (NULL branch passes).
-- Slugs are backfilled by db/scripts/backfill-slugs.ts and assigned at insert
-- time going forward; a later migration may enforce NOT NULL once fully backfilled.
--
-- rollback (compensating SQL, reverse order):
--   ALTER TABLE "facilities" DROP CONSTRAINT "facilities_slug_format";
--   DROP INDEX "facilities_slug_unique";
--   ALTER TABLE "facilities" DROP COLUMN "slug";
ALTER TABLE "facilities" ADD COLUMN "slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "facilities_slug_unique" ON "facilities" USING btree ("slug") WHERE "facilities"."slug" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "facilities" ADD CONSTRAINT "facilities_slug_format" CHECK ("facilities"."slug" IS NULL OR "facilities"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');