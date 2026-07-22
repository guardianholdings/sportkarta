import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// PostGIS columns via customType so the emitted DDL is exactly
// geometry(...,4326). Driver-level values are WKB hex strings — all real
// geospatial reads/writes happen in raw SQL (db/geo, CLAUDE.md), never in JS.
const geomPoint4326 = customType<{ data: string }>({
  dataType: () => 'geometry(Point,4326)',
});
const geomMultiPolygon4326 = customType<{ data: string }>({
  dataType: () => 'geometry(MultiPolygon,4326)',
});

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

// Enum extension policy (no table locks): new values are added in a later
// migration via ALTER TYPE ... ADD VALUE; see db/migrations/0001 header.
export const facilityAccess = pgEnum('facility_access', ['free', 'paid', 'restricted', 'school']);
export const facilityStatus = pgEnum('facility_status', ['active', 'needs_verification', 'gone']);
export const facilitySource = pgEnum('facility_source', ['osm', 'municipal', 'crowd']);
export const photoStatus = pgEnum('photo_status', ['pending', 'approved', 'rejected']);
// Anonymous visitor problem-reports (Stage 2.2). Issue tags mirror the public
// form's structured options; UI labels come from i18n, never these slugs.
export const reportIssue = pgEnum('report_issue', [
  'broken_equipment',
  'no_lighting',
  'bad_surface',
  'does_not_exist',
  'other',
]);
export const reportStatus = pgEnum('report_status', ['pending', 'reviewed', 'dismissed']);

export const municipalities = pgTable(
  'municipalities',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    ekatteCode: text('ekatte_code').notNull().unique('municipalities_ekatte_code_unique'),
    nameBg: text('name_bg').notNull(),
    nameEn: text('name_en').notNull(),
    geom: geomMultiPolygon4326('geom').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('municipalities_geom_gist').using('gist', t.geom),
    check('municipalities_ekatte_code_not_blank', sql`btrim(${t.ekatteCode}) <> ''`),
    check('municipalities_name_bg_not_blank', sql`btrim(${t.nameBg}) <> ''`),
    check('municipalities_name_en_not_blank', sql`btrim(${t.nameEn}) <> ''`),
    check('municipalities_geom_valid', sql`ST_IsValid(${t.geom})`),
  ],
);

export const sources = pgTable(
  'sources',
  {
    code: facilitySource('code').primaryKey(),
    name: text('name').notNull(),
    url: text('url'),
    license: text('license'),
    attribution: text('attribution'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [check('sources_name_not_blank', sql`btrim(${t.name}) <> ''`)],
);

export const facilities = pgTable(
  'facilities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    geom: geomPoint4326('geom').notNull(),
    name: text('name'),
    // Stable public URL slug (/obekt/[slug]); NULL until assigned. Official
    // Bulgarian transliteration, collision-suffixed (lib/src/slug.ts). Assigned
    // once at creation and never regenerated on rename, so links stay stable.
    slug: text('slug'),
    sportTypes: text('sport_types')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    surface: text('surface'),
    // NULL = unknown (tri-state; see COMMENT in migration 0001).
    lighting: boolean('lighting'),
    covered: boolean('covered').notNull().default(false),
    // No default: access and provenance must always be stated explicitly.
    access: facilityAccess('access').notNull(),
    status: facilityStatus('status').notNull().default('active'),
    municipalityId: integer('municipality_id').references(() => municipalities.id, {
      onDelete: 'restrict',
    }),
    quarter: text('quarter'),
    source: facilitySource('source')
      .notNull()
      .references(() => sources.code, { onDelete: 'restrict' }),
    osmType: text('osm_type'),
    osmId: bigint('osm_id', { mode: 'number' }),
    attrs: jsonb('attrs')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('facilities_geom_gist').using('gist', t.geom),
    uniqueIndex('facilities_osm_ref_unique')
      .on(t.osmType, t.osmId)
      .where(sql`${t.osmType} IS NOT NULL`),
    // Partial unique index: slugs are unique among assigned rows; NULLs are
    // exempt (many rows may be unslugged before backfill).
    uniqueIndex('facilities_slug_unique')
      .on(t.slug)
      .where(sql`${t.slug} IS NOT NULL`),
    index('facilities_municipality_id_idx').on(t.municipalityId),
    index('facilities_source_idx').on(t.source),
    index('facilities_sport_types_gin').using('gin', t.sportTypes),
    check('facilities_name_not_blank', sql`${t.name} IS NULL OR btrim(${t.name}) <> ''`),
    // Slug format mirrors lib/src/slug.ts output: lowercase alnum words joined
    // by single hyphens, no leading/trailing/double hyphens.
    check(
      'facilities_slug_format',
      sql`${t.slug} IS NULL OR ${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`,
    ),
    check('facilities_surface_not_blank', sql`${t.surface} IS NULL OR btrim(${t.surface}) <> ''`),
    check('facilities_quarter_not_blank', sql`${t.quarter} IS NULL OR btrim(${t.quarter}) <> ''`),
    check(
      'facilities_sport_types_no_blanks',
      sql`array_position(${t.sportTypes}, NULL) IS NULL AND array_position(${t.sportTypes}, '') IS NULL`,
    ),
    check(
      'facilities_geom_in_bulgaria',
      sql`ST_X(${t.geom}) BETWEEN 22.0 AND 29.0 AND ST_Y(${t.geom}) BETWEEN 41.0 AND 44.5`,
    ),
    check('facilities_osm_ref_pair', sql`(${t.osmType} IS NULL) = (${t.osmId} IS NULL)`),
    check(
      'facilities_osm_type_valid',
      sql`${t.osmType} IS NULL OR ${t.osmType} IN ('node', 'way', 'relation')`,
    ),
    check('facilities_osm_source_has_ref', sql`${t.source} <> 'osm' OR ${t.osmId} IS NOT NULL`),
    check('facilities_attrs_is_object', sql`jsonb_typeof(${t.attrs}) = 'object'`),
  ],
);

export const facilityPhotos = pgTable(
  'facility_photos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    // Storage-adapter key (lib/src/storage): relative forward-slash path.
    storagePath: text('storage_path').notNull().unique('facility_photos_storage_path_unique'),
    status: photoStatus('status').notNull().default('pending'),
    // better-auth user id from Stage 3; FK added when the users table exists.
    uploadedBy: text('uploaded_by'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('facility_photos_facility_id_idx').on(t.facilityId),
    index('facility_photos_pending_created_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    check(
      'facility_photos_storage_path_sane',
      sql`${t.storagePath} <> '' AND ${t.storagePath} !~ '^/' AND ${t.storagePath} !~ '(^|/)\\.\\.(/|$)'`,
    ),
  ],
);

// Append-only audit log; immutability enforced by triggers in migration 0001.
export const facilityEdits = pgTable(
  'facility_edits',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    actor: text('actor'),
    source: facilitySource('source').notNull(),
    field: text('field').notNull(),
    // A change TO null is recorded as 'null'::jsonb; SQL NULL = "no value side".
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('facility_edits_facility_created_idx').on(t.facilityId, t.createdAt),
    check('facility_edits_field_not_blank', sql`btrim(${t.field}) <> ''`),
    check('facility_edits_has_value', sql`${t.oldValue} IS NOT NULL OR ${t.newValue} IS NOT NULL`),
  ],
);

