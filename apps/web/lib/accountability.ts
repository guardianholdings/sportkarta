import { getDb, sql } from '@sportkarta/db';

/**
 * Municipality accountability (docs/ROADMAP.md §5, Stage 3.4).
 *
 * One municipality, one page of numbers, and the same numbers again as an
 * embeddable widget a municipality can put on its own site. The point of the
 * feature is civic: a mayor's office can see — and publish — how much free
 * sports infrastructure it has per resident, how much of it the public says is
 * broken, and how long problem reports wait before somebody acts on them.
 *
 * AGGREGATE-ONLY IS THE BINDING RULE, and it is a property of THIS TYPE, not of
 * the page that renders it. `MunicipalityAccountability` carries counts,
 * medians and shares; it has no field that can hold a person, and
 * apps/web/tests/accountability.test.ts asserts exactly that against the shape
 * — every value is a number or null, except the five identifying-the-PLACE
 * fields (name, slug, ekatte, generatedAt, license). A future field called
 * `topContributor` fails that test rather than shipping a name into an iframe
 * on somebody else's domain, where our own privacy page does not apply and
 * where we would never see the leak.
 *
 * Contributor COUNTS are still small-number-suppressed (see
 * MIN_DISCLOSED_CONTRIBUTORS): "1 person maintains this municipality's data" is
 * a count, but next to a public leaderboard it is close enough to a name.
 *
 * The visibility rule matches the public map exactly (`status <> 'gone' AND
 * slug IS NOT NULL`), so a municipality can count the pins on /igrishta/[city]
 * and get the number this page shows. A metric nobody can reconcile is a metric
 * nobody believes.
 */

/**
 * Below this, contributor counts are reported as null and the UI says "fewer
 * than N". k-anonymity, deliberately conservative: the number is decoration,
 * and the cost of getting it wrong is naming a volunteer to their mayor.
 */
export const MIN_DISCLOSED_CONTRIBUTORS = 5;

/** Reports resolved within this window feed the median. */
export const RESOLUTION_WINDOW_DAYS = 90;

/** Contribution activity window. */
export const ACTIVITY_WINDOW_DAYS = 365;

export interface MunicipalityAccountability {
  /** Identifies the PLACE, never a person. */
  nameBg: string;
  nameEn: string;
  slug: string;
  ekatteCode: string;
  /** ISO instant the figures were computed. */
  generatedAt: string;
  /** Data licence of the underlying dataset — ODbL, always stated. */
  license: string;

  /** Permanent population (NSI); null when the municipality is absent. */
  population: number | null;

  // Coverage
  total: number;
  free: number;
  lit: number;
  covered: number;
  /** Facilities per 10 000 residents; null without a population figure. */
  per10k: number | null;
  /** Rank among municipalities that have a population figure (1 = best). */
  per10kRank: number | null;
  per10kOf: number | null;

  // Data quality
  active: number;
  needsVerification: number;
  withPhoto: number;

  // Provenance (merge policy: crowd > municipal > osm)
  fromOsm: number;
  fromMunicipal: number;
  fromCrowd: number;

  // Condition, as last reported by the public
  conditionExcellent: number;
  conditionGood: number;
  conditionPoor: number;
  conditionUnusable: number;
  conditionUnreported: number;

  // Responsiveness — the accountability metric proper
  reportsOpen: number;
  /** Age of the oldest unresolved report, in days. */
  reportsOldestOpenDays: number | null;
  reportsResolvedInWindow: number;
  /** Median hours from report filed to moderation decision, over the window. */
  reportsMedianHours: number | null;

  // Community activity
  editsInWindow: number;
  /**
   * Distinct crowd contributors, or null when suppressed. Null means "between 1
   * and MIN_DISCLOSED_CONTRIBUTORS - 1" and nothing else — zero is reported as
   * zero — so the UI can render "fewer than N" without a second boolean field
   * that the aggregate-only shape test would have to carve an exception for.
   */
  contributors: number | null;
}

