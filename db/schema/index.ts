import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './auth.js';

export * from './auth.js';

// PostGIS columns via customType so the emitted DDL is exactly
// geometry(...,4326). Driver-level values are WKB hex strings — all real
// geospatial reads/writes happen in raw SQL (db/geo, CLAUDE.md), never in JS.
const geomPoint4326 = customType<{ data: string }>({
  dataType: () => 'geometry(Point,4326)',
});
const geomMultiPolygon4326 = customType<{ data: string }>({
  dataType: () => 'geometry(MultiPolygon,4326)',
});
// Training routes (0027). A LineString rather than a point: the whole value of a
// route is its shape, and storing it as points would need a second table and an
// ordering column to say the same thing.
const geomLineString4326 = customType<{ data: string }>({
  dataType: () => 'geometry(LineString,4326)',
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
// Crowd condition layer (Stage 3.2). Slugs only — the Bulgarian labels
// (отлично / добро / лошо / неизползваемо) live in messages/*.json.
export const facilityCondition = pgEnum('facility_condition', [
  'excellent',
  'good',
  'poor',
  'unusable',
]);

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

/**
 * Operator switches (0018). One row per key; the only key so far is
 * 'public_show_paid' — the master toggle for the commercial (access='paid')
 * facility category. Text values; boolean-shaped keys are CHECK-pinned.
 */
export const appSettings = pgTable(
  'app_settings',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'app_settings_bool_keys',
      sql`${t.key} <> 'public_show_paid' OR ${t.value} IN ('true', 'false')`,
    ),
  ],
);

/**
 * The per-business visibility unit for commercial venues (0018): a chain with
 * thirty locations is ONE toggle. normalized_key (brand > operator > name,
 * lower/trimmed) is what re-imports attach by, so a business is never minted
 * twice. Institutional names only — nothing here resolves to a person, and
 * this table stays OFF the open-data ALLOWED_RELATIONS.
 */
export const businesses = pgTable(
  'businesses',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    name: text('name').notNull(),
    normalizedKey: text('normalized_key').notNull().unique(),
    visible: boolean('visible').notNull().default(true),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('businesses_name_not_blank', sql`btrim(${t.name}) <> ''`),
    check(
      'businesses_key_normalized',
      sql`${t.normalizedKey} = lower(btrim(${t.normalizedKey})) AND ${t.normalizedKey} <> ''`,
    ),
  ],
);

/**
 * Partners & sponsors registry (0019, docs/MONETISATION.md M1): the single
 * institutional-entity table every sponsorship surface reads — the /partnyori
 * page now, campaign sponsorship and adopt-a-facility later. Content is
 * bilingual COLUMNS (the campaigns title_bg/title_en pattern), never i18n
 * keys. DELIBERATE ABSENCES, per the plan: no contact-person columns (sponsor
 * contacts are natural persons; they live in the offline CRM under the NGO's
 * records of processing, never in the platform database), and this table
 * stays OFF the open-data ALLOWED_RELATIONS like `businesses`. A partner is
 * hidden (visible=false, the default), never deleted — future FKs will
 * RESTRICT on it. Rendering rule everywhere: visible AND window active.
 */