// Anonymous visitor problem-reports (Stage 2.2). No IP or other identifier is
// stored: the request IP is used transiently for rate-limiting only and never
// persisted here (see the privacy page). An optional photo goes through the
// storage adapter into facility_photos (status=pending) and is referenced here.
export const facilityReports = pgTable(
  'facility_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    issue: reportIssue('issue').notNull(),
    // Free-text detail, capped to 500 chars (also enforced client + server-side).
    body: text('body'),
    photoId: uuid('photo_id').references(() => facilityPhotos.id, { onDelete: 'set null' }),
    status: reportStatus('status').notNull().default('pending'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('facility_reports_pending_created_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    index('facility_reports_facility_id_idx').on(t.facilityId),
    // Covers the photo_id FK so ON DELETE SET NULL (photo reject/delete) never
    // seq-scans this unbounded anonymous-input table.
    index('facility_reports_photo_id_idx').on(t.photoId),
    check('facility_reports_body_len', sql`${t.body} IS NULL OR char_length(${t.body}) <= 500`),
    check('facility_reports_body_not_blank', sql`${t.body} IS NULL OR btrim(${t.body}) <> ''`),
  ],
);

// Municipality permanent population (NSI census), loaded from db/data/population.csv
// via db/scripts/load-population.ts. Feeds the "per 10k residents" metric on
// /statistika. Partial by design — municipalities absent here show "n/a" (the
// per-10k value is never estimated). See db/data/README.md for the source.
export const municipalityPopulation = pgTable(
  'municipality_population',
  {
    ekatteCode: text('ekatte_code')
      .primaryKey()
      .references(() => municipalities.ekatteCode, { onDelete: 'cascade' }),
    population: integer('population').notNull(),
    source: text('source').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('municipality_population_positive', sql`${t.population} > 0`),
    check('municipality_population_source_not_blank', sql`btrim(${t.source}) <> ''`),
  ],
);

export type Municipality = typeof municipalities.$inferSelect;
export type NewMunicipality = typeof municipalities.$inferInsert;
export type MunicipalityPopulation = typeof municipalityPopulation.$inferSelect;
export type Source = typeof sources.$inferSelect;
export type Facility = typeof facilities.$inferSelect;
export type NewFacility = typeof facilities.$inferInsert;
export type FacilityPhoto = typeof facilityPhotos.$inferSelect;
export type NewFacilityPhoto = typeof facilityPhotos.$inferInsert;
export type FacilityEdit = typeof facilityEdits.$inferSelect;
export type NewFacilityEdit = typeof facilityEdits.$inferInsert;
export type FacilityReport = typeof facilityReports.$inferSelect;
export type NewFacilityReport = typeof facilityReports.$inferInsert;
