export { getDb } from './client.js';
export { checkDbHealth } from './health.js';
export type { DbHealth } from './health.js';
export { refreshStats, STATS_MATVIEWS } from './stats.js';
export { HORIZON_WEEKS, materializeSessions } from './sessions/materialize.js';
export type {
  MaterializeFailure,
  MaterializeOptions,
  MaterializeReport,
} from './sessions/materialize.js';

// Single drizzle instance for the whole workspace. Callers MUST build queries
// with this `sql` rather than importing drizzle-orm directly: pnpm keys package
// instances by their resolved peer deps, so a dependency that drags in one of
// drizzle's optional peers (better-auth pulls kysely) silently creates a second
// drizzle-orm copy whose SQL type is incompatible with this package's `db`.
export { sql } from 'drizzle-orm';
export type { SQL } from 'drizzle-orm';
export { renderSql } from './render-sql.js';