export const partners = pgTable(
  'partners',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    slug: text('slug').notNull().unique(),
    tier: text('tier').notNull(),
    nameBg: text('name_bg').notNull(),
    nameEn: text('name_en'),
    blurbBg: text('blurb_bg'),
    blurbEn: text('blurb_en'),
    url: text('url'),
    logoPath: text('logo_path'),
    visible: boolean('visible').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    startsOn: date('starts_on'),
    endsOn: date('ends_on'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'partners_slug_shape',
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${t.slug}) <= 60`,
    ),
    // 'advertiser' arrived with 0021 (ad slots): an advertiser lives in the
    // SAME registry as a sponsor — same creative pipeline, same acceptance
    // policy, same no-contact-columns rule — and only its tier differs. TEXT +
    // CHECK rather than an enum precisely so adding one is this single ALTER.
    check(
      'partners_tier_known',
      sql`${t.tier} IN ('headline', 'category', 'supporter', 'institutional', 'advertiser')`,
    ),
    check(
      'partners_name_sane',
      sql`btrim(${t.nameBg}) <> '' AND char_length(${t.nameBg}) <= 120 AND (${t.nameEn} IS NULL OR (btrim(${t.nameEn}) <> '' AND char_length(${t.nameEn}) <= 120))`,
    ),
    check(
      'partners_blurb_sane',
      sql`(${t.blurbBg} IS NULL OR (btrim(${t.blurbBg}) <> '' AND char_length(${t.blurbBg}) <= 2000)) AND (${t.blurbEn} IS NULL OR (btrim(${t.blurbEn}) <> '' AND char_length(${t.blurbEn}) <= 2000))`,
    ),
    check(
      'partners_url_shape',
      sql`${t.url} IS NULL OR (${t.url} ~ '^https?://[^[:space:]]+$' AND char_length(${t.url}) <= 300)`,
    ),
    check(
      'partners_logo_path_sane',
      sql`${t.logoPath} IS NULL OR (${t.logoPath} <> '' AND ${t.logoPath} !~ '^/' AND ${t.logoPath} !~ '(^|/)\\.\\.(/|$)')`,
    ),
    check(
      'partners_window_order',
      sql`${t.startsOn} IS NULL OR ${t.endsOn} IS NULL OR ${t.endsOn} >= ${t.startsOn}`,
    ),
  ],
);

/**
 * Direct-sold, first-party-served display advertising (docs/MONETISATION.md S5,
 * phase M4; migration 0021).
 *
 * WHAT MAKES THIS TABLE HARMLESS is the columns it does NOT have. There is no
 * impression counter, no click counter, no viewer attribute, and no third-party
 * script URL: a placement is a creative FILE we host, a link, and a window. The
 * slot is selected by PAGE CONTEXT only — never by anything about the person
 * reading — which is why the platform still needs no consent banner and the
 * privacy page's "не проследяваме потребителите" stays true.
 *
 * The advertiser is a `partners` row of tier 'advertiser', so the acceptance
 * policy, the logo/creative pipeline and the "no contact columns" rule are
 * inherited rather than restated.
 *
 * `slot` is TEXT + CHECK, not an enum, and the four values are a deliberate,
 * documented list (MONETISATION §S5). Adding a fifth surface means editing that
 * table in the plan AND this CHECK — two edits, on purpose, so a slot cannot be
 * added by a component import alone.
 *
 * Exclusivity ("one advertiser per slot per period") is an EXCLUDE constraint
 * in the migration, which drizzle cannot express — see 0021's header.
 */
export const adPlacements = pgTable(
  'ad_placements',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    partnerId: bigint('partner_id', { mode: 'number' })
      .notNull()
      .references(() => partners.id, { onDelete: 'restrict' }),
    slot: text('slot').notNull(),
    // Storage-adapter key, written by the admin upload through the same
    // EXIF-stripping webp pipeline as facility photos; served by a row-decides
    // route. Same shape CHECK as facility_photos / partners.logo_path.
    creativePath: text('creative_path').notNull(),
    url: text('url').notNull(),
    altBg: text('alt_bg').notNull(),
    altEn: text('alt_en'),
    // Always bounded, unlike a partner's optional window: an advertising slot
    // is sold for a period, and a placement with no end date is a placement
    // nobody remembers to take down.
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    visible: boolean('visible').notNull().default(false),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Every FK gets an index (reviewer rule) — this is the child side.
    index('ad_placements_partner_idx').on(t.partnerId),
    // The public read is "the placement for THIS slot, today", on page render.
    index('ad_placements_slot_idx').on(t.slot),
    check(
      'ad_placements_slot_known',
      sql`${t.slot} IN ('facility_page', 'city_page', 'weekly_page', 'map_panel')`,
    ),
    check(
      'ad_placements_creative_path_sane',
      sql`btrim(${t.creativePath}) <> '' AND ${t.creativePath} !~ '^/' AND ${t.creativePath} !~ '(^|/)\\.\\.(/|$)'`,
    ),
    check(
      'ad_placements_url_shape',
      sql`${t.url} ~ '^https?://[^[:space:]]+$' AND char_length(${t.url}) <= 300`,
    ),
    // alt text is not decoration: a creative with no alt is an image a screen
    // reader announces as nothing, and this one is a paid message.
    check(
      'ad_placements_alt_sane',
      sql`btrim(${t.altBg}) <> '' AND char_length(${t.altBg}) <= 200 AND (${t.altEn} IS NULL OR (btrim(${t.altEn}) <> '' AND char_length(${t.altEn}) <= 200))`,
    ),
    // Bounded means FINITE. `date 'infinity'` satisfies `ends_on >= starts_on`
    // and then reaches `daterange(..., '[]')`, whose inclusive upper bound
    // cannot be canonicalised — so without isfinite() the "always bounded"
    // claim in 0021's header is a promise the schema does not keep, and the
    // failure surfaces as a range error rather than a constraint violation.
    check(
      'ad_placements_window_order',
      sql`isfinite(${t.startsOn}) AND isfinite(${t.endsOn}) AND ${t.endsOn} >= ${t.startsOn}`,
    ),
  ],
);

/**
 * Adopt-a-facility («Осинови игрище») — docs/MONETISATION.md S3, phase M3a;
 * migration 0023.
 *
 * AN ADJACENT TABLE, NEVER A COLUMN ON `facilities`. That is the single most
 * important thing about this feature: sponsorship stays entirely outside the
 * merge policy, `facility_edits` provenance and the crowd-data protections, so a
 * sponsor acquires exactly zero authority over facility data or moderation. No
 * per-facility authority concept exists in this schema; adopting one must not
 * invent it.
 *
 * ALWAYS TIME-BOUNDED (both dates NOT NULL, unlike a partner's optional window):
 * an adoption is an annual arrangement and it must lapse visibly rather than
 * become a permanent claim on a public asset.
 *
 * One adoption per facility at a time — an EXCLUDE constraint in the migration,
 * which drizzle cannot express (see 0023's header).
 *
 * The plaque line (`label_bg`/`label_en`) is optional operator-authored content,
 * e.g. "Обновено през 2026 с подкрепата на …". It is bilingual COLUMNS, not i18n
 * keys, for the campaigns reason: admin content, not UI strings.
 */
export const facilitySponsorships = pgTable(
  'facility_sponsorships',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    partnerId: bigint('partner_id', { mode: 'number' })
      .notNull()
      .references(() => partners.id, { onDelete: 'restrict' }),
    labelBg: text('label_bg'),
    labelEn: text('label_en'),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Both FKs get an index (reviewer rule). The facility one is also the read
    // path: "is this facility adopted today", asked on every facility page.
    index('facility_sponsorships_facility_idx').on(t.facilityId),
    index('facility_sponsorships_partner_idx').on(t.partnerId),
    check(
      'facility_sponsorships_label_sane',
      sql`(${t.labelBg} IS NULL OR (btrim(${t.labelBg}) <> '' AND char_length(${t.labelBg}) <= 200))
          AND (${t.labelEn} IS NULL OR (btrim(${t.labelEn}) <> '' AND char_length(${t.labelEn}) <= 200))`,
    ),
    // Finite, for the reason 0021's window check states: an adoption over public
    // infrastructure that lapses "at infinity" is the standing claim the
    // bounded-window rule exists to prevent.
    check(
      'facility_sponsorships_window_order',
      sql`isfinite(${t.startsOn}) AND isfinite(${t.endsOn}) AND ${t.endsOn} >= ${t.startsOn}`,
    ),
  ],
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
    // Commercial venues only (access='paid'): the per-BUSINESS visibility unit
    // (0018). NULL = no recognisable operator; such a row rides the master
    // 'public_show_paid' switch alone.
    businessId: bigint('business_id', { mode: 'number' }).references(() => businesses.id, {
      onDelete: 'restrict',
    }),
    quarter: text('quarter'),
    source: facilitySource('source')
      .notNull()
      .references(() => sources.code, { onDelete: 'restrict' }),
    osmType: text('osm_type'),
    osmId: bigint('osm_id', { mode: 'number' }),
    // Latest crowd-reported condition, denormalised from
    // facility_condition_reports so the map and facility page never scan
    // history. NULL = nobody has reported yet (distinct from "excellent").
    condition: facilityCondition('condition'),
    conditionReportedAt: timestamptz('condition_reported_at'),
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
    // The condition and the time it was reported travel together or not at all.
    check(
      'facilities_condition_pair',
      sql`(${t.condition} IS NULL) = (${t.conditionReportedAt} IS NULL)`,
    ),
  ],
);

/**
 * One row per crowd condition report (Stage 3.2). The latest state is
 * denormalised onto facilities.condition; this table is the history behind it,
 * and what moderation looks at when a report is disputed.
 */
export const facilityConditionReports = pgTable(
  'facility_condition_reports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'cascade' }),
    // NULL after the reporter erases their account — the report itself stays
    // (it is public-interest data about a place), the person does not.
    reporterId: text('reporter_id').references(() => users.id, { onDelete: 'set null' }),
    state: facilityCondition('state').notNull(),
    // Closed vocabulary (lib/src/condition.ts). Free text is deliberately not
    // accepted here: it cannot be aggregated nationally and invites PII.
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    photoId: uuid('photo_id').references(() => facilityPhotos.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('facility_condition_reports_facility_created_idx').on(t.facilityId, t.createdAt),
    index('facility_condition_reports_reporter_idx')
      .on(t.reporterId)
      .where(sql`${t.reporterId} IS NOT NULL`),
    // Covers the photo FK so ON DELETE SET NULL never seq-scans this table.
    index('facility_condition_reports_photo_id_idx')
      .on(t.photoId)
      .where(sql`${t.photoId} IS NOT NULL`),
    // The closed vocabulary is enforced here, not just in the server action:
    // any other path (an admin tool, a future import, a bug) would otherwise be
    // able to persist free text into a public field — which is exactly the
    // free-text PII this column is designed to exclude. Adding a tag needs a
    // migration, the same policy the enums follow. The subset test also rules
    // out NULL and blank members; coalesce keeps the empty array valid.
    check(
      'facility_condition_reports_tags_sane',
      sql`${t.tags} <@ ARRAY['broken_equipment','damaged_surface','flooding','litter','missing_net','no_lighting','overgrown','vandalism']::text[]
          AND coalesce(array_length(${t.tags}, 1), 0) <= 6`,
    ),
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
    // Uploader, or NULL for anonymous/erased uploads. ON DELETE SET NULL is the
    // GDPR mechanism: erasing an account anonymises their photos in the same
    // statement, with no application code to forget to run.
    uploadedBy: text('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('facility_photos_facility_id_idx').on(t.facilityId),
    index('facility_photos_pending_created_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    // Covers the uploaded_by FK: without it, erasing an account seq-scans this
    // table twice (once to count, once for ON DELETE SET NULL) inside the
    // erasure transaction. Same reasoning as facility_reports_photo_id_idx.
    index('facility_photos_uploaded_by_idx')
      .on(t.uploadedBy)
      .where(sql`${t.uploadedBy} IS NOT NULL`),
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
    /**
     * Metres between the contributor and the place, when the claim was made
     * (0029). NULL = no position was offered, which is a DIFFERENT fact from a
     * large number and must stay distinguishable from it.
     *
     * Never a coordinate: the browser's latitude and longitude live for the one
     * statement that turns them into metres, exactly as
     * `playSessionCheckins.distanceM` does. Evidence, not proof — see
     * apps/web/lib/contributions/proximity.ts.
     */
    distanceM: integer('distance_m'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('facility_edits_facility_created_idx').on(t.facilityId, t.createdAt),
    // Backstop for the application-side clamp; an unclamped spoofed coordinate
    // would otherwise abort the transaction and destroy the contribution.
    check(
      'facility_edits_distance_sane',
      sql`${t.distanceM} IS NULL OR ${t.distanceM} BETWEEN 0 AND 1000000`,
    ),
    // GDPR erasure counts a person's audit rows by actor, and this table grows
    // without bound (every import writes one row per changed field). Indexing
    // it keeps a legally time-bound operation from getting slower every import.
    index('facility_edits_actor_idx')
      .on(t.actor)
      .where(sql`${t.actor} IS NOT NULL`),
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
    /** Metres between the reporter and the facility (0029). NULL = no position
     *  offered. Never a coordinate — see facilityEdits.distanceM. */
    distanceM: integer('distance_m'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'facility_reports_distance_sane',
      sql`${t.distanceM} IS NULL OR ${t.distanceM} BETWEEN 0 AND 1000000`,
    ),
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

// Lives here rather than in auth.ts because it references BOTH users and
// facilities; auth.ts cannot import facilities without an import cycle.
/** Contribution events that earn points (lib/src/points.ts prices them). */
export const pointsEvent = pgEnum('points_event', [
  'facility_added',
  'facility_verified',
  'condition_reported',
  // Stage 5.4. Written ONLY for a QR-verified check-in — see
  // play_session_checkins_only_qr_scores. The facility_id is the session's
  // facility, which is why this fits the existing NOT NULL column.
  'session_attended',
]);

/**
 * Append-only points ledger (docs/ROADMAP.md §5). Earning only — there are no
 * spending mechanics, so a balance is always `sum(points)`.
 *
 * `idempotency_key` is the whole safety story: it is UNIQUE, and every award is
 * an INSERT ... ON CONFLICT DO NOTHING, so a retried server action, a
 * double-submitted form or two concurrent tabs converge on exactly one row.
 *
 * Immutability is enforced by triggers in the migration: UPDATE and TRUNCATE
 * are always refused, and DELETE only when the owning account is already gone —
 * that is the GDPR cascade and nothing else. Points are personal data (a score
 * attached to a person), so unlike facility_edits they leave with the account;
 * the audit trail of facility changes is what must survive erasure, and does.
 */
export const pointsLedger = pgTable(
  'points_ledger',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    event: pointsEvent('event').notNull(),
    points: integer('points').notNull(),
    /**
     * The facility the contribution was about; audit rows live in
     * facility_edits. RESTRICT matches facility_edits: an award must never be
     * left pointing at nothing, and because this table is append-only an
     * orphan could never be repaired or removed. CASCADE would be actively
     * wrong here — it fires the BEFORE DELETE trigger while the owning account
     * still exists, so deleting any facility with awarded points would abort.
     */
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    idempotencyKey: text('idempotency_key')
      .notNull()
      .unique('points_ledger_idempotency_key_unique'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    // "My points" and "my recent contributions" — the only read patterns.
    index('points_ledger_user_created_idx').on(t.userId, t.createdAt),
    index('points_ledger_facility_idx').on(t.facilityId),
    // Bounded, not just positive: rows can never be edited or deleted, so a
    // pricing bug would otherwise write an unfixable number into a real
    // member's balance. 100 is far above any single award (max is 10).
    check('points_ledger_points_sane', sql`${t.points} BETWEEN 1 AND 100`),
    check('points_ledger_key_not_blank', sql`btrim(${t.idempotencyKey}) <> ''`),
  ],
);

export type PointsLedgerEntry = typeof pointsLedger.$inferSelect;
export type PointsEventValue = (typeof pointsEvent.enumValues)[number];

/**
 * Which municipalities an ambassador may moderate (Stage 3.3). One row per
 * municipality, so an ambassador can hold several — a person covering Varna and
 * Aksakovo is two rows, not a second account.
 *
 * This table IS the authorization boundary: every moderation statement joins
 * against it (apps/web/lib/moderation.ts), so an out-of-scope decision updates
 * zero rows even if an application check were bypassed.
 */
export const ambassadorMunicipalities = pgTable(
  'ambassador_municipalities',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    municipalityId: integer('municipality_id')
      .notNull()
      .references(() => municipalities.id, { onDelete: 'cascade' }),
    /** Admin who granted it; NULL once that admin erases their own account. */
    grantedBy: text('granted_by').references(() => users.id, { onDelete: 'set null' }),
    grantedAt: timestamptz('granted_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.municipalityId] }),
    // "Who covers this municipality?" — the reverse lookup the admin UI needs.
    index('ambassador_municipalities_municipality_idx').on(t.municipalityId),
    index('ambassador_municipalities_granted_by_idx')
      .on(t.grantedBy)
      .where(sql`${t.grantedBy} IS NOT NULL`),
  ],
);

export const moderationTarget = pgEnum('moderation_target', ['photo', 'report', 'facility']);
export const moderationDecision = pgEnum('moderation_decision', [
  'approved',
  'rejected',
  'reviewed',
  'dismissed',
  'verified',
  'gone',
]);

/**
 * Every moderation decision, append-only (Stage 3.3: "every decision logged").
 *
 * `actor_id` is an opaque users.id with NO foreign key, exactly like
 * facility_edits.actor: the record of who decided what must survive the
 * moderator erasing their own account, after which the UI shows the "former
 * user" label. `municipality_id` is stored as it was AT DECISION TIME, so a
 * later boundary fix or re-import cannot rewrite history — and so the SLA
 * report can group by scope without joining facilities.
 *
 * `queued_at` is copied from the item's own created_at, which makes
 * time-to-decision a subtraction on one row rather than a join.
 */
export const moderationDecisions = pgTable(
  'moderation_decisions',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    actorId: text('actor_id').notNull(),
    targetType: moderationTarget('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    /**
     * NULL when the facility had no municipality at the time.
     *
     * RESTRICT, not SET NULL: a SET NULL action is performed as an UPDATE on
     * this table, which the append-only trigger refuses — so deleting a
     * municipality would fail with a confusing error about a table nobody
     * touched. RESTRICT fails honestly instead, and it also protects the
     * invariant this column exists for: the scope recorded at decision time
     * must never be rewritten.
     */
    municipalityId: integer('municipality_id').references(() => municipalities.id, {
      onDelete: 'restrict',
    }),
    decision: moderationDecision('decision').notNull(),
    queuedAt: timestamptz('queued_at').notNull(),
    decidedAt: timestamptz('decided_at').notNull().defaultNow(),
  },
  (t) => [
    // Per-ambassador activity, and the SLA report's only scan.
    index('moderation_decisions_actor_decided_idx').on(t.actorId, t.decidedAt),
    index('moderation_decisions_decided_idx').on(t.decidedAt),
    // Ordered to match the SLA query: municipality filter AND a time window.
    index('moderation_decisions_municipality_decided_idx').on(t.municipalityId, t.decidedAt),
    index('moderation_decisions_target_idx').on(t.targetType, t.targetId),
    index('moderation_decisions_facility_idx').on(t.facilityId),
    check('moderation_decisions_actor_not_blank', sql`btrim(${t.actorId}) <> ''`),
    // A decision cannot predate the item it decided.
    check('moderation_decisions_order', sql`${t.decidedAt} >= ${t.queuedAt}`),
    // A decision must make sense for what it decided. The table is append-only,
    // so a nonsensical pairing could never be corrected afterwards.
    check(
      'moderation_decisions_decision_matches_target',
      sql`(${t.targetType} = 'photo' AND ${t.decision} IN ('approved', 'rejected'))
          OR (${t.targetType} = 'report' AND ${t.decision} IN ('reviewed', 'dismissed'))
          OR (${t.targetType} = 'facility' AND ${t.decision} IN ('verified', 'gone'))`,
    ),
    // A facility decision is about the facility itself.
    check(
      'moderation_decisions_facility_target',
      sql`${t.targetType} <> 'facility' OR ${t.targetId} = ${t.facilityId}`,
    ),
  ],
);

/**
 * Assistive pre-screen flags (docs/prompts/moderation-prescreen.md).
 *
 * Deliberately inert: there is no status, no decision and no link to one. A
 * flag is a note that says "look at this, here is why" — a human decides
 * everything. The unique constraint makes the weekly re-run idempotent instead
 * of piling duplicates onto the same item.
 */
export const moderationFlags = pgTable(
  'moderation_flags',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    targetType: moderationTarget('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
    /** Machine-readable reason slug; the UI label comes from i18n. */
    reason: text('reason').notNull(),
    /** One line of human-readable justification shown next to the queue item. */
    note: text('note'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    // Covers both the queue's flag lookup and the flag writer's ON CONFLICT; a
    // separate (target_type, target_id) index would be a strict prefix of this
    // one and pure write amplification.
    uniqueIndex('moderation_flags_target_reason_unique').on(t.targetType, t.targetId, t.reason),
    check('moderation_flags_reason_format', sql`${t.reason} ~ '^[a-z][a-z0-9_]{2,39}$'`),
    check('moderation_flags_note_len', sql`${t.note} IS NULL OR char_length(${t.note}) <= 300`),
  ],
);

/* ------------------------------------------------------------------------ *
 * Play layer — pickup sessions (docs/ROADMAP.md §6, Stage 4.1)
 *
 * These live here for the same reason points_ledger does: they reference BOTH
 * users and facilities, and a separate module importing this one while this one
 * re-exports it is an import cycle that would bite at table-construction time.
 *
 * NAMING: `sessions` is already better-auth's table (schema/auth.ts), so every
 * table below is prefixed `play_session*`. The Bulgarian product word is
 * "тренировка"; slugs stay English like every other identifier and the UI labels
 * come from i18n.
 *
 * THE TIME MODEL, which everything else follows from: a session is scheduled in
 * WALL CLOCK time. `starts_at_local` is a `timestamp` WITHOUT time zone — a
 * reading on a Sofia clock — and `rrule` is expanded against it in pure civil
 * arithmetic (lib/src/recurrence). Only the finished candidates become instants.
 * A weekly 18:00 session is 18:00 in January and 18:00 in July even though those
 * are different UTC instants, and no implementation that adds 7 × 86 400 000 ms
 * to an instant can produce that.
 * ------------------------------------------------------------------------ */

/**
 * A wall clock reading, kept as a STRING end to end. node-postgres parses
 * `timestamp without time zone` into a JS Date using the host's system
 * timezone — on a CI box in UTC and a laptop in Sofia that is two different
 * instants for the same row. mode:'string' means no conversion ever happens
 * where it is not written down.
 */
const wallClock = (name: string) => timestamp(name, { withTimezone: false, mode: 'string' });

/** Series and occurrence lifecycle. Completion is derivable from the clock. */
export const playSessionStatus = pgEnum('play_session_status', ['scheduled', 'cancelled']);
export const playSessionSkill = pgEnum('play_session_skill', [
  'any',
  'beginner',
  'intermediate',
  'advanced',
]);
/** `unlisted` = reachable by link, absent from listings and sitemaps. */
export const playSessionVisibility = pgEnum('play_session_visibility', ['public', 'unlisted']);
export const playSessionRsvpState = pgEnum('play_session_rsvp_state', ['active', 'withdrawn']);
/** Whether one occurrence was called off, or the whole series was. */
export const playSessionCancelScope = pgEnum('play_session_cancel_scope', ['occurrence', 'series']);
/** `qr` is Stage 4.3's signed expiring token; the vocabulary is reserved now. */
export const playSessionCheckinMethod = pgEnum('play_session_checkin_method', [
  'self',
  'organizer',
  'qr',
]);
/**
 * How the wall clock resolved to an instant (lib/src/recurrence/zoned.ts).
 * Recorded per occurrence rather than left invisible: when someone asks why
 * their 03:30 session on the last Sunday of March happened at 04:30, the row
 * itself answers.
 */
export const playSessionDstResolution = pgEnum('play_session_dst_resolution', [
  'exact',
  'gap_shifted',
  'fold_first',
]);

/**
 * The arrival-ticket sequence behind waitlist ordering. A dedicated SEQUENCE
 * rather than the identity primary key because re-joining after withdrawing
 * must take a FRESH ticket and go to the back of the queue — an identity column
 * is GENERATED ALWAYS and cannot be re-drawn.
 */
export const playSessionRsvpSeq = pgSequence('play_session_rsvp_seq');

/** The series. One row per "every Tuesday at 18:00", not per Tuesday. */
export const playSessions = pgTable(
  'play_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    facilityId: uuid('facility_id')
      .notNull()
      .references(() => facilities.id, { onDelete: 'restrict' }),
    /**
     * One sport per session — "what is being played", not the facility's list.
     * The closed vocabulary is CANONICAL_SPORTS (lib/src/sports.ts), validated
     * in the application exactly as facilities.sport_types is: adding a sport
     * must not require a migration. The CHECK here is format only.
     */
    sport: text('sport').notNull(),
    /**
     * NULL only once the organiser erases their account, which the triggers in
     * the migration turn into a cancelled series — a live session always has
     * someone answerable for it (see the CHECK below).
     */
    organizerId: text('organizer_id').references(() => users.id, { onDelete: 'set null' }),
    title: text('title').notNull(),
    description: text('description'),
    /** DTSTART as a wall clock reading. See the time model above. */
    startsAtLocal: wallClock('starts_at_local').notNull(),
    /**
     * Pinned to Europe/Sofia by a CHECK for now. The column exists so the
     * wall-clock semantics are explicit instead of implied; going multi-timezone
     * is then a CHECK edit rather than a data migration.
     */
    timezone: text('timezone').notNull().default('Europe/Sofia'),
    /**
     * NULL = a one-off session. The accepted grammar is a deliberate subset of
     * RFC 5545 (lib/src/recurrence/rrule.ts) and the CHECKs below are that
     * subset written out in SQL, so no other writer — an admin tool, a future
     * import, a bug — can store a rule the engine cannot expand.
     */
    rrule: text('rrule'),
    durationMinutes: integer('duration_minutes').notNull(),
    /** NULL = unlimited. Effective capacity for every occurrence of the series. */
    capacity: integer('capacity'),
    skillLevel: playSessionSkill('skill_level').notNull().default('any'),
    visibility: playSessionVisibility('visibility').notNull().default('public'),
    status: playSessionStatus('status').notNull().default('scheduled'),
    /** How far the materializer has expanded this series; NULL = never / redo. */
    materializedThrough: timestamptz('materialized_through'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('play_sessions_facility_status_idx').on(t.facilityId, t.status),
    // The materializer's only scan: scheduled series, oldest horizon first.
    // NULLS FIRST because NULL means "never materialized, do this one first",
    // and a default ASC btree stores NULLs last — the index would then be
    // unusable for the ordering the job actually asks for.
    index('play_sessions_materialize_idx')
      .on(sql`${t.materializedThrough} NULLS FIRST`)
      .where(sql`${t.status} = 'scheduled'`),
    index('play_sessions_organizer_idx')
      .on(t.organizerId)
      .where(sql`${t.organizerId} IS NOT NULL`),
    // A live series always has an organiser. The triggers in the migration keep
    // this true when the foreign key nulls the column out from under us.
    check(
      'play_sessions_live_has_organizer',
      sql`${t.status} = 'cancelled' OR ${t.organizerId} IS NOT NULL`,
    ),
    check('play_sessions_title_not_blank', sql`btrim(${t.title}) <> ''`),
    check('play_sessions_title_len', sql`char_length(${t.title}) <= 120`),
    check(
      'play_sessions_description_sane',
      sql`${t.description} IS NULL OR (btrim(${t.description}) <> '' AND char_length(${t.description}) <= 2000)`,
    ),
    check('play_sessions_sport_format', sql`${t.sport} ~ '^[a-z][a-z0-9_]{1,29}$'`),
    check('play_sessions_timezone_supported', sql`${t.timezone} = 'Europe/Sofia'`),
    // 15 minutes to 8 hours. Bounded above so a typo cannot create a session
    // that swallows a week of the calendar.
    check('play_sessions_duration_sane', sql`${t.durationMinutes} BETWEEN 15 AND 480`),
    check(
      'play_sessions_capacity_sane',
      sql`${t.capacity} IS NULL OR ${t.capacity} BETWEEN 1 AND 500`,
    ),
    // The supported RRULE subset, in SQL. Parts may appear in any order, which
    // is why this is a whole-string match against a permutation-tolerant
    // pattern plus the cross-part rules below it.
    check(
      'play_sessions_rrule_supported',
      sql`${t.rrule} IS NULL OR ${t.rrule} ~ '^FREQ=(DAILY|WEEKLY)(;(INTERVAL=[1-9][0-9]{0,2}|COUNT=[1-9][0-9]{0,2}|UNTIL=[0-9]{4}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3])[0-5][0-9][0-5][0-9]Z|BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU))*|WKST=MO))*$'`,
    ),
    check(
      'play_sessions_rrule_count_xor_until',
      sql`${t.rrule} IS NULL OR NOT (${t.rrule} LIKE '%COUNT=%' AND ${t.rrule} LIKE '%UNTIL=%')`,
    ),
    check(
      'play_sessions_rrule_byday_weekly_only',
      sql`${t.rrule} IS NULL OR ${t.rrule} NOT LIKE '%BYDAY=%' OR ${t.rrule} LIKE 'FREQ=WEEKLY%'`,
    ),
    // No part may repeat: the engine rejects duplicates, and a row the engine
    // cannot expand would silently stop materializing.
    check(
      'play_sessions_rrule_no_repeats',
      sql`${t.rrule} IS NULL OR (
            (char_length(${t.rrule}) - char_length(replace(${t.rrule}, 'INTERVAL=', ''))) <= 9
        AND (char_length(${t.rrule}) - char_length(replace(${t.rrule}, 'BYDAY=', ''))) <= 6
        AND (char_length(${t.rrule}) - char_length(replace(${t.rrule}, 'WKST=', ''))) <= 5
        AND (char_length(${t.rrule}) - char_length(replace(${t.rrule}, 'COUNT=', ''))) <= 6
        AND (char_length(${t.rrule}) - char_length(replace(${t.rrule}, 'UNTIL=', ''))) <= 6)`,
    ),
  ],
);

/**
 * Materialized instances of a series, written ONLY by the pg-boss job
 * `session.materialize` (db/src/sessions/materialize.ts) over a rolling 8-week
 * window.
 *
 * UNIQUE (session_id, starts_at) is what makes that job an
 * `INSERT … ON CONFLICT DO NOTHING` — the same idempotency argument as
 * points_ledger: re-running it, at any cadence, from any number of workers,
 * converges on exactly one row per occurrence. It is also why a cancelled
 * occurrence is never resurrected by the next run.
 */
export const playSessionOccurrences = pgTable(
  'play_session_occurrences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => playSessions.id, { onDelete: 'cascade' }),
    startsAt: timestamptz('starts_at').notNull(),
    /** starts_at + play_sessions.duration_minutes of ELAPSED time. */
    endsAt: timestamptz('ends_at').notNull(),
    /**
     * The wall clock `starts_at` reads as. Denormalised so listings and iCal
     * exports never recompute it — and verified against PostgreSQL's own tz
     * database by a trigger, which is what turns "Node's ICU and Postgres
     * disagree about Bulgarian time" from a silent scheduling bug into a failed
     * job in the logs.
     */
    startsAtLocal: wallClock('starts_at_local').notNull(),
    dstResolution: playSessionDstResolution('dst_resolution').notNull().default('exact'),
    status: playSessionStatus('status').notNull().default('scheduled'),
    cancelledAt: timestamptz('cancelled_at'),
    cancellationScope: playSessionCancelScope('cancellation_scope'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('play_session_occurrences_session_start_unique').on(t.sessionId, t.startsAt),
    // "What is on this week?" — the public listing's only scan.
    index('play_session_occurrences_upcoming_idx')
      .on(t.startsAt)
      .where(sql`${t.status} = 'scheduled'`),
    check('play_session_occurrences_ends_after_start', sql`${t.endsAt} > ${t.startsAt}`),
    // The three cancellation facts travel together or not at all.
    check(
      'play_session_occurrences_cancel_fields',
      sql`(${t.status} = 'cancelled') = (${t.cancelledAt} IS NOT NULL)
          AND (${t.status} = 'cancelled') = (${t.cancellationScope} IS NOT NULL)`,
    ),
  ],
);

/**
 * RSVPs, with the waitlist ORDER — and only the order — stored.
 *
 * There is deliberately no `going`/`waitlisted` column and no promotion logic.
 * Every RSVP draws an arrival ticket (`seq`); position is
 * `row_number() OVER (PARTITION BY occurrence_id ORDER BY seq)` across the
 * active rows, and someone is going when their position is within the series'
 * capacity. The view `play_session_rsvp_positions` (created in the migration)
 * is the one place that is written down.
 *
 * Two consequences are worth the design. Over-booking is impossible: there is
 * no counter to race on — everyone gets a ticket and the ordering decides — so
 * concurrent RSVPs cannot both take the last place. And a withdrawal promotes
 * the next person with no code running at all: nothing to forget, retry, or get
 * wrong at 22:00 the night before.
 *
 * An RSVP is personal data and leaves with the account (ON DELETE CASCADE),
 * unlike facility_edits — the audit trail of facility changes is what must
 * survive erasure, and does.
 */
export const playSessionRsvps = pgTable(
  'play_session_rsvps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurrenceId: uuid('occurrence_id')
      .notNull()
      .references(() => playSessionOccurrences.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Arrival ticket. Re-joining after withdrawing draws a fresh one. */
    seq: bigint('seq', { mode: 'number' })
      .notNull()
      .default(sql`nextval('play_session_rsvp_seq')`),
    state: playSessionRsvpState('state').notNull().default('active'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    withdrawnAt: timestamptz('withdrawn_at'),
  },
  (t) => [
    // One row per person per occurrence: re-joining updates the ticket rather
    // than stacking a second claim on the same seat.
    uniqueIndex('play_session_rsvps_occurrence_user_unique').on(t.occurrenceId, t.userId),
    // The exact ordering the position view scans — and UNIQUE, because the view
    // orders by `seq` and a tie would make two people swap places between query
    // plans: "going" on one page load and "waitlisted" on the next. `nextval`
    // never repeating is a property of the DEFAULT, not of the column; this
    // makes it a property of the column.
    uniqueIndex('play_session_rsvps_queue_idx')
      .on(t.occurrenceId, t.seq)
      .where(sql`${t.state} = 'active'`),
    // "My upcoming sessions", and the erasure count.
    index('play_session_rsvps_user_idx').on(t.userId),
    check(
      'play_session_rsvps_withdrawn_pair',
      sql`(${t.state} = 'withdrawn') = (${t.withdrawnAt} IS NOT NULL)`,
    ),
    check('play_session_rsvps_seq_positive', sql`${t.seq} > 0`),
  ],
);

/**
 * Attendance. One row per person per occurrence, so a double scan or a
 * double-tapped button is a no-op rather than two attendances.
 *
 * No points are awarded here: points_ledger is contribution-scoped (it requires
 * a facility_id and prices facility work), and attendance scoring is the Stage 5
 * passport. Wiring it here would put unfixable append-only rows behind a feature
 * that does not exist yet.
 */
export const playSessionCheckins = pgTable(
  'play_session_checkins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurrenceId: uuid('occurrence_id')
      .notNull()
      .references(() => playSessionOccurrences.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    method: playSessionCheckinMethod('method').notNull(),
    /** The organiser who marked it; NULL for self check-in. */
    recordedBy: text('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    /**
     * How far the member was from the facility when they checked in, in metres
     * — and DELIBERATELY NOT WHERE THEY WERE (Stage 5.4).
     *
     * The browser hands us a latitude and a longitude. We could store them.
     * Storing them would create a table of where named children stand on
     * Tuesday evenings, which is the single most sensitive record this project
     * could hold and is not needed for anything: the question is only "were
     * they at the pitch?", and a distance answers it. The coordinates exist for
     * the life of one SQL statement — ST_Distance against a facility whose
     * location we already publish — and are never written down.
     *
     * NULL means no location was offered. That is allowed: a member who
     * declines the permission prompt still gets checked in, they just do not
     * get points (see `scored`).
     */
    distanceM: integer('distance_m'),
    /**
     * Whether this attendance earned points (Stage 5.4). The points themselves
     * live in points_ledger, keyed per occurrence per member; this records the
     * OUTCOME so "why did I not get points for this?" is answerable from the
     * row, and so the rule below can be a constraint rather than a convention.
     */
    scored: boolean('scored').notNull().default(false),
    checkedInAt: timestamptz('checked_in_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('play_session_checkins_occurrence_user_unique').on(t.occurrenceId, t.userId),
    index('play_session_checkins_user_idx').on(t.userId),
    // Covers the recorded_by FK so erasing an organiser's account does not
    // seq-scan this table inside the erasure transaction.
    index('play_session_checkins_recorded_by_idx')
      .on(t.recordedBy)
      .where(sql`${t.recordedBy} IS NOT NULL`),
    // Self check-in is by definition not recorded by someone else.
    check(
      'play_session_checkins_self_has_no_recorder',
      sql`${t.method} <> 'self' OR ${t.recordedBy} IS NULL`,
    ),
    // Nor is a QR scan: the member redeemed a token themselves.
    check(
      'play_session_checkins_qr_has_no_recorder',
      sql`${t.method} <> 'qr' OR ${t.recordedBy} IS NULL`,
    ),
    /**
     * ONLY A QR-VERIFIED CHECK-IN MAY SCORE. Stage 5.2 promised that check-ins
     * would not be ranked while they were self-attested; this is that promise
     * as a constraint rather than as a line of application code somebody can
     * later "simplify". `self` means the member tapped a button, and `organizer`
     * means somebody vouched — both are worth recording and neither is worth
     * points, because neither is evidence.
     */
    check('play_session_checkins_only_qr_scores', sql`NOT ${t.scored} OR ${t.method} = 'qr'`),
    /**
     * A negative distance is meaningless and a 1 000 km one is a broken client.
     * THE WRITER CLAMPS to this bound rather than letting a wild reading raise
     * a constraint violation — a desktop browser falling back to an IP-derived
     * fix can be a continent away, and a CHECK must never be the thing that
     * decides whether an attendance is recorded (apps/web/lib/sessions/checkin.ts).
     */
    check(
      'play_session_checkins_distance_sane',
      sql`${t.distanceM} IS NULL OR ${t.distanceM} BETWEEN 0 AND 1000000`,
    ),
    /**
     * We only measure where somebody was standing when they redeemed a token.
     * A distance on a `self` or `organizer` row would mean we had located a
     * member for a check-in that could never score — collecting a position for
     * no purpose, which is the thing migration 0014's header argues against.
     * Structural, like only_qr_scores, rather than an application habit.
     */
    check(
      'play_session_checkins_distance_only_for_qr',
      sql`${t.distanceM} IS NULL OR ${t.method} = 'qr'`,
    ),
  ],
);

/**
 * Per-occurrence results (docs/ROADMAP.md §6, Stage 4.6 — "results v1").
 *
 * One row per participant or side. A pickup football game is two rows with a
 * team name, positions 1 and 2 and scores '3' and '1'; a 5 km run is one row
 * per runner with a position and a typed time. One table and one CSV shape
 * covers every sport in CANONICAL_SPORTS.
 *
 * NO TIMING HARDWARE (docs/ROADMAP.md §6, stated as a boundary rather than an
 * omission). There is no device id, no chip/gun/net time, and no import path
 * for a timing system. `score` is TEXT that an organiser typed — '3:1',
 * '12:34', '21-19, 19-21, 15-12'. A numeric column would fit football and not
 * tennis, and a duration column would invite exactly the integration this stage
 * has decided not to build.
 */

/**
 * What a member has already been told about an occurrence (Stage 4.2).
 *
 * The kinds are notification EVENTS, not states: `promoted` records that we
 * told somebody a spot opened, and says nothing about whether they are still
 * going. Attendance is derived from play_session_rsvp_positions and only from
 * there — one definition of "am I going?", exactly as Stage 4.1 arranged.
 */
export const playSessionNotificationKind = pgEnum('play_session_notification_kind', [
  'rsvp_confirmed',
  'rsvp_waitlisted',
  'promoted',
  'reminder_24h',
  'reminder_2h',
  'occurrence_cancelled',
]);

/**
 * The idempotency ledger for session mail (Stage 4.2), and the same argument as
 * digest_sends and points_ledger before it: THE UNIQUE INDEX IS THE GUARANTEE,
 * not application logic.
 *
 * WHY THE REMINDER JOB NEEDS THIS AND A TIME WINDOW WOULD NOT DO. The obvious
 * design is "every ten minutes, mail everyone whose session starts in 24h ± 5
 * minutes". That job mails nobody at all for any session whose window it slept
 * through — a deploy, a restart, a slow queue — and there is no evidence
 * afterwards that it happened. With this table the query becomes "starting
 * within 24 hours and not yet told", which is idempotent, self-healing after
 * downtime, and cannot double-send however often it runs.
 *
 * The row is written in the SAME TRANSACTION AS, AND BEFORE, the send. A crash
 * between the SMTP handoff and COMMIT re-sends — the honest trade and the right
 * way round, since send-then-record loses mail silently instead.
 *
 * TWO KEYS, BECAUSE THREE OF THE SIX KINDS ARE RE-ENTRANT. Migration 0008
 * supports withdrawing and re-joining, which draws a FRESH arrival ticket. A
 * flat UNIQUE (occurrence, member, kind) would therefore silently suppress the
 * second confirmation — and, far worse, the second `promoted` mail: somebody
 * who withdrew, re-joined the waitlist and was let in again would never be
 * told, would believe they were still queued, and would not turn up. So the
 * three RSVP-scoped kinds are keyed by the arrival ticket that caused them,
 * while the three facts-about-the-occurrence kinds (both reminders and the
 * cancellation) stay once-per-occurrence, with rsvp_seq NULL. The CHECK binds
 * the two halves so no writer can file a row under the wrong rule.
 *
 * It holds no subject, no body and no address: it records THAT a member was
 * told, not what was said. Everything here is the member's own data and leaves
 * with the account (CASCADE) — a "we emailed this person about this session"
 * row that outlived them would be a small, pointless archive of their evenings.
 */
export const playSessionNotifications = pgTable(
  'play_session_notifications',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    occurrenceId: uuid('occurrence_id')
      .notNull()
      .references(() => playSessionOccurrences.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: playSessionNotificationKind('kind').notNull(),
    /**
     * The play_session_rsvps arrival ticket this notification was about, for
     * the RSVP-scoped kinds; NULL for the ones that are facts about the
     * occurrence rather than about one sign-up. Deliberately NOT a foreign key:
     * the ledger must survive the RSVP row it describes, or withdrawing would
     * erase the evidence that we already wrote to somebody.
     */
    rsvpSeq: bigint('rsvp_seq', { mode: 'number' }),
    sentAt: timestamptz('sent_at').notNull().defaultNow(),
  },
  (t) => [
    // Facts about the occurrence: told once, whatever the member does after.
    uniqueIndex('play_session_notifications_once_unique')
      .on(t.occurrenceId, t.userId, t.kind)
      .where(sql`${t.rsvpSeq} IS NULL`),
    // Facts about one sign-up: told once per arrival ticket, so re-joining
    // after a withdrawal is confirmed again and can be promoted again.
    uniqueIndex('play_session_notifications_attempt_unique')
      .on(t.occurrenceId, t.userId, t.kind, t.rsvpSeq)
      .where(sql`${t.rsvpSeq} IS NOT NULL`),
    // Covers the user_id FK: erasure counts and cascades by user_id, and this
    // is the fastest-growing table in the schema. Without it, a legally
    // time-bound operation seq-scans it and gets slower every week. NOT for the
    // reminder anti-join, which the unique indexes above already satisfy.
    index('play_session_notifications_user_idx').on(t.userId),
    /**
     * Which key applies is decided by the kind, in the database. Both sides are
     * total (kind is NOT NULL, `IS NOT NULL` is never NULL), so this equality
     * can never evaluate to NULL — the trap that made campaigns_rules_shaped in
     * 0012 need a CASE. Adding a seventh kind means editing this list, which is
     * the point: the author has to decide which rule it follows.
     */
    check(
      'play_session_notifications_seq_matches_kind',
      sql`(${t.kind} IN ('rsvp_confirmed', 'rsvp_waitlisted', 'promoted')) = (${t.rsvpSeq} IS NOT NULL)`,
    ),
  ],
);

/**
 * The private calendar subscription token (Stage 4.2).
 *
 * A calendar client cannot sign in. It fetches one URL, forever, unauthenticated
 * — so the URL IS the credential, and that shapes every decision here:
 *
 *  - One row per member, so revoking is an UPDATE that mints a new token and
 *    instantly kills every copy of the old URL. That is the only recovery
 *    available once a URL has leaked into a shared calendar or a browser
 *    history, so it must be one click and not a support request.
 *  - Random and long (the shape CHECK refuses anything under 22 base64url
 *    characters, ~128 bits), because this URL is guessable-until-proven-
 *    otherwise and sits in server logs at the other end.
 *  - NOT the account id, and not derived from it. The account id is the
 *    better-auth session subject; a feed URL containing it would put a live
 *    identifier into every calendar server that ever polls us.
 *
 * What the feed exposes is deliberately limited to the member's OWN sessions —
 * see db/src/sessions/calendar.ts. A leaked token reveals where one person
 * plays football, which is bad enough; it must not also become a directory.
 */
export const calendarTokens = pgTable(
  'calendar_tokens',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique('calendar_tokens_token_unique'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** Moves on every regeneration, so "when did I last revoke?" is answerable. */
    rotatedAt: timestamptz('rotated_at').notNull().defaultNow(),
  },
  (t) => [
    // Same shape rule as digest_subscriptions.unsubscribe_token, bounded at
    // both ends: a truncated or predictable generator fails closed at the
    // database rather than quietly issuing a four-character calendar URL, and
    // a runaway one cannot put a multi-kilobyte token into a URL.
    check('calendar_tokens_token_shape', sql`${t.token} ~ '^[A-Za-z0-9_-]{22,64}$'`),
    /**
     * "The token is not the account id", in SQL rather than in a comment.
     * better-auth ids satisfy the shape rule too, so without this a regression
     * setting `token = user_id` would pass — and hand a live session subject to
     * the logs of every third-party calendar server that polls the feed. The FK
     * is CASCADE, so there is no SET NULL update to re-evaluate this CHECK and
     * it cannot block an erasure (the 0009 trap does not apply here).
     */
    check('calendar_tokens_token_is_not_the_account_id', sql`${t.token} <> ${t.userId}`),
  ],
);

export const playSessionResults = pgTable(
  'play_session_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    occurrenceId: uuid('occurrence_id')
      .notNull()
      .references(() => playSessionOccurrences.id, { onDelete: 'cascade' }),
    /**
     * The member this result belongs to, or NULL for a guest and for anyone who
     * has since erased their account. SET NULL, not CASCADE: a result is a fact
     * about a game other people played in too, so it outlives the account and
     * renders under the "former user" label like every other anonymised row.
     */
    participantUserId: text('participant_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Display name for a non-member entry, or a side: 'Отбор А'. */
    participantLabel: text('participant_label'),
    team: text('team'),
    position: integer('position'),
    /** Free text on purpose — see the module note above. */
    score: text('score'),
    note: text('note'),
    recordedBy: text('recorded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    // Per occurrence, ordered by position, unranked last (btree ASC is NULLS
    // LAST) — the read pattern, served with no sort. Deliberately NOT unique:
    // ties are real results, and a later migration must not "fix" this into a
    // unique index.
    index('play_session_results_occurrence_idx').on(t.occurrenceId, t.position),
    index('play_session_results_participant_idx')
      .on(t.participantUserId)
      .where(sql`${t.participantUserId} IS NOT NULL`),
    index('play_session_results_recorded_by_idx')
      .on(t.recordedBy)
      .where(sql`${t.recordedBy} IS NOT NULL`),
    // One result per member per occurrence. Guests are not constrained: two
    // people can genuinely both be entered as 'гост'. NOTE for upserts: this is
    // a PARTIAL index, so ON CONFLICT must repeat the predicate
    // (`ON CONFLICT (occurrence_id, participant_user_id) WHERE
    // participant_user_id IS NOT NULL`) or inference fails.
    uniqueIndex('play_session_results_occurrence_member_unique')
      .on(t.occurrenceId, t.participantUserId)
      .where(sql`${t.participantUserId} IS NOT NULL`),
    /**
     * "A row identifies somebody" is enforced by a BEFORE INSERT TRIGGER, not by
     * a CHECK, and that is load-bearing.
     *
     * A CHECK here would be violated by the `ON DELETE SET NULL` this table's
     * own foreign key performs: a member result is normally
     * `participant_user_id = <id>, participant_label = NULL` (there is no reason
     * to type a label for somebody the app can already name), so erasing that
     * account would null the id, leave the label NULL, fail the CHECK, and abort
     * `DELETE FROM users` — permanently, with no retry that could ever succeed.
     * Erasure must never be blockable (CLAUDE.md), so the rule applies to
     * INSERT only, where the row is being authored.
     *
     * The anonymised row is not ambiguous: the trigger guarantees a guest always
     * has a label, so `participant_user_id IS NULL AND participant_label IS
     * NULL` means exactly "an erased member", which renders as the same "former
     * user" label the audit trail already uses.
     */
    // Content: a row that says nothing happened is not a result. Blank strings
    // are impossible (see the text CHECK), so a plain NULL test suffices.
    check(
      'play_session_results_has_content',
      sql`${t.position} IS NOT NULL OR ${t.score} IS NOT NULL OR ${t.note} IS NOT NULL`,
    ),
    check(
      'play_session_results_position_positive',
      sql`${t.position} IS NULL OR ${t.position} > 0`,
    ),
    // NULL or meaningful — never a blank string that renders as an empty cell.
    // Same idiom as facilities_name_not_blank; it also removes the "NULL or
    // empty?" ambiguity from the CSV import path.
    check(
      'play_session_results_text_sane',
      sql`(${t.participantLabel} IS NULL OR (btrim(${t.participantLabel}) <> '' AND char_length(${t.participantLabel}) <= 80))
          AND (${t.team} IS NULL OR (btrim(${t.team}) <> '' AND char_length(${t.team}) <= 80))
          AND (${t.score} IS NULL OR (btrim(${t.score}) <> '' AND char_length(${t.score}) <= 40))
          AND (${t.note} IS NULL OR (btrim(${t.note}) <> '' AND char_length(${t.note}) <= 300))`,
    ),
  ],
);

