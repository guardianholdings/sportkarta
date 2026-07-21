-- Enable PostGIS and create the _health smoke-test table (Stage 0 DoD:
-- ST_DWithin must pass in every environment). EPSG:4326 + GIST per CLAUDE.md.
CREATE EXTENSION IF NOT EXISTS postgis;
--> statement-breakpoint
CREATE TABLE "_health" (
	"id" serial PRIMARY KEY,
	"label" text NOT NULL UNIQUE,
	"geom" geometry(Point, 4326) NOT NULL,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "_health_geom_gist" ON "_health" USING gist ("geom");
-- rollback: DROP TABLE "_health"; -- postgis extension stays (all future tables need it)
