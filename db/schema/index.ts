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
  primaryKey,
  text,
  timestamp,
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
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('facility_edits_facility_created_idx').on(t.facilityId, t.createdAt),
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

// Lives here rather than in auth.ts because it references BOTH users and
// facilities; auth.ts cannot import facilities without an import cycle.
/** Contribution events that earn points (lib/src/points.ts prices them). */
export const pointsEvent = pgEnum('points_event', [
  'facility_added',
  'facility_verified',
  'condition_reported',
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
