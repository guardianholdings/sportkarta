import { BULGARIA_BBOX } from '@sportkarta/lib/geo';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The TypeScript box and the database CHECK are the same box.
 *
 * `facilities_geom_in_bulgaria` (migration 0001) is what actually enforces where
 * a facility may be — the application constant is a courtesy that produces a
 * readable error before Postgres produces an unreadable one. If the two drift,
 * one of two silent failures follows:
 *
 *   - The constant WIDENS: the map pans somewhere a member can drop a pin, fill
 *     in the whole form, and then hit a raw constraint violation instead of the
 *     `outside_bulgaria` message written for exactly that case.
 *   - The constant NARROWS: a real border facility becomes unenterable through
 *     the app while the database would have accepted it happily, and nothing
 *     anywhere reports a problem.
 *
 * Parsing the CHECK's own text rather than re-stating the numbers is the point:
 * a test that hardcoded 22/29/41/44.5 on both sides would pass while both were
 * wrong together.
 *
 * Integration test; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('Bulgaria bounds (requires running database)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('matches facilities_geom_in_bulgaria exactly', async () => {
    const result = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def
       FROM pg_constraint WHERE conname = 'facilities_geom_in_bulgaria'`,
    );
    const def = result.rows[0]?.def;
    expect(def, 'the CHECK must exist — migration 0001').toBeDefined();

    // Every numeric literal in the CHECK, in source order: minLon, maxLon,
    // minLat, maxLat.
    const numbers = (def ?? '').match(/\d+\.?\d*/g)?.map(Number) ?? [];
    expect(numbers).toEqual([
      BULGARIA_BBOX.minLon,
      BULGARIA_BBOX.maxLon,
      BULGARIA_BBOX.minLat,
      BULGARIA_BBOX.maxLat,
    ]);
  });

  /**
   * And the behaviour, not only the text: the database must actually refuse a
   * point the constant calls outside.
   */
  it('refuses a facility outside the box', async () => {
    await expect(
      client.query(
        // `access` and `source` are NOT NULL with no default; without them
        // Postgres reports the null violation and never reaches the CHECK, so
        // the test would pass for the wrong reason.
        `INSERT INTO facilities (name, geom, source, access, status)
         VALUES ('e2e bounds probe', ST_SetSRID(ST_MakePoint($1, $2), 4326),
                 'crowd', 'free', 'active')`,
        [BULGARIA_BBOX.maxLon + 1, 42.0],
      ),
    ).rejects.toThrow(/facilities_geom_in_bulgaria/);
  });
});
