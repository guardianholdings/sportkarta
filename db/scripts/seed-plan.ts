/**
 * What a seed run writes — kept apart from seed.ts (which connects and runs on
 * import) so the contract below is testable without a database.
 *
 * TWO AUDIENCES, TWO SEEDS. Dev and CI need a small invented world: three
 * placeholder municipality boxes and seven fixture facilities, which the
 * db-backed tests and the e2e suite borrow. Production needs none of it — it
 * has the real boundaries and ~7k imported facilities — but the deploy ran the
 * one seed on every release, so five fixture pins sat on the public map as
 * `active` and credited to the community (audit finding 82, corrected by
 * migration 0031). `--production` is the deploy's seed: only what a real
 * deployment cannot run without.
 *
 * A flag rather than a second script on purpose: a rollback redeploys an older
 * image with the CURRENT deploy.yml, and an older seed ignores an unknown flag
 * where it would fail on an unknown script name.
 */

export const PRODUCTION_FLAG = '--production';

export type SeedStep =
  /** The `_health` row /api/health smoke-queries; migrations never create it. */
  | 'health'
  /** Placeholder municipality boxes with real EKATTE codes (fixture). */
  | 'municipalities'
  /** The seven fixture facilities (fixture). */
  | 'facilities'
  /** ST_Contains assignment for unassigned rows — repairs older dev databases. */
  | 'assign_municipalities'
  /**
   * Slug backfill. Fixture-only as well: in production every writer slugs at
   * insert, and the municipal importer leaves an unnamed row unslugged ON
   * PURPOSE (off the public map) — a per-deploy backfill would publish it.
   */
  | 'slugs'
  /** NSI municipality population, upserted — the per-10k figures. */
  | 'population'
  /** Refresh the statistics materialized views (0030/0031 rely on this). */
  | 'stats';

const PRODUCTION_STEPS: readonly SeedStep[] = ['health', 'population', 'stats'];

const FIXTURE_STEPS: readonly SeedStep[] = [
  'health',
  'municipalities',
  'facilities',
  'assign_municipalities',
  'slugs',
  'population',
  'stats',
];

export function isProductionSeed(argv: readonly string[]): boolean {
  return argv.includes(PRODUCTION_FLAG);
}

export function seedSteps(production: boolean): readonly SeedStep[] {
  return production ? PRODUCTION_STEPS : FIXTURE_STEPS;
}
