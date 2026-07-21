// Intentionally empty: the real schema (facilities, municipalities, photos,
// edits, sources) lands in Stage 1 behind the operator-approved tag-mapping
// and dry-run import gates — docs/ROADMAP.md §3.
//
// Geospatial columns are raw SQL in db/geo: EPSG:4326, geometry(Point,4326),
// GIST indexes mandatory. Migrations are forward-only and reviewed.
export {};
