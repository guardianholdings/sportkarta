import type pg from 'pg';

// The public-statistics materialized views (migration 0004). Refreshed by the
// pg-boss `stats.refresh` job (apps/worker) and db:seed. CONCURRENTLY avoids
// locking readers (/statistika, /api/stats) during the refresh — it needs the
// unique indexes from 0004 and a view already populated (created WITH DATA).
export const STATS_MATVIEWS = [
  'mv_national_stats',
  'mv_municipality_stats',
  'mv_sport_stats',
] as const;

// Accepts a Client (seed/CLI) or a Pool (worker). CONCURRENTLY runs each
// statement in autocommit, so a Pool's connection-per-query is fine.
export async function refreshStats(
  client: pg.ClientBase | pg.Pool,
  opts: { concurrently?: boolean } = {},
): Promise<void> {
  const mode = opts.concurrently === false ? '' : 'CONCURRENTLY ';
  for (const mv of STATS_MATVIEWS) {
    await client.query(`REFRESH MATERIALIZED VIEW ${mode}${mv}`);
  }
}