/**
 * The k-anonymity rule, as a pure function so it can be tested without a
 * database — and so there is exactly one place it is applied. Zero is disclosed
 * as zero ("nobody has contributed here" is a finding, not a person); anything
 * from 1 to MIN_DISCLOSED_CONTRIBUTORS - 1 becomes null.
 */
export function discloseContributors(count: number): number | null {
  if (count <= 0) return 0;
  return count < MIN_DISCLOSED_CONTRIBUTORS ? null : count;
}

function int(value: unknown): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Everything the page and the widget show, for one municipality.
 *
 * Four statements rather than one: they scan different tables and the planner
 * does better with them apart, and the page is revalidated hourly, so the cost
 * is paid once per city per hour rather than per visitor.
 */
export async function municipalityAccountability(city: {
  id: number;
  slug: string;
  nameBg: string;
  nameEn: string;
}): Promise<MunicipalityAccountability> {
  const db = getDb();

  const facilities = await db.execute(sql`
    SELECT
      m.ekatte_code,
      p.population::int AS population,
      count(f.id)::int AS total,
      count(f.id) FILTER (WHERE f.access = 'free')::int AS free,
      count(f.id) FILTER (WHERE f.lighting IS TRUE)::int AS lit,
      count(f.id) FILTER (WHERE f.covered)::int AS covered,
      count(f.id) FILTER (WHERE f.status = 'active')::int AS active,
      count(f.id) FILTER (WHERE f.status = 'needs_verification')::int AS needs_verification,
      count(f.id) FILTER (WHERE f.source = 'osm')::int AS from_osm,
      count(f.id) FILTER (WHERE f.source = 'municipal')::int AS from_municipal,
      count(f.id) FILTER (WHERE f.source = 'crowd')::int AS from_crowd,
      count(f.id) FILTER (WHERE f.condition = 'excellent')::int AS condition_excellent,
      count(f.id) FILTER (WHERE f.condition = 'good')::int AS condition_good,
      count(f.id) FILTER (WHERE f.condition = 'poor')::int AS condition_poor,
      count(f.id) FILTER (WHERE f.condition = 'unusable')::int AS condition_unusable,
      count(f.id) FILTER (WHERE f.condition IS NULL)::int AS condition_unreported,
      count(f.id) FILTER (WHERE EXISTS (
        SELECT 1 FROM facility_photos ph
         WHERE ph.facility_id = f.id AND ph.status = 'approved'
      ))::int AS with_photo
    FROM municipalities m
    LEFT JOIN municipality_population p ON p.ekatte_code = m.ekatte_code
    -- LEFT JOIN, so a municipality with nothing mapped yet still renders a page
    -- of zeros. That page is the point: "we have no data here" is the finding.
    LEFT JOIN facilities f
      ON f.municipality_id = m.id AND f.status <> 'gone' AND f.slug IS NOT NULL
    WHERE m.id = ${city.id}
    GROUP BY m.ekatte_code, p.population
  `);
  const f = facilities.rows[0] ?? {};

  // Rank is computed over the same public visibility rule, among the
  // municipalities that HAVE a population figure — ranking a municipality
  // against places whose denominator is unknown would be meaningless.
  const rank = await db.execute(sql`
    WITH per10k AS (
      SELECT m.id,
             count(f.id)::numeric * 10000 / p.population AS value
      FROM municipalities m
      JOIN municipality_population p ON p.ekatte_code = m.ekatte_code
      LEFT JOIN facilities f
        ON f.municipality_id = m.id AND f.status <> 'gone' AND f.slug IS NOT NULL
      GROUP BY m.id, p.population
    )
    SELECT me.value,
           (SELECT count(*) FROM per10k o WHERE o.value > me.value)::int + 1 AS rank,
           (SELECT count(*) FROM per10k)::int AS ranked
    FROM per10k me
    WHERE me.id = ${city.id}
  `);
  const r = rank.rows[0] ?? {};

  // Responsiveness. Open reports come from the live queue; the median comes
  // from the append-only decision log, scoped by the municipality recorded AT
  // DECISION TIME — so a later boundary correction cannot rewrite how fast this
  // municipality's reports were handled last quarter.
  const reports = await db.execute(sql`
    SELECT
      (SELECT count(*)::int FROM facility_reports fr
         JOIN facilities f ON f.id = fr.facility_id
        WHERE f.municipality_id = ${city.id} AND fr.status = 'pending') AS open,
      (SELECT extract(epoch FROM now() - min(fr.created_at)) / 86400.0
         FROM facility_reports fr
         JOIN facilities f ON f.id = fr.facility_id
        WHERE f.municipality_id = ${city.id} AND fr.status = 'pending') AS oldest_open_days,
      (SELECT count(*)::int FROM moderation_decisions d
        WHERE d.municipality_id = ${city.id} AND d.target_type = 'report'
          AND d.decided_at >= now() - ${`${String(RESOLUTION_WINDOW_DAYS)} days`}::interval)
        AS resolved,
      (SELECT percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch FROM d.decided_at - d.queued_at)) / 3600.0
         FROM moderation_decisions d
        WHERE d.municipality_id = ${city.id} AND d.target_type = 'report'
          AND d.decided_at >= now() - ${`${String(RESOLUTION_WINDOW_DAYS)} days`}::interval)
        AS median_hours
  `);
  const rep = reports.rows[0] ?? {};

  // Community activity. `actor` is an opaque account id and never leaves this
  // query — only its cardinality does, and only above the k threshold.
  const activity = await db.execute(sql`
    SELECT
      count(*)::int AS edits,
      count(DISTINCT e.actor) FILTER (WHERE e.actor IS NOT NULL)::int AS contributors
    FROM facility_edits e
    JOIN facilities f ON f.id = e.facility_id
    WHERE f.municipality_id = ${city.id}
      AND e.source = 'crowd'
      AND e.created_at >= now() - ${`${String(ACTIVITY_WINDOW_DAYS)} days`}::interval
  `);
  const act = activity.rows[0] ?? {};

  return {
    nameBg: city.nameBg,
    nameEn: city.nameEn,
    slug: city.slug,
    ekatteCode: String(f.ekatte_code ?? ''),
    generatedAt: new Date().toISOString(),
    license: 'ODbL 1.0',

    population: numOrNull(f.population),

    total: int(f.total),
    free: int(f.free),
    lit: int(f.lit),
    covered: int(f.covered),
    per10k: numOrNull(r.value),
    per10kRank: numOrNull(r.rank),
    per10kOf: numOrNull(r.ranked),

    active: int(f.active),
    needsVerification: int(f.needs_verification),
    withPhoto: int(f.with_photo),

    fromOsm: int(f.from_osm),
    fromMunicipal: int(f.from_municipal),
    fromCrowd: int(f.from_crowd),

    conditionExcellent: int(f.condition_excellent),
    conditionGood: int(f.condition_good),
    conditionPoor: int(f.condition_poor),
    conditionUnusable: int(f.condition_unusable),
    conditionUnreported: int(f.condition_unreported),

    reportsOpen: int(rep.open),
    reportsOldestOpenDays: numOrNull(rep.oldest_open_days),
    reportsResolvedInWindow: int(rep.resolved),
    reportsMedianHours: numOrNull(rep.median_hours),

    editsInWindow: int(act.edits),
    contributors: discloseContributors(int(act.contributors)),
  };
}

/**
 * The keys that may hold a string. Everything else in the payload MUST be a
 * number or null — this list is the machine-readable statement of the
 * aggregate-only rule, and the test reads it rather than repeating it.
 */
export const NON_NUMERIC_FIELDS = [
  'nameBg',
  'nameEn',
  'slug',
  'ekatteCode',
  'generatedAt',
  'license',
] as const;
