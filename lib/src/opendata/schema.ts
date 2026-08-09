/**
 * The open-data export catalogue (docs/ROADMAP.md §8, Stage 6.1).
 *
 * AN EXPORT IS A DECLARED SCHEMA, NOT A QUERY. Everything downstream reads
 * this one file: the API serializers, the nightly dump writer, the `/danni`
 * documentation page, and the PII denylist test. Nothing else may decide what
 * leaves the building.
 *
 * That indirection is the whole point. "We tested the exports for personal
 * data" is worth nothing if the test names three endpoints somebody remembered
 * to add to it — the fourth endpoint, written in a hurry eighteen months from
 * now, is the one that leaks. Here a dataset does not exist until it is in this
 * catalogue, and the moment it is in the catalogue every guard sees it: the
 * denylist scans its fields, the docs page renders them, the dump job writes
 * them. There is no path from a column in the database to a file on the
 * internet that does not pass through this array.
 *
 * THE SELECT LIST IS BUILT FROM THE FIELDS, so `SELECT *` is unconstructible
 * (db/src/opendata/export.ts). A column cannot be exported without being named
 * here, documented here, and scanned here.
 *
 * NO jsonb, EVER — see FORBIDDEN_TYPES below. `facilities.attrs` is the reason:
 * it is an open bag of OSM tags, and OSM tags include `contact:phone`,
 * `contact:email` and `operator`. No schema check can see inside a jsonb
 * column, so the rule is not "review what's in attrs" but "a jsonb column is
 * not exportable". Anything worth publishing out of it gets promoted to a real
 * column with a real type first.
 *
 * Pure and dependency-free: this file is imported by the browser bundle (the
 * docs page), the worker (the dump job) and three test suites.
 */

import { CONDITION_STATES } from '../condition.js';
import { CANONICAL_SPORTS, CANONICAL_SURFACES } from '../sports.js';

/**
 * The licence the published database carries, and the attribution string every
 * consumer owes. One constant, because it appears in five places — the licence
 * page, an HTTP header on every API response, a member of every GeoJSON body, a
 * comment row at the top of every CSV, and the dump manifest — and five copies
 * of an attribution string is four opportunities to publish a wrong one.
 */
export const OPEN_DATA_LICENSE = {
  id: 'ODbL-1.0',
  name: 'Open Database License v1.0',
  url: 'https://opendatacommons.org/licenses/odbl/1-0/',
  /** The authoritative string. Page, GeoJSON/JSON member, LICENSE.txt. */
  attribution: '© OpenStreetMap contributors + POPS community',
  /**
   * The same attribution for an HTTP HEADER, and the difference is not
   * cosmetic. Header values are ISO-8859-1 by specification: Node writes the
   * UTF-8 bytes of `©` and every client decodes them as latin-1, so
   * `X-Attribution` arrives as "Â© OpenStreetMap…" — mojibake, in the one field
   * whose entire job is to be machine-readable. Caught by the e2e suite, which
   * compares the header against the constant rather than against itself.
   *
   * So the header carries an ASCII rendering and the BODY carries the real one.
   * A consumer reading either is attributing us correctly; a consumer reading
   * the header is not copying a broken character into their own page.
   */
  attributionAscii: '(c) OpenStreetMap contributors + POPS community',
} as const;

/** URL segment of the documented API. Bumped only for a breaking change. */
export const OPEN_DATA_API_VERSION = 'v1';

/**
 * The public-visibility predicate, as a string, defined ONCE for the whole
 * product.
 *
 * db/src/opendata/visibility.ts turns this into a drizzle `SQL` fragment, and
 * apps/web/lib/public-data.ts — the map's own queries — builds from that same
 * fragment. So the export and the national map cannot disagree about which
 * facilities are public: a bulk download can never contain a row a visitor
 * could not already see on /igrishta/[city], and a facility hidden from the map
 * is not quietly still in the CSV.
 *
 * The alias is `f`, matching every facilities query in the codebase.
 */
export const PUBLIC_FACILITY_PREDICATE =
  "f.status <> 'gone' AND f.slug IS NOT NULL AND (f.access <> 'paid' OR (EXISTS (SELECT 1 FROM app_settings st WHERE st.key = 'public_show_paid' AND st.value = 'true') AND (f.business_id IS NULL OR EXISTS (SELECT 1 FROM businesses b WHERE b.id = f.business_id AND b.visible))))";

