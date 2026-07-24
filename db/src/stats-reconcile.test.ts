import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { refreshStats } from './stats.js';

const url = process.env.DATABASE_URL;

// The accuracy guarantee for /statistika + /api/stats: every number the public
// sees comes from the materialized views, and here we prove each view aggregate
// EQUALS a direct query on the base `facilities` table under the platform's
// public-visibility predicate — status <> 'gone' AND slug IS NOT NULL, the same
// rule as the map, the API and the export (0017; audit AUDIT-F2: "count the
// pins and get the same number"). Requires the running dev/CI database (skips
// otherwise). Read-only apart from refreshing the views.
describe.skipIf(!url)('statistics reconciliation (requires running database)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
    // Ensure the views reflect the current base data before comparing.
    await refreshStats(client, { concurrently: false });
  });

  afterAll(async () => {
    await client.end();
  });

  it('national totals equal a direct facilities query', async () => {
    const mv = (await client.query('SELECT * FROM mv_national_stats WHERE id = 1'))
      .rows[0] as Record<string, unknown>;
    const direct = (
      await client.query(`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'active')::int AS active,
        count(*) FILTER (WHERE status = 'needs_verification')::int AS needs_verification,
        count(*) FILTER (WHERE access = 'free')::int AS free,
        count(*) FILTER (WHERE access = 'paid')::int AS paid,
        count(*) FILTER (WHERE access = 'restricted')::int AS restricted,
        count(*) FILTER (WHERE access = 'school')::int AS school,
        count(*) FILTER (WHERE lighting IS TRUE)::int AS lit_true,
        count(*) FILTER (WHERE lighting IS NOT NULL)::int AS lit_known,
        count(*) FILTER (WHERE lighting IS NULL)::int AS lit_unknown,
        count(DISTINCT municipality_id)::int AS municipalities_covered
      FROM facilities WHERE status <> 'gone' AND slug IS NOT NULL
    `)
    ).rows[0] as Record<string, number>;

    for (const key of Object.keys(direct)) {
      expect(Number(mv[key]), `national.${key}`).toBe(direct[key]);
    }
  });

  it('national sports_count equals a direct distinct-sport count', async () => {
    const mv = (await client.query('SELECT sports_count::int AS n FROM mv_national_stats'))
      .rows[0] as {
      n: number;
    };
    const direct = (
      await client.query(`
      SELECT count(DISTINCT s.sport)::int AS n
      FROM facilities f, LATERAL unnest(f.sport_types) AS s(sport)
      WHERE f.status <> 'gone' AND f.slug IS NOT NULL
    `)
    ).rows[0] as { n: number };
    expect(mv.n).toBe(direct.n);
  });

  it('municipality totals + the no-municipality bucket sum to the national total', async () => {
    const muniSum = (
      await client.query('SELECT coalesce(sum(total), 0)::int AS s FROM mv_municipality_stats')
    ).rows[0] as { s: number };
    const nullMuni = (
      await client.query(
        "SELECT count(*)::int AS n FROM facilities WHERE status <> 'gone' AND slug IS NOT NULL AND municipality_id IS NULL",
      )
    ).rows[0] as { n: number };
    const national = (await client.query('SELECT total::int AS n FROM mv_national_stats'))
      .rows[0] as {
      n: number;
    };
    expect(muniSum.s + nullMuni.n).toBe(national.n);
  });

  it('per-municipality columns equal a direct grouped query (back the table %s)', async () => {
    const mv = (
      await client.query(`
      SELECT municipality_id, total::int, active::int, needs_verification::int,
             free::int, lit_true::int, lit_known::int
      FROM mv_municipality_stats ORDER BY municipality_id
    `)
    ).rows;
    const direct = (
      await client.query(`
      SELECT municipality_id,
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'active')::int AS active,
        count(*) FILTER (WHERE status = 'needs_verification')::int AS needs_verification,
        count(*) FILTER (WHERE access = 'free')::int AS free,
        count(*) FILTER (WHERE lighting IS TRUE)::int AS lit_true,
        count(*) FILTER (WHERE lighting IS NOT NULL)::int AS lit_known
      FROM facilities
      WHERE status <> 'gone' AND slug IS NOT NULL AND municipality_id IS NOT NULL
      GROUP BY municipality_id ORDER BY municipality_id
    `)
    ).rows;
    expect(mv).toEqual(direct);
  });

  it('per-sport counts equal a direct unnest query', async () => {
    const mv = (await client.query('SELECT sport, total::int FROM mv_sport_stats ORDER BY sport'))
      .rows;
    const direct = (
      await client.query(`
      SELECT s.sport, count(*)::int AS total
      FROM facilities f, LATERAL unnest(f.sport_types) AS s(sport)
      WHERE f.status <> 'gone' AND f.slug IS NOT NULL
      GROUP BY s.sport ORDER BY s.sport
    `)
    ).rows;
    expect(mv).toEqual(direct);
  });

  it('an active null-slug row is NOT counted (AUDIT-F2 regression)', async () => {
    // The audit's exact failure: one active facility without a slug made
    // /api/stats count a pin the map does not show. A slugless row has no
    // public page, so the stats must not see it either. Non-concurrent refresh
    // is transactional, so the ROLLBACK restores the view's contents.
    await client.query('BEGIN');
    try {
      const before = (await client.query('SELECT total::int AS n FROM mv_national_stats'))
        .rows[0] as { n: number };
      await client.query(`
        INSERT INTO facilities (geom, name, slug, sport_types, access, source, status)
        VALUES (ST_SetSRID(ST_MakePoint(23.5, 42.5), 4326), 'Одит без слъг', NULL,
                '{football}', 'free', 'crowd', 'active')
      `);
      await refreshStats(client, { concurrently: false });
      const after = (await client.query('SELECT total::int AS n FROM mv_national_stats'))
        .rows[0] as { n: number };
      expect(after.n).toBe(before.n);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('per-10k is NULL exactly when population is absent, and computes correctly otherwise', async () => {
    const rows = (
      await client.query(`
      SELECT ms.total::int AS total, ms.per_10k, p.population
      FROM mv_municipality_stats ms
      LEFT JOIN municipality_population p ON p.ekatte_code = ms.ekatte_code
    `)
    ).rows as { total: number; per_10k: string | null; population: number | null }[];

    for (const r of rows) {
      if (r.population === null) {
        expect(r.per_10k).toBeNull();
      } else {
        expect(r.per_10k).not.toBeNull();
        const expected = Math.round(((r.total * 10000) / r.population) * 100) / 100;
        expect(Number(r.per_10k)).toBeCloseTo(expected, 2);
      }
    }
  });
});
