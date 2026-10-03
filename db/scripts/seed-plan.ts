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
 * deployment cannot run without — and, since Boss decision #18, the
 * retirement of the fixtures that did reach it (db/src/seed-fixtures.ts).
 *
 * A flag rather than a second script on purpose: a rollback redeploys an older
 * image with the CURRENT deploy.yml, and an older seed ignores an unknown flag
 * where it would fail on an unknown script name. The retirement rides the same
 * flag for the same reason.
 *
 * THE FIXTURE SEED REFUSES PRODUCTION. The fixtures did not arrive through the
 * deploy's seed: its first run (2026-08-08 22:42 UTC) found all seven "already
 * present". A full `pnpm db:seed` run by hand against the new server, between
 * the first deploy's failed health gate and its successful re-run, put them
 * there. So the guard sits in the seed itself: it refuses its fixture scope
 * where compose.prod.yml marks the deployment (SEED_FIXTURES_FORBIDDEN), and
 * in any database that has recorded the retirement — production, or a
 * restored copy of it.
 */

export const PRODUCTION_FLAG = '--production';

/** Set by deploy/compose.prod.yml on the container that runs the seed. */
export const FIXTURES_FORBIDDEN_ENV = 'SEED_FIXTURES_FORBIDDEN';

/** Where the production seed exports the fixture rows before retiring them. */
export const EXPORT_DIR_ENV = 'SEED_FIXTURE_EXPORT_DIR';

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
  /**
   * Production only: export, then retire (`status = 'gone'`), the seven
   * fixtures if they are here and were never retired before. Once per row, a
   * no-op on every later deploy. Before 'stats', so the refresh counts it.
   */
  | 'retire_fixtures'
  /** NSI municipality population, upserted — the per-10k figures. */
  | 'population'
  /** Refresh the statistics materialized views (0030/0031 rely on this). */
  | 'stats';

const PRODUCTION_STEPS: readonly SeedStep[] = ['health', 'retire_fixtures', 'population', 'stats'];

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

function truthy(value: string | undefined): boolean {
  return value !== undefined && ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
}

/**
 * Why the FIXTURE scope must not run here, or null when it may. `env` is the
 * process environment; `retirementsRecorded` comes from
 * fixtureRetirementsRecorded() (db/src/seed-fixtures.ts).
 */
export function fixtureScopeRefusal(input: {
  env: Readonly<Record<string, string | undefined>>;
  retirementsRecorded: number;
}): string | null {
  if (truthy(input.env[FIXTURES_FORBIDDEN_ENV])) {
    return `${FIXTURES_FORBIDDEN_ENV} is set — this is the production deployment, whose seed is \`pnpm db:seed ${PRODUCTION_FLAG}\``;
  }
  if (input.retirementsRecorded > 0) {
    return `this database has retired the seed fixtures (Boss decision #18) — it is production or a copy of it; its seed is \`pnpm db:seed ${PRODUCTION_FLAG}\``;
  }
  return null;
}