/**
 * Field types. A closed set on purpose: the denylist rejects anything it does
 * not recognise, so adding a type is a deliberate act with a test behind it
 * rather than a `string | unknown` escape hatch.
 */
export type ExportFieldType =
  'string' | 'integer' | 'number' | 'boolean' | 'enum' | 'enum_list' | 'timestamp' | 'coordinate';

/**
 * Types that may never appear in an export, listed so the test asserts against
 * a named constant rather than an inlined literal. `jsonb` and `geometry` are
 * the two shapes that can carry data no field-level review would notice — the
 * first because it is an open bag, the second because a raw geometry column can
 * hold far more than the published point (a trace, a polygon somebody's GPS
 * recorded). Coordinates leave as two declared scalar `coordinate` fields.
 */
export const FORBIDDEN_TYPES = ['jsonb', 'json', 'geometry', 'geography', 'bytea'] as const;

export interface ExportField {
  /** CSV header and GeoJSON/JSON property name. Stable — it is an API. */
  readonly name: string;
  readonly type: ExportFieldType;
  /**
   * The SQL expression producing this field. A compile-time constant: no
   * request value ever reaches it, and assertSafeFragment() below plus the
   * relation allowlist in the compiler are what make that claim checkable
   * rather than merely intended.
   */
  readonly sql: string;
  /** i18n key under `OpenData.fields`. The docs page renders from this. */
  readonly descriptionKey: string;
  /** Required for `enum`/`enum_list`: the closed vocabulary of values. */
  readonly vocabulary?: readonly string[];
}

export type ExportFormat = 'geojson' | 'csv' | 'json';

export interface ExportDataset {
  /** URL segment, dump filename stem, and manifest key. */
  readonly id: string;
  /** i18n keys under `OpenData.datasets`. */
  readonly titleKey: string;
  readonly descriptionKey: string;
  /** FROM clause. Every relation in it must be on the compiler's allowlist. */
  readonly from: string;
  /** WHERE clause, or undefined for an already-aggregate view. */
  readonly where?: string;
  /** Deterministic, so re-running the dump for a version is byte-identical. */
  readonly orderBy: string;
  readonly formats: readonly ExportFormat[];
  /**
   * Present only when the rows carry a location: names the two `coordinate`
   * fields GeoJSON builds its Point from. Its absence is what makes an
   * aggregate dataset structurally incapable of emitting geometry.
   */
  readonly geometry?: { readonly lon: string; readonly lat: string };
  readonly fields: readonly ExportField[];
}

/**
 * Identifiers that may not appear in a field name or in its SQL.
 *
 * Matched as WHOLE TOKENS after splitting on every non-alphanumeric character,
 * never as substrings, and the reason is `municipality`: it contains "ip", and
 * a substring match would reject the single most important column in the
 * dataset while looking like it was working. Tokenising also means `uploaded_by`
 * is checked as `uploaded` + `by` rather than as one opaque string.
 *
 * This list is a statement about OUR DATABASE, not about English: every entry
 * is a real column or table in db/schema that holds, or resolves to, a person —
 * `actor` and `uploaded_by` on the contribution tables, `organizer_id`,
 * `recorded_by` and `participant_user_id` on the play tables, `granted_by` on
 * the ambassador grants, `handle` on the public passport, `token` on the
 * calendar feeds, and the better-auth users/sessions/accounts family. When a
 * new table adds a person-shaped column, its name belongs here.
 *
 * `verification` is deliberately ABSENT: `needs_verification` is a count of
 * facilities awaiting review and has nothing to do with the auth
 * `verifications` table. Keeping the auth tables out is the job of
 * ALLOWED_RELATIONS, which is the stronger guard anyway — a token list can only
 * catch a name somebody chose, while the relation allowlist catches the table
 * regardless of what its columns are called.
 */
export const DENIED_IDENTIFIERS = [
  'account',
  'accounts',
  'actor',
  'age',
  'agent',
  'birth',
  'birthdate',
  'checkin',
  'checkins',
  'dob',
  'email',
  'granted',
  'handle',
  'ip',
  'mail',
  'member',
  'members',
  'minor',
  'organiser',
  'organizer',
  'owner',
  'participant',
  'password',
  'phone',
  'recorded',
  'recorder',
  'reporter',
  'rsvp',
  'secret',
  'session',
  'sessions',
  'subscriber',
  'subscription',
  'tel',
  'token',
  'uploaded',
  'uploader',
  'user',
  'users',
] as const;