/**
 * Opt-in to the weekly city digest (docs/ROADMAP.md §6, Stage 4.4).
 *
 * Signed-in members only, so the address is already verified by OTP sign-in and
 * nobody can subscribe somebody else. The primary key makes a double-submitted
 * toggle a no-op rather than a duplicate.
 *
 * `unsubscribe_token` is what makes one-click unsubscribe work WITHOUT a
 * session: someone who has lost interest must not have to sign in to make the
 * mail stop. It is random and per-subscription, so it reveals nothing and
 * cancels exactly one city.
 */
export const digestSubscriptions = pgTable(
  'digest_subscriptions',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    municipalityId: integer('municipality_id')
      .notNull()
      .references(() => municipalities.id, { onDelete: 'cascade' }),
    unsubscribeToken: text('unsubscribe_token')
      .notNull()
      .unique('digest_subscriptions_unsubscribe_token_unique'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.municipalityId] }),
    // The job's scan: everyone subscribed to this city.
    index('digest_subscriptions_municipality_idx').on(t.municipalityId),
    // Shape, not just length: the token is a bearer credential that travels in
    // an email URL, so a truncated or predictable generator should fail closed
    // rather than store something guessable. (The blast radius is one
    // unsubscribe, which is why this is a shape check and not a hash.)
    check('digest_subscriptions_token_shape', sql`${t.unsubscribeToken} ~ '^[A-Za-z0-9_-]{22,}$'`),
  ],
);

