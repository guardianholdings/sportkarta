import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL;

// Integration tests against the real dev/CI database (compose.dev.yml),
// mirroring health.test.ts. Every test runs inside a transaction that is
// rolled back, so repeated runs leave no residue — essential here because
// facility_edits is append-only and audited facilities cannot be deleted.
describe.skipIf(!url)('core facilities schema (requires running database)', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function insertTestFacility(): Promise<string> {
    const result = await client.query<{ id: string }>(`
      INSERT INTO facilities (geom, name, sport_types, access, source)
      VALUES (ST_SetSRID(ST_MakePoint(23.30, 42.70), 4326), 'schema-test', '{basketball}', 'free', 'crowd')
      RETURNING id
    `);
    const row = result.rows[0];
    if (!row) throw new Error('facility INSERT returned no row');
    return row.id;
  }

  it('facility_edits is append-only: UPDATE, DELETE and TRUNCATE all raise', async () => {
    await client.query('BEGIN');
    try {
      const facilityId = await insertTestFacility();
      const edit = await client.query<{ id: string }>(
        `
        INSERT INTO facility_edits (facility_id, source, field, new_value)
        VALUES ($1, 'crowd', 'created', '{"test": true}'::jsonb)
        RETURNING id
        `,
        [facilityId],
      );
      const editRow = edit.rows[0];
      if (!editRow) throw new Error('facility_edits INSERT returned no row');
      const editId = editRow.id;

      await client.query('SAVEPOINT before_mutation');

      await expect(
        client.query(`UPDATE facility_edits SET field = 'tampered' WHERE id = $1`, [editId]),
      ).rejects.toThrow(/append-only/);
      await client.query('ROLLBACK TO SAVEPOINT before_mutation');

      await expect(
        client.query('DELETE FROM facility_edits WHERE id = $1', [editId]),
      ).rejects.toThrow(/append-only/);
      await client.query('ROLLBACK TO SAVEPOINT before_mutation');

      await expect(client.query('TRUNCATE facility_edits')).rejects.toThrow(/append-only/);
      await client.query('ROLLBACK TO SAVEPOINT before_mutation');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('audited facilities cannot be hard-deleted (FK RESTRICT)', async () => {
    await client.query('BEGIN');
    try {
      const facilityId = await insertTestFacility();
      await client.query(
        `INSERT INTO facility_edits (facility_id, source, field, new_value)
         VALUES ($1, 'crowd', 'created', '{"test": true}'::jsonb)`,
        [facilityId],
      );
      await client.query('SAVEPOINT before_delete');
      await expect(
        client.query('DELETE FROM facilities WHERE id = $1', [facilityId]),
      ).rejects.toThrow(/facility_edits_facility_id_facilities_id_fk/);
      await client.query('ROLLBACK TO SAVEPOINT before_delete');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('bbox queries on facilities use the GIST index', async () => {
    await client.query('BEGIN');
    try {
      // 5 seed rows would make the planner prefer a seq scan; disabling it
      // proves the index is present and usable, which is what we assert.
      await client.query('SET LOCAL enable_seqscan = off');
      const plan = await client.query(`
        EXPLAIN (FORMAT JSON)
        SELECT id FROM facilities
        WHERE geom && ST_MakeEnvelope(23.2, 42.6, 23.5, 42.8, 4326)
      `);
      expect(JSON.stringify(plan.rows)).toContain('facilities_geom_gist');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('duplicate OSM refs are rejected; facilities without refs are unaffected', async () => {
    await client.query('BEGIN');
    try {
      await client.query(`
        INSERT INTO facilities (geom, sport_types, access, source, osm_type, osm_id)
        VALUES (ST_SetSRID(ST_MakePoint(23.31, 42.71), 4326), '{football}', 'free', 'osm', 'node', 999999999001)
      `);
      await client.query('SAVEPOINT before_dup');
      await expect(
        client.query(`
          INSERT INTO facilities (geom, sport_types, access, source, osm_type, osm_id)
          VALUES (ST_SetSRID(ST_MakePoint(23.32, 42.72), 4326), '{football}', 'free', 'osm', 'node', 999999999001)
        `),
      ).rejects.toThrow(/facilities_osm_ref_unique/);
      await client.query('ROLLBACK TO SAVEPOINT before_dup');

      // The partial index ignores NULL refs: many crowd facilities may coexist.
      await insertTestFacility();
      await insertTestFacility();
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('rejects a lat/lon-swapped point (facilities_geom_in_bulgaria)', async () => {
    await client.query('BEGIN');
    try {
      await expect(
        client.query(`
          INSERT INTO facilities (geom, sport_types, access, source)
          VALUES (ST_SetSRID(ST_MakePoint(42.6977, 23.3219), 4326), '{basketball}', 'free', 'crowd')
        `),
      ).rejects.toThrow(/facilities_geom_in_bulgaria/);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