/**
 * Split any identifier or SQL fragment into lowercase alphanumeric tokens.
 * Shared by the compiler and the denylist test so they cannot disagree about
 * what counts as a token.
 */
export function identifierTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** The denied tokens present in `text`, empty when it is clean. */
export function deniedTokensIn(text: string): string[] {
  const denied = new Set<string>(DENIED_IDENTIFIERS);
  return [...new Set(identifierTokens(text).filter((t) => denied.has(t)))];
}

/**
 * Relations an export query may read. An allowlist rather than a denylist,
 * because the failure mode is a table that does not exist yet: a denylist
 * protects against the tables we thought of, an allowlist protects against
 * every table anybody adds after this file was written.
 *
 * All four are aggregate views or the facility corpus itself — nothing here
 * has a column that resolves to a person.
 */
export const ALLOWED_RELATIONS = [
  'facilities',
  'municipalities',
  'mv_national_stats',
  'mv_municipality_stats',
  'mv_sport_stats',
] as const;

/**
 * Characters permitted in a catalogue SQL fragment. Deliberately narrow: no
 * semicolon (no statement chaining), no `-` pair (no line comment), no `/*`,
 * no dollar quoting, no backslash. The fragments are compile-time constants, so
 * this is not defence against an attacker — it is defence against a future
 * edit that pastes something clever into a string that is later `sql.raw`'d.
 */