/**
 * The digest idempotency ledger — the same argument as points_ledger, for the
 * same reason: a retried job, an overlapping schedule or a second worker must
 * not mail anyone twice.
 *
 * The insert happens in the SAME transaction as the send attempt and BEFORE it,
 * so the worst case is a crash that skips one week's mail, never one that sends
 * it twice. Deliberately holds no subject, no body and no address: it records
 * THAT a send happened, not what was in it.
 */
export const digestSends = pgTable(
  'digest_sends',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    municipalityId: integer('municipality_id')
      .notNull()
      .references(() => municipalities.id, { onDelete: 'cascade' }),
    /** The Sofia Monday the digest covered. A date, not an instant. */
    weekStart: date('week_start').notNull(),
    sentAt: timestamptz('sent_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('digest_sends_user_week_unique').on(t.userId, t.municipalityId, t.weekStart),
    index('digest_sends_week_idx').on(t.weekStart),
    index('digest_sends_municipality_idx').on(t.municipalityId),
    /**
     * The whole idempotency argument rests on both writers agreeing what "this
     * week" is, and a `date` is only unambiguous if it is written as one.
     * node-postgres serialises a JS Date using the PROCESS offset, so a Sofia
     * Monday 00:00 sent from a `TZ=UTC` worker arrives as the previous SUNDAY —
     * two rows for one logical week, both inserting, subscriber mailed twice.
     * This turns that entire class of slip into a loud insert failure, and
     * because the ledger row goes in before the send, a failure means no mail
     * rather than a duplicate. The job passes a 'YYYY-MM-DD' string.
     */
    check('digest_sends_week_start_is_monday', sql`EXTRACT(isodow FROM ${t.weekStart}) = 1`),
  ],
);

