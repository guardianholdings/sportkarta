# db/geo

Raw geospatial SQL lives here from Stage 1 onward (Drizzle handles relational
DDL; PostGIS specifics — `geometry(Point,4326)` columns, GIST indexes,
`ST_DWithin` queries — are written and reviewed as plain SQL).

Rules (CLAUDE.md): EPSG:4326 everywhere, GIST indexes mandatory,
migrations forward-only.
