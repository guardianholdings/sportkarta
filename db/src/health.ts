import { sql } from 'drizzle-orm';

import { getDb } from './client';

export interface DbHealth {
  postgisVersion: string;
  dwithinOk: boolean;
}

// Stage 0 DoD (docs/ROADMAP.md §2): an ST_DWithin smoke query must pass in
// every environment. Probes the seeded sofia-center row within 1 km.
export async function checkDbHealth(): Promise<DbHealth> {
  const db = getDb();

  const version = await db.execute(sql`SELECT postgis_version() AS version`);
  const smoke = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM _health
    WHERE ST_DWithin(
      geom::geography,
      ST_SetSRID(ST_MakePoint(23.3219, 42.6977), 4326)::geography,
      1000
    )
  `);

  const postgisVersion = String(
    (version.rows[0] as { version?: unknown } | undefined)?.version ?? '',
  );
  const n = Number((smoke.rows[0] as { n?: unknown } | undefined)?.n ?? 0);

  return { postgisVersion, dwithinOk: n >= 1 };
}