/**
 * Badge NOTIFICATION ledger (docs/ROADMAP.md §7, Stage 5.1) — emphatically not
 * the badge state itself.
 *
 * Badges are DERIVED by folding a member's event stream through the catalogue
 * in lib/src/badges. That is what makes "a new badge is config, not schema"
 * true: adding one touches no table, and it is awarded retroactively with the
 * real date it would have been earned. Nothing reads this table to decide
 * whether a badge is held.
 *
 * What it is for: knowing whether we have already TOLD the member. Without it,
 * "you earned a badge" would either fire on every page load or need a column
 * per badge. One row per (member, badge), inserted ON CONFLICT DO NOTHING the
 * first time the engine reports it earned.
 *
 * badge_slug is TEXT and there is no foreign key to a badges table, because
 * there is no badges table — the catalogue is a TypeScript array. An enum here
 * would make every new badge a migration, which is the exact coupling this
 * design exists to break. The cost, stated honestly: a slug renamed in config
 * orphans its row here, and the member is told about the "new" badge once more.
 * That is the cheapest failure mode available.
 */
export const userBadges = pgTable(
  'user_badges',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    badgeSlug: text('badge_slug').notNull(),
    /**
     * When the engine says it was earned — the instant of the event that
     * crossed the threshold, not when we noticed. Recomputed values may differ
     * from this row after a threshold change; the engine wins, always.
     */
    earnedAt: timestamptz('earned_at').notNull(),
    /** When we first observed it, i.e. when the member could have been told. */
    firstSeenAt: timestamptz('first_seen_at').notNull().defaultNow(),
    /** Set once the member has actually seen it; NULL means "still new". */
    seenAt: timestamptz('seen_at'),
  },
  (t) => [
    // The idempotency guarantee, in the database rather than in a check-then-
    // insert: two concurrent page loads both observing a new badge produce one
    // row, so nobody is congratulated twice.
    uniqueIndex('user_badges_user_slug_unique').on(t.userId, t.badgeSlug),
    // "What is new for this member" — the only read path.
    index('user_badges_user_unseen_idx')
      .on(t.userId)
      .where(sql`${t.seenAt} IS NULL`),
    // The ONLY bound on this column — no enum, no FK — so it constrains length
    // as well as alphabet, like moderation_flags.reason and play_sessions.sport.
    // Without a ceiling a slug-construction bug surfaces as "index row size
    // exceeds maximum" from the unique index above, not a clean violation.
    check('user_badges_slug_shape', sql`${t.badgeSlug} ~ '^[a-z][a-z0-9_]{2,39}$'`),
    // Ordering invariants the design already guarantees (the fold walks
    // history, so a badge cannot be observed before it was earned), stated so a
    // future writer that breaks them fails loudly instead of rendering a
    // year-3000 date on a public page.
    check('user_badges_earned_before_seen', sql`${t.earnedAt} <= ${t.firstSeenAt}`),
    check('user_badges_seen_order', sql`${t.seenAt} IS NULL OR ${t.seenAt} >= ${t.firstSeenAt}`),
  ],
);

export type UserBadge = typeof userBadges.$inferSelect;
export type NewUserBadge = typeof userBadges.$inferInsert;

export const campaignStatus = pgEnum('campaign_status', [
  'draft',
  'published',
  'closed',
  'cancelled',
]);
export const campaignScopeKind = pgEnum('campaign_scope_kind', ['national', 'city', 'quarter']);
export const campaignLeaderboardType = pgEnum('campaign_leaderboard_type', ['individual', 'city']);
export const campaignTemplate = pgEnum('campaign_template', ['standard', 'sprint', 'city_race']);

/**
 * Campaigns (docs/ROADMAP.md §7, Stage 5.3).
 *
 * A campaign is a ROW, not config — an admin creates one from a browser
 * without a deploy, which badges (5.1) never needed. What stays config is
 * `rules`: a JSONB document validated against the closed grammar in
 * lib/src/campaigns and compiled to one SQL aggregate in db/src/campaigns.ts.
 * So creating a campaign is a form; inventing a new KIND of scoring is a
 * grammar change with a deploy and a test. Do not turn `rules` into columns —
 * that makes every campaign idea a migration.
 *
 * The window is CIVIL: `date` columns, expanded to instants in Europe/Sofia at
 * query time, so "ends 31 August" means midnight Sofia and not whatever UTC
 * instant the server thinks. `ends_on` is inclusive as authored and exclusive
 * as compiled; the off-by-one there silently discards the busiest day of every
 * campaign.
 */
export const campaigns = pgTable(
  'campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Shareable URL segment. Latin kebab-case; it goes on printed flyers. */
    slug: text('slug').notNull().unique('campaigns_slug_unique'),
    status: campaignStatus('status').notNull().default('draft'),
    scopeKind: campaignScopeKind('scope_kind').notNull().default('national'),
    municipalityId: integer('municipality_id').references(() => municipalities.id, {
      onDelete: 'restrict',
    }),
    /** Free text matching facilities.quarter; only for scope_kind='quarter'. */
    quarter: text('quarter'),
    startsOn: date('starts_on').notNull(),
    /** INCLUSIVE. The compiler adds one civil day to get the exclusive bound. */
    endsOn: date('ends_on').notNull(),
    leaderboardType: campaignLeaderboardType('leaderboard_type').notNull().default('individual'),
    template: campaignTemplate('template').notNull().default('standard'),
    /** Validated scoring document. See lib/src/campaigns/rules.ts. */
    rules: jsonb('rules').notNull(),
    /**
     * Admin-authored CONTENT, not UI strings — which is why it lives in columns
     * and not in messages/*.json. bg is required and en is optional: the
     * product is Bulgarian-first and an untranslated campaign should still run,
     * falling back to bg rather than rendering a key.
     */
    titleBg: text('title_bg').notNull(),
    titleEn: text('title_en'),
    blurbBg: text('blurb_bg'),
    blurbEn: text('blurb_en'),
    prizeBg: text('prize_bg'),
    prizeEn: text('prize_en'),
    /**
     * The sponsor of this campaign (docs/MONETISATION.md S2, phase M2; migration
     * 0022). NULL for the overwhelming majority — an unsponsored campaign is the
     * normal case, so this is nullable rather than defaulted.
     *
     * A REFERENCE, NOT COPIED CONTENT. The sponsor's name, logo and link live in
     * `partners` and are read through it, so hiding a partner or letting their
     * window lapse removes the sponsor line from every campaign at once. RESTRICT
     * because a partner with a sponsored campaign must not vanish — a campaign
     * that was "supported by" somebody keeps saying so.
     *
     * What this column deliberately does NOT do: reach `campaign_results`, which
     * stores no display data at all (0012), and give a sponsor any influence over
     * scoring, which is the closed `rules` grammar.
     */
    partnerId: bigint('partner_id', { mode: 'number' }).references(() => partners.id, {
      onDelete: 'restrict',
    }),
    /** When an admin froze the standings. NULL until then; set with status='closed'. */
    closedAt: timestamptz('closed_at'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('campaigns_status_idx').on(t.status, t.startsOn),
    // Every FK gets an index, and this one is partial: almost every campaign is
    // unsponsored, so indexing the NULLs would be pure overhead. The query that
    // needs it is "does this partner have campaigns" before hiding them.
    index('campaigns_partner_idx')
      .on(t.partnerId)
      .where(sql`${t.partnerId} IS NOT NULL`),
    index('campaigns_municipality_idx')
      .on(t.municipalityId)
      .where(sql`${t.municipalityId} IS NOT NULL`),
    // Scope coherence in the database, not in a form: a quarter campaign
    // without a municipality would compile to a predicate that silently matches
    // every quarter of that name in the country.
    check(
      'campaigns_scope_coherent',
      sql`(${t.scopeKind} = 'national' AND ${t.municipalityId} IS NULL AND ${t.quarter} IS NULL)
          OR (${t.scopeKind} = 'city' AND ${t.municipalityId} IS NOT NULL AND ${t.quarter} IS NULL)
          OR (${t.scopeKind} = 'quarter' AND ${t.municipalityId} IS NOT NULL AND ${t.quarter} IS NOT NULL)`,
    ),
    check('campaigns_window_order', sql`${t.endsOn} >= ${t.startsOn}`),
    // With campaigns_window_order, this permits starts_on … starts_on + 365 —
    // a 366-day INCLUSIVE span, i.e. one leap year. Spelled out because "+ 366"
    // reads like "366 days allowed" and the two differ by the day that matters.
    check('campaigns_window_bounded', sql`${t.endsOn} < ${t.startsOn} + 366`),
    check(
      'campaigns_slug_shape',
      sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND char_length(${t.slug}) <= 60`,
    ),
    // Ceilings live on the column, as they do for users_display_name_len and
    // user_badges_slug_shape: a bug then fails as a clean violation instead of
    // storing megabytes that render on a public page.
    check(
      'campaigns_title_sane',
      sql`btrim(${t.titleBg}) <> '' AND char_length(${t.titleBg}) <= 120
          AND (${t.titleEn} IS NULL OR char_length(${t.titleEn}) <= 120)`,
    ),
    check(
      'campaigns_body_sane',
      sql`(${t.blurbBg} IS NULL OR char_length(${t.blurbBg}) <= 2000)
          AND (${t.blurbEn} IS NULL OR char_length(${t.blurbEn}) <= 2000)
          AND (${t.prizeBg} IS NULL OR char_length(${t.prizeBg}) <= 2000)
          AND (${t.prizeEn} IS NULL OR char_length(${t.prizeEn}) <= 2000)`,
    ),
    check(
      'campaigns_quarter_sane',
      sql`${t.quarter} IS NULL OR (btrim(${t.quarter}) <> '' AND char_length(${t.quarter}) <= 120)`,
    ),
    /**
     * The rules document must be an object with a non-empty events array.
     *
     * WRITTEN WITH `CASE`, NOT `AND`, AND THAT IS THE WHOLE POINT. `'{}'::jsonb
     * -> 'events'` is SQL NULL, and jsonb_typeof/jsonb_array_length are strict,
     * so `TRUE AND NULL AND NULL` is NULL — and a CHECK PASSES on NULL. The
     * obvious conjunction therefore accepts `{}` and `{"evnets": [...]}`, which
     * is exactly the unreadable campaign this constraint exists to prevent.
     * CASE also stops jsonb_array_length raising on `{"events": 5}`, and does
     * not rely on AND's evaluation order, which Postgres does not guarantee.
     *
     * The upper bound matters as much as the lower one: there are four event
     * kinds, so anything past a handful is a generator bug, not a campaign.
     */
    check(
      'campaigns_rules_shaped',
      sql`jsonb_typeof(${t.rules}) = 'object'
          AND CASE WHEN jsonb_typeof(${t.rules} -> 'events') = 'array'
                   THEN jsonb_array_length(${t.rules} -> 'events') BETWEEN 1 AND 10
                   ELSE false END`,
    ),
    // closed_at and status='closed' are one fact; letting them disagree would
    // make "is this frozen?" have two answers.
    check('campaigns_closed_pair', sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL)`),
  ],
);