const FRAGMENT_ALLOWED = /^[A-Za-z0-9_.,()'"*+\-/<>= :|]+$/;

/**
 * The relations a FROM clause reads: the first table named, plus whatever
 * follows each JOIN. The clauses in this file are a handful of words long by
 * design — a dataset that needs a subquery to be expressible is a dataset whose
 * provenance nobody can check by reading it, and the compiler rejects anything
 * this cannot account for by requiring every result to be on ALLOWED_RELATIONS.
 */
export function relationsIn(from: string): string[] {
  const words = from.split(/\s+/).filter(Boolean);
  const relations: string[] = [];
  if (words[0]) relations.push(words[0].toLowerCase());
  for (let i = 0; i < words.length; i += 1) {
    if (words[i]?.toLowerCase() === 'join') {
      const next = words[i + 1];
      if (next) relations.push(next.toLowerCase());
    }
  }
  return relations;
}

export function assertSafeFragment(fragment: string, where: string): void {
  if (!FRAGMENT_ALLOWED.test(fragment)) {
    throw new Error(`opendata: unsafe characters in SQL fragment (${where})`);
  }
  if (fragment.includes(';'))
    throw new Error(`opendata: statement separator in fragment (${where})`);
  if (fragment.includes('--')) throw new Error(`opendata: line comment in fragment (${where})`);
  if (fragment.includes('/*')) throw new Error(`opendata: block comment in fragment (${where})`);
}

// ─── Shared field vocabularies ───────────────────────────────────────────────
// CANONICAL_SPORTS / CANONICAL_SURFACES / CONDITION_STATES are imported from
// the canonical lists at the top of this file rather than restated, so an
// export cannot document a vocabulary the product no longer uses. The three
// below have no canonical list of their own — they are pgEnum values, and the
// enum's own CHECK is upstream of them.

const ACCESS_VALUES = ['free', 'paid', 'restricted', 'school'] as const;
const STATUS_VALUES = ['active', 'needs_verification'] as const;
const SOURCE_VALUES = ['osm', 'municipal', 'crowd'] as const;

/**
 * The facility corpus — the dataset this whole stage exists for.
 *
 * Note what is NOT here, and why each absence is deliberate:
 *
 *   `attrs`     — jsonb, forbidden by type (see the file header).
 *   `id`        — the internal uuid. `slug` is the stable public identifier and
 *                 the one the website's URLs use, so it is the one that makes a
 *                 downloaded row joinable back to a page a person can visit.
 *   photos      — separately licensed, and a photo is not database content.
 *                 The licence page says so; the catalogue makes it true.
 *   contributor — who added or verified a facility is in facility_edits, which
 *                 is an audit trail, not open data. Publishing it would turn a
 *                 volunteer's contribution history into a downloadable file.
 *
 * `name` and `quarter` ARE free text a contributor typed, and they are exported
 * — because they are already rendered on the public facility page and the map
 * label. The export's job is to be the same corpus in a file; it publishes
 * nothing new. That is what PUBLIC_FACILITY_PREDICATE guarantees, and it is
 * also why widening the predicate is a decision with this comment attached.
 */
const FACILITIES: ExportDataset = {
  id: 'facilities',
  titleKey: 'facilities.title',
  descriptionKey: 'facilities.description',
  from: 'facilities f LEFT JOIN municipalities m ON m.id = f.municipality_id',
  where: PUBLIC_FACILITY_PREDICATE,
  // Stable and total: `id` is a uuid primary key, so no two runs can order two
  // rows differently and a same-day re-run of the dump is byte-identical.
  orderBy: 'f.id',
  formats: ['geojson', 'csv'],
  geometry: { lon: 'longitude', lat: 'latitude' },
  fields: [
    { name: 'slug', type: 'string', sql: 'f.slug', descriptionKey: 'slug' },
    { name: 'name', type: 'string', sql: 'f.name', descriptionKey: 'name' },
    {
      name: 'sports',
      type: 'enum_list',
      sql: 'f.sport_types',
      descriptionKey: 'sports',
      vocabulary: CANONICAL_SPORTS,
    },
    {
      name: 'surface',
      type: 'enum',
      sql: 'f.surface',
      descriptionKey: 'surface',
      vocabulary: CANONICAL_SURFACES,
    },
    { name: 'lighting', type: 'boolean', sql: 'f.lighting', descriptionKey: 'lighting' },
    { name: 'covered', type: 'boolean', sql: 'f.covered', descriptionKey: 'covered' },
    {
      name: 'access',
      type: 'enum',
      sql: 'f.access::text',
      descriptionKey: 'access',
      vocabulary: ACCESS_VALUES,
    },
    {
      name: 'status',
      type: 'enum',
      sql: 'f.status::text',
      descriptionKey: 'status',
      vocabulary: STATUS_VALUES,
    },
    {
      name: 'source',
      type: 'enum',
      sql: 'f.source::text',
      descriptionKey: 'source',
      vocabulary: SOURCE_VALUES,
    },
    { name: 'municipality', type: 'string', sql: 'm.name_bg', descriptionKey: 'municipality' },
    {
      name: 'municipality_ekatte',
      type: 'string',
      sql: 'm.ekatte_code',
      descriptionKey: 'municipalityEkatte',
    },
    { name: 'quarter', type: 'string', sql: 'f.quarter', descriptionKey: 'quarter' },
    {
      name: 'condition',
      type: 'enum',
      sql: 'f.condition::text',
      descriptionKey: 'condition',
      vocabulary: CONDITION_STATES,
    },
    {
      name: 'condition_reported_at',
      type: 'timestamp',
      sql: 'f.condition_reported_at',
      descriptionKey: 'conditionReportedAt',
    },
    { name: 'longitude', type: 'coordinate', sql: 'ST_X(f.geom)', descriptionKey: 'longitude' },
    { name: 'latitude', type: 'coordinate', sql: 'ST_Y(f.geom)', descriptionKey: 'latitude' },
    { name: 'updated_at', type: 'timestamp', sql: 'f.updated_at', descriptionKey: 'updatedAt' },
  ],
};

/**
 * National totals, read from the materialized view /statistika and /api/stats
 * already use. Reading the same view is the point: a figure in the open-data
 * download and the same figure on our own statistics page cannot drift apart,
 * because there is one query and one refresh behind both.
 */
const STATS_NATIONAL: ExportDataset = {
  id: 'stats-national',
  titleKey: 'statsNational.title',
  descriptionKey: 'statsNational.description',
  from: 'mv_national_stats f',
  orderBy: 'f.id',
  formats: ['json', 'csv'],
  fields: [
    { name: 'total', type: 'integer', sql: 'f.total', descriptionKey: 'total' },
    { name: 'active', type: 'integer', sql: 'f.active', descriptionKey: 'active' },
    {
      name: 'needs_verification',
      type: 'integer',
      sql: 'f.needs_verification',
      descriptionKey: 'needsVerification',
    },
    { name: 'free', type: 'integer', sql: 'f.free', descriptionKey: 'freeCount' },
    { name: 'paid', type: 'integer', sql: 'f.paid', descriptionKey: 'paidCount' },
    { name: 'restricted', type: 'integer', sql: 'f.restricted', descriptionKey: 'restrictedCount' },
    { name: 'school', type: 'integer', sql: 'f.school', descriptionKey: 'schoolCount' },
    { name: 'lit_true', type: 'integer', sql: 'f.lit_true', descriptionKey: 'litTrue' },
    { name: 'lit_known', type: 'integer', sql: 'f.lit_known', descriptionKey: 'litKnown' },
    { name: 'lit_unknown', type: 'integer', sql: 'f.lit_unknown', descriptionKey: 'litUnknown' },
    {
      name: 'municipalities_covered',
      type: 'integer',
      sql: 'f.municipalities_covered',
      descriptionKey: 'municipalitiesCovered',
    },
    { name: 'sports_count', type: 'integer', sql: 'f.sports_count', descriptionKey: 'sportsCount' },
    {
      name: 'generated_at',
      type: 'timestamp',
      sql: 'f.generated_at',
      descriptionKey: 'generatedAt',
    },
  ],
};

/**
 * Per-municipality coverage. `per_10k` is NULL — not zero, not estimated — for
 * every municipality absent from the NSI population dataset, exactly as the
 * accountability pages render it as "n/a". A downloaded file that silently
 * estimated the denominator would produce league tables we would then have to
 * defend, so the null travels.
 */
const STATS_MUNICIPALITIES: ExportDataset = {
  id: 'stats-municipalities',
  titleKey: 'statsMunicipalities.title',
  descriptionKey: 'statsMunicipalities.description',
  from: 'mv_municipality_stats f',
  orderBy: 'f.ekatte_code',
  formats: ['json', 'csv'],
  fields: [
    { name: 'ekatte_code', type: 'string', sql: 'f.ekatte_code', descriptionKey: 'ekatteCode' },
    { name: 'name_bg', type: 'string', sql: 'f.name_bg', descriptionKey: 'municipalityNameBg' },
    { name: 'name_en', type: 'string', sql: 'f.name_en', descriptionKey: 'municipalityNameEn' },
    { name: 'total', type: 'integer', sql: 'f.total', descriptionKey: 'total' },
    { name: 'active', type: 'integer', sql: 'f.active', descriptionKey: 'active' },
    {
      name: 'needs_verification',
      type: 'integer',
      sql: 'f.needs_verification',
      descriptionKey: 'needsVerification',
    },
    { name: 'free', type: 'integer', sql: 'f.free', descriptionKey: 'freeCount' },
    { name: 'lit_true', type: 'integer', sql: 'f.lit_true', descriptionKey: 'litTrue' },
    { name: 'lit_known', type: 'integer', sql: 'f.lit_known', descriptionKey: 'litKnown' },
    { name: 'population', type: 'integer', sql: 'f.population', descriptionKey: 'population' },
    { name: 'per_10k', type: 'number', sql: 'f.per_10k', descriptionKey: 'per10k' },
  ],
};

/** Facility count per sport; a multi-sport facility counts once per sport. */
const STATS_SPORTS: ExportDataset = {
  id: 'stats-sports',
  titleKey: 'statsSports.title',
  descriptionKey: 'statsSports.description',
  from: 'mv_sport_stats f',
  orderBy: 'f.sport',
  formats: ['json', 'csv'],
  fields: [
    {
      name: 'sport',
      type: 'enum',
      sql: 'f.sport',
      descriptionKey: 'sport',
      vocabulary: CANONICAL_SPORTS,
    },
    { name: 'total', type: 'integer', sql: 'f.total', descriptionKey: 'total' },
  ],
};

/**
 * THE CATALOGUE. Adding an entry here is the only way to publish a dataset —
 * and doing so subjects it, unavoidably, to lib/src/opendata/pii.test.ts and
 * db/src/opendata.test.ts.
 */
export const EXPORT_DATASETS: readonly ExportDataset[] = [
  FACILITIES,
  STATS_NATIONAL,
  STATS_MUNICIPALITIES,
  STATS_SPORTS,
];

export function datasetById(id: string): ExportDataset | undefined {
  return EXPORT_DATASETS.find((d) => d.id === id);
}

/** File extension a dataset+format pair is published under in the dumps. */
export function extensionFor(format: ExportFormat): string {
  return format === 'geojson' ? 'geojson' : format;
}

/** Every (dataset, format) pair the nightly dump writes. */
export function dumpArtifacts(): { dataset: ExportDataset; format: ExportFormat }[] {
  return EXPORT_DATASETS.flatMap((dataset) =>
    dataset.formats.map((format) => ({ dataset, format })),
  );
}
