import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSequence,
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