/**
 * FROZEN final standings, written once when an admin closes a campaign.
 *
 * A results page that recomputes live changes after prizes are announced — a
 * late moderation reversal, an erasure, a corrected ledger row — and a winner
 * who changes after the fact is the worst failure this feature can have. So
 * closing snapshots rank and score here, and the results page reads THIS.
 *
 * WHAT IS NOT FROZEN IS THE IDENTITY. There is no display name column: the row
 * holds the opaque user id (ON DELETE SET NULL) and the numbers, and the name
 * is resolved at render time through leaderboard_eligible_members. So the FACT
 * (who placed where) survives, while the PERSONAL DATA does not outlive the
 * account or the consent — an erased member renders as the "former user" label
 * and one who has since gone private renders anonymously, both keeping their
 * rank. Freezing the name instead would be retaining personal data in a table
 * nothing can erase it from.
 */
export const campaignResults = pgTable(
  'campaign_results',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    campaignId: uuid('campaign_id')
      .notNull()
      .references(() => campaigns.id, { onDelete: 'cascade' }),
    /** NULL after erasure — the placing stays, the person does not. */
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Set for a city-type board; NULL for an individual one. */
    municipalityId: integer('municipality_id').references(() => municipalities.id, {
      onDelete: 'restrict',
    }),
    rank: integer('rank').notNull(),
    score: integer('score').notNull(),
    /** Contributing members behind an aggregate row; 1 for an individual one. */
    memberCount: integer('member_count').notNull().default(1),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    // (campaign_id, rank, id) rather than (campaign_id, rank): the results read
    // orders by rank then id, so including it lets the LIMIT stop inside the
    // index instead of sorting the tiebreak.
    index('campaign_results_campaign_rank_idx').on(t.campaignId, t.rank, t.id),
    index('campaign_results_user_idx')
      .on(t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
    // The municipality FK is RESTRICT, so every delete or key-update on
    // municipalities checks this table. Unindexed it would seq-scan under lock,
    // and every closed city campaign makes that worse — the same index every
    // other municipality FK in this schema carries.
    index('campaign_results_municipality_idx')
      .on(t.municipalityId)
      .where(sql`${t.municipalityId} IS NOT NULL`),
    /**
     * One frozen placing per subject per campaign.
     *
     * "Written once at close" is otherwise enforced only in application code,
     * which leaves a re-opened-then-re-closed campaign, or a direct INSERT,
     * free to stack a second set of standings on the first.
     *
     * BOTH ARE PARTIAL, DELIBERATELY. A plain UNIQUE with NULLS NOT DISTINCT
     * would abort DELETE FROM users the second time a member of the same
     * campaign is erased — two rows would collide on (campaign_id, NULL). That
     * is the 0009 trap arriving by a new route, and the WHERE clause is what
     * keeps erasure unblockable.
     */
    uniqueIndex('campaign_results_campaign_user_unique')
      .on(t.campaignId, t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
    uniqueIndex('campaign_results_campaign_municipality_unique')
      .on(t.campaignId, t.municipalityId)
      .where(sql`${t.municipalityId} IS NOT NULL`),
    check('campaign_results_rank_positive', sql`${t.rank} >= 1`),
    check('campaign_results_score_non_negative', sql`${t.score} >= 0`),
    check('campaign_results_member_count_positive', sql`${t.memberCount} >= 1`),
    /**
     * At most one subject per row: a member, or a municipality. A row with
     * both would be double-counted by any sum over the snapshot.
     *
     * BOTH-NULL IS DELIBERATELY ALLOWED, and this is the 0009 lesson applied:
     * `user_id` is ON DELETE SET NULL, which Postgres performs as an UPDATE
     * that re-validates every CHECK on the row. A constraint demanding "exactly
     * one" would therefore abort DELETE FROM users forever, with no retry that
     * could ever succeed. A both-NULL row is an erased member's placing — the
     * rank and score of somebody the system can no longer name — which is
     * exactly what should survive.
     *
     * THAT READING DEPENDS ON `municipality_id` STAYING RESTRICT. Relax it to
     * SET NULL and a city row that loses its municipality also becomes
     * both-NULL, passes this check, and renders as an anonymous former member
     * (frozenResults infers "there was a member here" from user_id being the
     * only nullable subject). If municipalities ever need to be deletable,
     * this constraint and that inference must change together.
     */
    check(
      'campaign_results_one_subject',
      sql`(${t.userId} IS NOT NULL AND ${t.municipalityId} IS NULL)
          OR (${t.userId} IS NULL AND ${t.municipalityId} IS NOT NULL)
          OR (${t.userId} IS NULL AND ${t.municipalityId} IS NULL)`,
    ),
  ],
);

/**
 * Free API keys for the documented open-data API (Stage 6.1, migration 0015).
 *
 * THE COLUMN CANNOT HOLD A TOKEN, and that is the point. `key_hash` is
 * CHECK-constrained to exactly 64 lowercase hex characters — a SHA-256 digest.
 * An issued key is 43 characters of base64url with `-` and `_` in it, so the
 * shape rule makes storing the plaintext a constraint violation rather than a
 * code review someone has to remember to do. "We only store the hash" is the
 * kind of claim that is true until the day somebody adds a debugging column.
 *
 * `prefix` is the `skbg_` marker plus six characters of the secret, stored
 * deliberately: a member with three keys needs to tell them apart to revoke the
 * right one, and six characters of a 256-bit secret is not a head start.
 *
 * ON DELETE CASCADE, not SET NULL. A key is a live credential, not an audit
 * record: erasure must revoke it, and an ownerless key that still authenticates
 * is the worst of both worlds. It is placed in apps/web/lib/account-deletion.ts
 * in the lock order 0012 and 0013 established — every FK on `users` that the
 * erasure path touches has to keep that order or a deploy overlapping a GDPR
 * erasure deadlocks, and `deadlock_timeout` fires before `lock_timeout`.
 *
 * THERE IS NO REQUEST LOG, here or anywhere in this feature. `last_used_at` is
 * rounded to the minute by the writer and is the only trace a request leaves.
 * An access log for an open-data API is a record of which municipality's data
 * an identified account keeps asking about — a far more sensitive table than
 * the one it would be protecting. Rate limiting is in-memory and per-process
 * (apps/web/lib/opendata/limits.ts), which is why it is allowed to forget.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Member-supplied name, so a person can tell their own keys apart. */
    label: text('label').notNull(),
    /** SHA-256 of the issued key. The key itself is shown once, then gone. */
    keyHash: text('key_hash').notNull(),
    prefix: text('prefix').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** Minute-rounded. NULL = never used. */
    lastUsedAt: timestamptz('last_used_at'),
    /** Set instead of deleting, so a revoked key can never be re-issued. */
    revokedAt: timestamptz('revoked_at'),
  },
  (t) => [
    // The lookup on every authenticated request: hash → key. Unique because two
    // rows with one hash would make "which key was this?" ambiguous, and the
    // birthday odds on SHA-256 say a collision here is a bug, not chance.
    uniqueIndex('api_keys_key_hash_unique').on(t.keyHash),
    index('api_keys_user_idx').on(t.userId),
    check('api_keys_hash_is_sha256_hex', sql`${t.keyHash} ~ '^[0-9a-f]{64}$'`),
    check('api_keys_prefix_shape', sql`${t.prefix} ~ '^skbg_[A-Za-z0-9_-]{6}$'`),
    check('api_keys_label_not_blank', sql`btrim(${t.label}) <> ''`),
    check('api_keys_label_len', sql`char_length(${t.label}) <= 60`),
    /**
     * The free-text column may not contain a key either — found in review, and
     * the reason the header's claim is about the TABLE rather than one column.
     * A label allows 60 characters and an issued key is 48, so somebody pasting
     * their key into the label box would have stored it in cleartext, seen it
     * rendered back on the keys page, and shipped it into every backup, while
     * the hash carried on authenticating it.
     */
    check('api_keys_label_no_key', sql`position('skbg_' in ${t.label}) = 0`),
  ],
);

/**
 * The index of published bulk dumps (Stage 6.1, migration 0015).
 *
 * THE TABLE IS THE INDEX; THE FILE IS THE ARTIFACT. The manifest endpoint reads
 * these rows rather than listing a directory, because a directory listing is
 * whatever happens to be on the volume — a half-written file during a dump, a
 * leftover from a version that was pruned, a name somebody typo'd. A row is
 * written only after its file is fully written and hashed.
 *
 * The consequence is stated rather than hidden: if the volume is wiped and the
 * database is not, a row can outlive its file. The download route 404s in that
 * case instead of serving a truncated file, and says so.
 *
 * `version` is a CIVIL Sofia date, not a timestamp: "the 23 July 2026 dump" is
 * what a citation in a report says, and a UTC timestamp would put the dump for
 * a Sofia morning under the previous day for four months of the year.
 *
 * `sha256` is what makes a dump CITABLE. A report that says "computed from the
 * 2026-07-23 extract" can be checked by anybody who still has the file, which
 * is the difference between an open dataset and a published number.
 */
export const opendataDumps = pgTable(
  'opendata_dumps',
  {
    /** Civil Sofia date, `YYYY-MM-DD`. */
    version: date('version').notNull(),
    /** Catalogue dataset id (lib/src/opendata/schema.ts). */
    dataset: text('dataset').notNull(),
    format: text('format').notNull(),
    storagePath: text('storage_path').notNull(),
    bytes: bigint('bytes', { mode: 'number' }).notNull(),
    rowCount: integer('row_count').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'opendata_dumps_pkey',
      columns: [t.version, t.dataset, t.format],
    }),
    /**
     * NO separate index on `version`: it already leads the primary key, so a
     * backward scan of the PK serves "newest versions first". A first draft
     * added one as `DESC NULLS LAST`, which matches neither `ORDER BY version`
     * nor `ORDER BY version DESC` — that is DESC NULLS FIRST, and the planner
     * compares the nulls flag — so it was a write cost that could not serve the
     * one query it existed for.
     *
     * `storage_path` IS unique: the premise of this table is "the row is the
     * index, the file is the artifact", and two rows claiming one path with
     * different checksums would let the retention pruner delete a file a live
     * row still advertises.
     */
    unique('opendata_dumps_storage_path_unique').on(t.storagePath),
    check('opendata_dumps_sha256_hex', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('opendata_dumps_bytes_positive', sql`${t.bytes} > 0`),
    check('opendata_dumps_row_count_non_negative', sql`${t.rowCount} >= 0`),
    check('opendata_dumps_format_known', sql`${t.format} IN ('geojson', 'csv', 'json')`),
    check('opendata_dumps_dataset_not_blank', sql`btrim(${t.dataset}) <> ''`),
  ],
);

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;
export type OpendataDump = typeof opendataDumps.$inferSelect;
export type NewOpendataDump = typeof opendataDumps.$inferInsert;

export type AdPlacement = typeof adPlacements.$inferSelect;
export type NewAdPlacement = typeof adPlacements.$inferInsert;
export type Partner = typeof partners.$inferSelect;
export type NewPartner = typeof partners.$inferInsert;

export type Campaign = typeof campaigns.$inferSelect;
export type NewCampaign = typeof campaigns.$inferInsert;
export type CampaignResult = typeof campaignResults.$inferSelect;
export type CampaignStatusValue = (typeof campaignStatus.enumValues)[number];
export type CampaignScopeKindValue = (typeof campaignScopeKind.enumValues)[number];

export type PlaySessionResult = typeof playSessionResults.$inferSelect;
export type NewPlaySessionResult = typeof playSessionResults.$inferInsert;
export type DigestSubscription = typeof digestSubscriptions.$inferSelect;
export type DigestSend = typeof digestSends.$inferSelect;

export type PlaySession = typeof playSessions.$inferSelect;
export type NewPlaySession = typeof playSessions.$inferInsert;
export type PlaySessionOccurrence = typeof playSessionOccurrences.$inferSelect;
export type PlaySessionRsvp = typeof playSessionRsvps.$inferSelect;
export type PlaySessionCheckin = typeof playSessionCheckins.$inferSelect;
export type PlaySessionStatusValue = (typeof playSessionStatus.enumValues)[number];
export type PlaySessionSkillValue = (typeof playSessionSkill.enumValues)[number];
export type PlaySessionVisibilityValue = (typeof playSessionVisibility.enumValues)[number];
export type PlaySessionCheckinMethodValue = (typeof playSessionCheckinMethod.enumValues)[number];

export type AmbassadorMunicipality = typeof ambassadorMunicipalities.$inferSelect;
export type ModerationDecisionRow = typeof moderationDecisions.$inferSelect;
export type ModerationFlag = typeof moderationFlags.$inferSelect;
export type ModerationTargetType = (typeof moderationTarget.enumValues)[number];
export type ModerationDecisionValue = (typeof moderationDecision.enumValues)[number];

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

/**
 * Weeks a member missed that do not break their streak («замразяване»,
 * ENGAGEMENT.md A4).
 *
 * NOT A BALANCE, AND DELIBERATELY SO. CLAUDE.md fixes the points economy as
 * earning-only with no spending mechanics, and a freeze the member holds and
 * spends would be exactly the mechanic that rule excludes. A row here is
 * forgiveness the SYSTEM applied on the member's behalf, capped per rolling
 * year — nothing is bought, held or consumed, and the copy must describe it as
 * applied rather than as something to use up.
 *
 * WEEKS ONLY, by CHECK rather than by convention. A day-streak freeze would be
 * the daily loss-pressure loop docs/ENGAGEMENT.md §3 rejects outright (Octalysis
 * Core Drive 8, with minors named as a protected group in the EU Digital
 * Fairness Act). Making the unit a constraint means a later caller cannot widen
 * the mechanic to days by passing a different string.
 *
 * The row is the whole state: `lib/src/badges/streaks.ts` stays pure and takes
 * the set of frozen keys as a fold parameter, so the DST suite still tests real
 * transitions with no database in sight.
 *
 * NO account_deletions COUNTER, following `calendar_tokens` — the schema's ONLY
 * uncounted user-scoped cascade, justified in apps/web/lib/account-deletion.ts
 * as "one credential row, not a record of anything the member did". The same
 * reading applies here: a freeze is system-applied, regenerable state. Note
 * `user_badges` DOES carry a counter (`badges_erased`, added by 0010) — do not
 * cite it as precedent for omitting one. The CASCADE below is the whole erasure
 * story either way.
 */
export const streakFreezes = pgTable(
  'streak_freezes',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Always 'week'. Pinned by a CHECK — see the header. */
    unit: text('unit').notNull().default('week'),
    /**
     * The Monday that starts the frozen week, as a civil Sofia date.
     *
     * A DATE, not a timestamp: this is a calendar position, and the one place
     * an instant becomes one is `bucketKeyFor`. Storing an instant would invite
     * a reader to re-derive the week in SQL with date_trunc, which agrees with
     * the TypeScript today only by coincidence.
     */
    bucketKey: date('bucket_key').notNull(),
    /** When the system applied it. Never shown as "spent". */
    appliedAt: timestamptz('applied_at').notNull().defaultNow(),
  },
  (t) => [
    // One freeze per member per period: the fold reads a SET, and a duplicate
    // would let a retry of the grant job quietly consume two of the year's cap.
    uniqueIndex('streak_freezes_user_unit_bucket_unique').on(t.userId, t.unit, t.bucketKey),
    // Weeks only — the mechanic cannot be widened to days by a caller.
    check('streak_freezes_week_only', sql`${t.unit} = 'week'`),
    // A week key is a Monday. Postgres' ISO dow: 1 = Monday.
    // `isfinite` FIRST: since PG14 `extract(isodow from 'infinity'::date)` is
    // NULL, and `NULL = 1` is NULL, which a CHECK ACCEPTS. Without this an
    // infinite key would sit here forever, match no key the fold looks up (so
    // the freeze silently does nothing) and still consume one of the year's
    // allowance. Same defect 0024 was written to close.
    check(
      'streak_freezes_bucket_is_monday',
      sql`isfinite(${t.bucketKey}) AND extract(isodow from ${t.bucketKey}) = 1`,
    ),
  ],
);

export type StreakFreeze = typeof streakFreezes.$inferSelect;
export type NewStreakFreeze = typeof streakFreezes.$inferInsert;

/**
 * One week's divisions — a tier, and a group within it (docs/ENGAGEMENT.md B2).
 *
 * WHAT IS AND IS NOT STORED. These two tables record MEMBERSHIP and nothing
 * else: who shared a group in which week, at which tier. No score, no rank, no
 * outcome. All three are recomputable — the score from `points_ledger` (which is
 * append-only, so a closed week's total is stable), the rank by ordering that
 * score, and the promote/hold/relegate outcome from the tier difference between
 * two consecutive weeks, because `zoneFor` already clamps at both ends of the
 * ladder so the difference and the zone agree exactly.
 *
 * That is the same discipline `campaign_results` follows for the opposite
 * reason. A campaign freezes a PLACING because closing is a one-time event whose
 * inputs keep moving; a division freezes nothing because its inputs do not. A
 * stored rank here would be a second source of truth for a number the ladder
 * recomputes on every render, and the two would eventually disagree.
 *
 * WHO MAY BE HERE is not decided by these tables. `db/src/divisions.ts` joins
 * `leaderboard_eligible_members` when it assigns AND again when it displays —
 * twice, because a member may publish their passport on Monday and unpublish it
 * on Wednesday, and the second join is what makes their name stop rendering
 * without disturbing anyone else's contiguous rank.
 */
export const divisionGroups = pgTable(
  'division_groups',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    /**
     * The Monday that starts the week, as a civil Sofia date — the same key
     * `bucketKeyFor(at, 'week')` produces for streaks and the weekly digest.
     *
     * A DATE, not a timestamp, for the reason `streak_freezes.bucket_key` gives:
     * storing an instant invites a reader to re-derive the week in SQL with
     * `date_trunc`, which agrees with the TypeScript only by coincidence and
     * disagrees on exactly the two evenings a year that matter.
     */
    weekStart: date('week_start').notNull(),
    /** 1 = the entry tier. See `DIVISION_TIERS` for the names. */
    tier: integer('tier').notNull(),
    /** Which group within the tier, 1-based. */
    ordinal: integer('ordinal').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    // The natural key. Also the read path: "this week's tier-3 groups".
    uniqueIndex('division_groups_week_tier_ordinal_unique').on(t.weekStart, t.tier, t.ordinal),
    // Referenceable target for division_members' composite FK — the constraint
    // that makes "one group per member per week" structural. A plain UNIQUE on
    // (id) is implied by the PK, but Postgres will not accept a PK as the
    // target of a two-column FK, so this pair must exist in its own right.
    unique('division_groups_id_week_unique').on(t.id, t.weekStart),
    // The ladder has five rungs and the numbers are meaningless outside it.
    // Bounded here rather than in the app because an out-of-range tier renders
    // as a missing i18n key on a public page.
    check('division_groups_tier_range', sql`${t.tier} BETWEEN 1 AND 5`),
    check('division_groups_ordinal_positive', sql`${t.ordinal} >= 1`),
    // A week key is a Monday. `isfinite` FIRST, for the reason spelled out on
    // streak_freezes: since PG14 `extract(isodow from 'infinity'::date)` is
    // NULL, and a CHECK ACCEPTS NULL.
    check(
      'division_groups_week_is_monday',
      sql`isfinite(${t.weekStart}) AND extract(isodow from ${t.weekStart}) = 1`,
    ),
  ],
);

/**
 * A member's place in one week's ladder.
 *
 * `week_start` is denormalised from the group ON PURPOSE, and the composite FK
 * below is why it is safe: "one group per member per week" is then a plain
 * UNIQUE `(user_id, week_start)`, enforced by Postgres, rather than a rule the
 * assignment job has to remember. Without the denormalised column the same
 * guarantee would need a trigger or an application check, and an application
 * check that runs inside a job with retries is not a guarantee.
 *
 * The FK pins the two together, so the denormalised value cannot drift: a row
 * may only name a `(group_id, week_start)` pair that exists on the group.
 *
 * ERASURE: ON DELETE CASCADE from `users`, and deliberately NO
 * `account_deletions` counter — following `streak_freezes` and `calendar_tokens`
 * rather than `user_badges`. A membership is system-assigned, regenerable
 * placement, not a record of anything the member did; the thing they did is
 * their `points_ledger` rows, which are counted already. Adding a counter is a
 * four-place change (the column, the CHECK enumerating every counter,
 * `DeletionSummary`, and the INSERT list) and would break the positional fixture
 * in apps/web/tests/account-deletion.test.ts.
 */
export const divisionMembers = pgTable(
  'division_members',
  {
    /**
     * No single-column `.references()` here on purpose: the composite FK below
     * already implies it (a `(group_id, week_start)` pair that exists means the
     * `group_id` does), and declaring both would maintain two RI trigger pairs
     * on every insert and walk two cascade passes on every group delete.
     */
    groupId: bigint('group_id', { mode: 'number' }).notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Always equal to the group's `week_start`; pinned by the composite FK. */
    weekStart: date('week_start').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    // ONE GROUP PER MEMBER PER WEEK, structurally. The assignment job is
    // idempotent by construction (planDivisions is deterministic), but "the job
    // is careful" is not a constraint, and a member listed in two groups would
    // appear twice on the ladder with two different ranks.
    uniqueIndex('division_members_user_week_unique').on(t.userId, t.weekStart),
    // THE LADDER'S OWN READ PATH. `weekStandings` filters `dm.week_start = $1`
    // and joins the group; without a leading `week_start` Postgres cannot infer
    // the group's week from the join and must scan every row this table has
    // ever held — and it holds one row per active member per week, forever,
    // with no pruning. That is a public page getting linearly slower every week
    // it runs. Adding it now is free because the table is empty; adding it later
    // cannot use CREATE INDEX CONCURRENTLY, because drizzle wraps a migration
    // run in one transaction and CONCURRENTLY is rejected inside one.
    index('division_members_week_group_idx').on(t.weekStart, t.groupId, t.userId),
    // Keeps the denormalised week honest. No separate isodow CHECK is needed
    // here: this column can only hold a value that already passed the group's.
    foreignKey({
      name: 'division_members_group_week_fk',
      columns: [t.groupId, t.weekStart],
      foreignColumns: [divisionGroups.id, divisionGroups.weekStart],
    }).onDelete('cascade'),
  ],
);

/** Where a training log came from. `manual` is a person typing; the rest are imports. */
export const trainingSource = pgEnum('training_source', [
  'manual',
  'strava',
  'garmin',
  'apple_health',
  'google_fit',
  'polar',
  'suunto',
  'other',
]);

/**
 * How far a training log can be trusted — the same tiering migration 0014 made
 * structural for check-ins, carried here so a future competition can require a
 * tier rather than trusting whoever wrote the query.
 *
 * TWO TIERS, NOT THREE. A `qr_verified` label was drafted and removed before
 * 0027 shipped: nothing could produce it — there is no source for the check-in
 * path and `evidenceFor` never returns it — so it would have been a permanent
 * enum value (Postgres has no DROP VALUE) that silently returned an empty board
 * to any prize surface asking for it. It comes back when something can actually
 * grant it, together with the source that does.
 */
export const trainingEvidence = pgEnum('training_evidence', ['self_reported', 'connected_app']);

/**
 * Personal training logs — somebody doing sport, whether or not anyone
 * organised it (operator request 2026-07-26).
 *
 * THE GAP THIS FILLS. Everything the product could previously say about a member
 * came from contributions to the map or attendance at an organised session.
 * Neither is participation: a member who runs four times a week and never edits
 * the map is invisible, and `/klasirane?sport=football` — which reads like "who
 * plays football" — actually ranks who EDITED football pitches.
 *
 * IT AWARDS NO POINTS, by operator decision of 2026-07-26. `points_ledger` is
 * contribution-scoped and was hardened against farming before anything ranked
 * it; a self-reported number cannot be given that standing without handing the
 * strongest incentive in the product to whoever will type the largest figure.
 * There is deliberately no FK from here to `points_ledger` and no new
 * `points_event` value — which also means `CAMPAIGN_EVENT_KINDS` (a SUBTRACTIVE
 * filter, blocker 19 of the engagement plan) is untouched and no campaign can
 * silently score zero.
 *
 * THIS TABLE IS THE HOT PATH and is deliberately narrow. Heart rate, calories
 * and GPS routes are real requirements (operator decision 2026-07-26) but live
 * in `training_metrics` and `training_routes`, one row each, keyed here. Three
 * consequences, all of them the point: every board, division and campaign reads
 * only this table and therefore cannot expose them; withdrawing consent deletes
 * those rows without destroying a member's training history; and the open-data
 * layer cannot reach them even by accident, because a column that is not on this
 * table cannot be declared on a dataset that reads it.
 */
export const trainingLogs = pgTable(
  'training_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * A slug from `CANONICAL_SPORTS`. Text rather than an enum, matching
     * `facilities.sport_types`: the vocabulary lives in lib/src/sports.ts and
     * grows, and a new sport must not require a migration. Validated by
     * `normalizeTraining` and pinned by a test.
     */
    sport: text('sport').notNull(),
    startedAt: timestamptz('started_at').notNull(),
    /**
     * The civil Sofia DAY, computed in TypeScript by `bucketKeyFor` and stored.
     *
     * Not derived in SQL, and this is the load-bearing reason:
     * `timezone('Europe/Sofia', started_at)` is STABLE rather than IMMUTABLE, so
     * Postgres will not index it, and every per-day board would degrade into a
     * sequential scan. It also guarantees a training day, a streak day and a
     * division week agree, because all three come from the same function.
     */
    sofiaDay: date('sofia_day').notNull(),
    durationS: integer('duration_s').notNull(),
    /** Null for sports where distance is meaningless — climbing, football, gym. */
    distanceM: integer('distance_m'),
    /** Terrain, not health data: elevation gain is a property of the route. */
    elevationM: integer('elevation_m'),
    /**
     * The mapped place, when there is one. SET NULL rather than RESTRICT: a
     * member's own history must not be what blocks an admin from removing a
     * facility that turned out not to exist, and `municipality_id` survives to
     * keep the row useful to a city board.
     */
    facilityId: uuid('facility_id').references(() => facilities.id, { onDelete: 'set null' }),
    municipalityId: integer('municipality_id').references(() => municipalities.id, {
      onDelete: 'set null',
    }),
    source: trainingSource('source').notNull().default('manual'),
    /** The provider's own id, for import dedupe. Null for a manual entry. */
    externalId: text('external_id'),
    evidence: trainingEvidence('evidence').notNull().default('self_reported'),
    note: text('note'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // Every streak or per-day fold over one member.
    index('training_logs_user_day_idx').on(t.userId, t.sofiaDay),
    // "My training", which sorts by INSTANT rather than by day: `(user_id,
    // sofia_day)` cannot answer `ORDER BY started_at DESC LIMIT 50`, so without
    // this Postgres fetches a member's entire history and sorts it on every
    // page load. Both indexes are needed; neither is redundant.
    index('training_logs_user_started_idx').on(t.userId, t.startedAt.desc()),
    // The participation board for ONE sport.
    index('training_logs_sport_day_idx').on(t.sport, t.sofiaDay),
    // The ALL-SPORTS board and the board's own filter menu, both of which filter
    // on the day alone. `(sport, sofia_day)` cannot serve a range with no
    // leading-column predicate, so without this the default view of a public
    // page sequential-scans the fastest-growing table in the schema, forever.
    index('training_logs_day_sport_idx').on(t.sofiaDay, t.sport),
    // City boards and "who participates where".
    index('training_logs_municipality_day_idx').on(t.municipalityId, t.sofiaDay),
    // `facilityParticipation` filters facility AND day; the day belongs in the
    // index or every candidate row is a heap fetch. Still a valid prefix for the
    // ON DELETE SET NULL cascade lookup from `facilities`.
    index('training_logs_facility_day_idx').on(t.facilityId, t.sofiaDay),
    /**
     * IMPORT IDEMPOTENCY, SCOPED TO THE MEMBER.
     *
     * `user_id` leads for a reason that is a data-corruption bug without it.
     * External ids are provider-local and frequently device-local — Apple Health
     * and Google Fit hand out per-device ordinals, so two members can genuinely
     * present the same `(source, external_id)`. Keyed on the pair alone, member
     * B's import would take the ON CONFLICT path against member A's row and
     * overwrite A's sport, time, duration and place while leaving `user_id` as
     * A: silent cross-account corruption of a training history that feeds public
     * boards. B would then be handed A's row id and their route and metrics
     * writes would match zero rows and vanish without an error.
     *
     * PARTIAL, because every manual row has a NULL external_id and NULLs do not
     * collide — but two syncs of the same activity must. Same discipline as
     * `points_ledger.idempotency_key`: without it, a member who reconnects their
     * watch doubles their entire history and every board they appear on.
     */
    uniqueIndex('training_logs_user_source_external_unique')
      .on(t.userId, t.source, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    check('training_logs_duration_sane', sql`${t.durationS} BETWEEN 60 AND 86400`),
    /**
     * `sport` is free text on a PUBLIC surface — `participationSports` returns
     * it raw as the board's own filter menu. It is text rather than an enum so
     * the vocabulary can grow without a migration, but "not an enum" is not a
     * reason to be unbounded: `note` is capped at 500 for exactly this reason.
     */
    check('training_logs_sport_shape', sql`${t.sport} ~ '^[a-z_]{2,40}$'`),
    check(
      'training_logs_distance_sane',
      sql`${t.distanceM} IS NULL OR ${t.distanceM} BETWEEN 0 AND 1000000`,
    ),
    check(
      'training_logs_elevation_sane',
      sql`${t.elevationM} IS NULL OR ${t.elevationM} BETWEEN 0 AND 30000`,
    ),
    check('training_logs_note_len', sql`${t.note} IS NULL OR char_length(${t.note}) <= 500`),
    /**
     * Both time columns bounded at BOTH ends, not merely finite.
     *
     * `'infinity'::timestamptz` is legal: such a row would pin itself to the top
     * of `ORDER BY started_at DESC` forever, and `-infinity` would win the
     * board's `min(started_at)` tie-break permanently. `sofia_day` needs an
     * upper bound for the same reason — every board window is `sofia_day >= X`
     * with no upper bound, so a far-future row sits inside every rolling window
     * for good. `normalizeTraining` bounds both in TypeScript; that is the
     * layer 0014 exists to say is not sufficient on its own.
     */
    check('training_logs_started_finite', sql`isfinite(${t.startedAt})`),
    check(
      'training_logs_day_sane',
      sql`isfinite(${t.sofiaDay}) AND ${t.sofiaDay} BETWEEN DATE '2020-01-01' AND DATE '2100-01-01'`,
    ),
    /**
     * THE EVIDENCE RULE, structural rather than advisory — the same shape
     * `play_session_checkins_only_qr_scores` gives check-ins.
     *
     * A manual entry is `self_reported` and can be nothing else; an import is
     * `connected_app` and can be nothing else. The first draft of this CHECK
     * said `evidence IN ('connected_app', 'qr_verified')` for a non-manual
     * source, which permitted precisely the thing the comment beside it claimed
     * to prevent: any importer could assert the top tier by passing a nicer
     * string, and a prize surface filtering on that tier would have been
     * filtering on an assertion. The tier is now pinned exactly.
     */
    check(
      'training_logs_evidence_matches_source',
      sql`(${t.source} = 'manual' AND ${t.evidence} = 'self_reported')
          OR (${t.source} <> 'manual' AND ${t.evidence} = 'connected_app')`,
    ),
    /** The dedupe key and the source must agree, or a re-sync cannot be idempotent. */
    check(
      'training_logs_external_id_matches_source',
      sql`(${t.source} = 'manual' AND ${t.externalId} IS NULL)
          OR (${t.source} <> 'manual' AND ${t.externalId} IS NOT NULL)`,
    ),
  ],
);

/**
 * GPS routes, imported from a connected app (operator decision 2026-07-26).
 *
 * A SEPARATE TABLE, AND THAT IS THE WHOLE DESIGN. A route is the most sensitive
 * thing this product has ever stored: a line that starts at somebody's home most
 * mornings is a home address plus a schedule. Keeping it out of `training_logs`
 * means the participation board, the divisions, the campaigns and the open-data
 * layer read a table that physically does not contain it — protection by
 * structure rather than by every future author remembering.
 *
 * WRITING HERE REQUIRES `users.training_route_consent_at` to be set. That is
 * enforced by the writer in db/src/training.ts and asserted by a test; it is not
 * a CHECK only because a CHECK cannot reach another table without a trigger, and
 * this schema's standing preference is an application rule with a test over a
 * trigger that fires inside an erasure cascade.
 *
 * WITHDRAWING CONSENT DELETES THESE ROWS and leaves the training history intact
 * — the member keeps their record of having trained, and the route is gone.
 *
 * NEVER PUBLIC. There is no public read path, no heatmap and no export; adding
 * one is a new operator decision, not a new query.
 */
export const trainingRoutes = pgTable(
  'training_routes',
  {
    trainingLogId: uuid('training_log_id')
      .primaryKey()
      .references(() => trainingLogs.id, { onDelete: 'cascade' }),
    /** EPSG:4326, like everything geospatial here. GIST index is mandatory. */
    geom: geomLineString4326('geom').notNull(),
    pointCount: integer('point_count').notNull(),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    /**
     * NO GIST INDEX, and that is deliberate rather than forgotten.
     *
     * Nothing issues a spatial predicate against this table: the only reads are
     * by primary key and the consent-withdrawal DELETE. A GIST index would
     * therefore be pure write amplification on every import — and it is
     * precisely the index that would make a public heatmap cheap, which is the
     * one feature this table's header says needs a new operator decision. Not
     * having it keeps the cost of that decision visible.
     */
    // `point_count` must describe the geometry rather than merely accompany it;
    // ST_NumPoints is IMMUTABLE, so the claim can be checked rather than trusted.
    check(
      'training_routes_point_count_matches',
      sql`${t.pointCount} BETWEEN 2 AND 100000 AND ST_NumPoints(${t.geom}) = ${t.pointCount}`,
    ),
    // The typmod pins the SRID but not the coordinate range: 4326 happily stores
    // a longitude of 5000.
    check(
      'training_routes_coords_sane',
      sql`ST_XMin(${t.geom}) >= -180 AND ST_XMax(${t.geom}) <= 180
          AND ST_YMin(${t.geom}) >= -90 AND ST_YMax(${t.geom}) <= 90`,
    ),
  ],
);

/**
 * Heart rate and calories from a connected app (operator decision 2026-07-26).
 *
 * SPECIAL-CATEGORY DATA. Heart rate and derived calorie burn are health data
 * under GDPR Art. 9, which needs a different lawful basis from everything else
 * in this schema: EXPLICIT consent, demonstrable, and withdrawable. That is why
 * it is a separate table gated on `users.training_health_consent_at` rather than
 * four more nullable columns on `training_logs` — those columns would travel
 * into every SELECT that ever touches a training, and the consent question would
 * have to be re-asked by every author forever.
 *
 * Elevation gain is deliberately NOT here: it describes the terrain, not the
 * body, so it sits on `training_logs` where boards can use it.
 *
 * NOTHING SCORES ON THIS. No board, division or campaign reads this table, and
 * effort-adjusted scoring would be a new operator decision — one that would also
 * make a prize depend on health data, which is a materially different promise.
 */
export const trainingMetrics = pgTable(
  'training_metrics',
  {
    trainingLogId: uuid('training_log_id')
      .primaryKey()
      .references(() => trainingLogs.id, { onDelete: 'cascade' }),
    avgHeartRate: integer('avg_heart_rate'),
    maxHeartRate: integer('max_heart_rate'),
    caloriesKcal: integer('calories_kcal'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'training_metrics_avg_hr_sane',
      sql`${t.avgHeartRate} IS NULL OR ${t.avgHeartRate} BETWEEN 20 AND 260`,
    ),
    check(
      'training_metrics_max_hr_sane',
      sql`${t.maxHeartRate} IS NULL OR ${t.maxHeartRate} BETWEEN 20 AND 260`,
    ),
    check(
      'training_metrics_calories_sane',
      sql`${t.caloriesKcal} IS NULL OR ${t.caloriesKcal} BETWEEN 0 AND 30000`,
    ),
    /**
     * An all-NULL row is not a metrics record, it is an Art. 9 processing record
     * that asserts health data was stored and contains none. It also makes
     * `has_metrics` true on the member's own screen, telling them something
     * about their data that is not so.
     */
    check(
      'training_metrics_not_empty',
      sql`num_nonnulls(${t.avgHeartRate}, ${t.maxHeartRate}, ${t.caloriesKcal}) > 0`,
    ),
    check(
      'training_metrics_max_ge_avg',
      sql`${t.maxHeartRate} IS NULL OR ${t.avgHeartRate} IS NULL
          OR ${t.maxHeartRate} >= ${t.avgHeartRate}`,
    ),
  ],
);

export type TrainingLog = typeof trainingLogs.$inferSelect;
export type NewTrainingLog = typeof trainingLogs.$inferInsert;
export type TrainingRoute = typeof trainingRoutes.$inferSelect;
export type TrainingMetric = typeof trainingMetrics.$inferSelect;
export type TrainingSourceValue = (typeof trainingSource.enumValues)[number];
export type TrainingEvidenceValue = (typeof trainingEvidence.enumValues)[number];

export type DivisionGroup = typeof divisionGroups.$inferSelect;
export type NewDivisionGroup = typeof divisionGroups.$inferInsert;
export type DivisionMember = typeof divisionMembers.$inferSelect;
export type NewDivisionMember = typeof divisionMembers.$inferInsert;

/**
 * Who read whose account, and when (0028).
 *
 * The accountability trail for the admin account-management module. See the
 * migration header for the full reasoning; the three properties that must not
 * be relaxed are:
 *
 *  - APPEND-ONLY, by trigger. A log an admin can edit is not a log.
 *  - NO FOREIGN KEYS. `actorId` and `subjectId` are `users.id` carried BY VALUE.
 *    A FK would let the subject's own erasure delete the evidence that their
 *    data was read while it existed — silently, under CASCADE. After erasure the
 *    id resolves to nothing, exactly like `moderationDecisions.actorId`.
 *  - NARROW. Four columns. No note, no query, no address, no IP, no user agent:
 *    an access log that accumulated those would become a second store of the
 *    personal data it exists to protect, and the one store nobody would think to
 *    include in an erasure. It records THAT a scope was opened, never what was
 *    in it.
 */
export const accountAccessScope = pgEnum('account_access_scope', [
  'overview',
  'training',
  'health',
  'export',
]);

export const accountAccessLog = pgTable(
  'account_access_log',
  {
    id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
    /** The admin who looked. No FK — survives their own erasure. */
    actorId: text('actor_id').notNull(),
    /** The person whose data was read. No FK — survives THEIR erasure, which is
     *  the point: erasing an account must not erase the record of access to it. */
    subjectId: text('subject_id').notNull(),
    scope: accountAccessScope('scope').notNull(),
    viewedAt: timestamptz('viewed_at').notNull().defaultNow(),
  },
  (t) => [
    // "who has read this person's data" — the member-facing question.
    index('account_access_log_subject_viewed_idx').on(t.subjectId, t.viewedAt.desc()),
    // "what has this admin been reading" — the supervision question.
    index('account_access_log_actor_viewed_idx').on(t.actorId, t.viewedAt.desc()),
    // "who opened a health panel, ever" — a scan small enough to answer without
    // naming an account first. Partial, because the other three scopes are
    // routine and would bloat an index whose only purpose is the exceptional
    // read. Declared here as well as in the migration: an index drizzle cannot
    // see is one it will try to CREATE again the day somebody adds it.
    index('account_access_log_health_idx')
      .on(t.viewedAt.desc())
      .where(sql`${t.scope} = 'health'`),
    check('account_access_log_actor_not_blank', sql`btrim(${t.actorId}) <> ''`),
    check('account_access_log_subject_not_blank', sql`btrim(${t.subjectId}) <> ''`),
    // Both indexes are `viewed_at DESC` and the table is append-only, so a
    // single 'infinity' row would head every "who read this person's data"
    // answer forever and could never be corrected. The default is now(), but
    // the column is insertable. Same bound 0027 introduced one migration ago.
    check('account_access_log_viewed_at_finite', sql`isfinite(${t.viewedAt})`),
  ],
);

export type AccountAccessLogRow = typeof accountAccessLog.$inferSelect;
export type NewAccountAccessLogRow = typeof accountAccessLog.$inferInsert;
export type AccountAccessScopeValue = (typeof accountAccessScope.enumValues)[number];
