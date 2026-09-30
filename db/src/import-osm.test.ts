import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The OSM importer lives in its own package (scripts/import-osm), whose suite
// has no database in CI. Its SQL is exercised here instead, where CI provides
// PostGIS — the package's pure mapping and dedupe tests stay next to the code.
import { importCandidates } from '../../scripts/import-osm/src/importer.js';
import type { FacilityCandidate, OsmType } from '../../scripts/import-osm/src/normalize.js';

/**
 * The importer's pre-launch audit fixes, against the real schema, inside a
 * transaction that is always rolled back:
 *  - finding 81: a row OSM now marks abandoned/disused is withdrawn (`gone`,
 *    audited as 'osm' with a NULL actor) unless a person has written to it,
 *    and restored when the tag goes away;
 *  - finding 88: a new node duplicating a way at the same spot is not
 *    inserted, and an existing row always wins over a new one;
 *  - finding 87: a new facility outside every municipality is refused when the
 *    boundary layer is complete, and one a few metres off the coast snaps to
 *    the nearest municipality.
 */

const url = process.env.DATABASE_URL;

// Far above any real OSM id, so the refs never collide with imported rows.
let nextId = 9_100_000_000_000;

// A spot inside Столична both in the seed's placeholder box and in reality,
// and away from every seeded facility.
const LON = 23.15;
const LAT = 42.6;

function candidate(
  osmType: OsmType,
  lon: number,
  lat: number,
  over: Partial<FacilityCandidate> = {},
): FacilityCandidate {
  nextId += 1;
  const point = osmType === 'node';
  const d = 0.00002; // a ~3 m square around the point for ways
  const geometry = point
    ? { type: 'Point', coordinates: [lon, lat] }
    : {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [lon - d, lat - d],
              [lon + d, lat - d],
              [lon + d, lat + d],
              [lon - d, lat + d],
              [lon - d, lat - d],
            ],
          ],
        ],
      };
  return {
    osmType,
    osmId: nextId,
    name: `OSM import test ${String(nextId)}`,
    sportTypes: ['fitness'],
    surface: null,
    lighting: null,
    covered: false,
    access: 'free',
    geometryJson: JSON.stringify(geometry),
    geometryKind: geometry.type,
    tags: { leisure: point ? 'fitness_station' : 'pitch', sport: 'fitness' },
    unmappedSports: [],
    ...over,
  };
}

const keyOf = (c: FacilityCandidate): string => `${c.osmType}:${String(c.osmId)}`;

describe.skipIf(!url)('OSM importer against the real database', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  beforeEach(async () => {
    await client.query('BEGIN');
  });

  afterEach(async () => {
    await client.query('ROLLBACK');
  });

  async function row(
    c: FacilityCandidate,
  ): Promise<{ id: string; status: string; municipality_id: number | null } | undefined> {
    const result = await client.query<{
      id: string;
      status: string;
      municipality_id: number | null;
    }>(`SELECT id, status, municipality_id FROM facilities WHERE osm_type = $1 AND osm_id = $2`, [
      c.osmType,
      c.osmId,
    ]);
    return result.rows[0];
  }

  async function lastStatusEdit(
    facilityId: string,
  ): Promise<{ actor: string | null; source: string; new_value: string } | undefined> {
    const result = await client.query<{ actor: string | null; source: string; new_value: string }>(
      `SELECT actor, source, new_value FROM facility_edits
        WHERE facility_id = $1 AND field = 'status'
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [facilityId],
    );
    return result.rows[0];
  }

  describe('lifecycle withdrawal (finding 81)', () => {
    it('withdraws a row OSM now marks abandoned, and restores it when the tag goes', async () => {
      const pitch = candidate('way', LON, LAT);
      await importCandidates(client, [pitch]);
      const imported = await row(pitch);
      expect(imported?.status).toBe('needs_verification');

      const withdrawal = await importCandidates(client, [], { withdrawn: new Set([keyOf(pitch)]) });
      expect(withdrawal.withdrawn).toBe(1);
      expect(withdrawal.withdrawnKept).toEqual([]);
      // Present in the extract, just withdrawn — not "missing" (every other
      // OSM row is, since this run's extract is empty).
      const osmRows = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM facilities WHERE osm_type IS NOT NULL`,
      );
      expect(withdrawal.missingFromExtract).toBe(Number(osmRows.rows[0]?.n) - 1);
      expect((await row(pitch))?.status).toBe('gone');
      // Institutional, and never readable as "last verified".
      expect(await lastStatusEdit(imported?.id ?? '')).toEqual({
        actor: null,
        source: 'osm',
        new_value: 'gone',
      });

      // Re-running with the tag still there writes nothing more.
      const again = await importCandidates(client, [], { withdrawn: new Set([keyOf(pitch)]) });
      expect(again.withdrawn).toBe(0);

      // The mapper removes the tag: the object is a candidate again.
      const back = await importCandidates(client, [pitch]);
      expect(back.restored).toBe(1);
      expect((await row(pitch))?.status).toBe('needs_verification');
      expect((await lastStatusEdit(imported?.id ?? ''))?.new_value).toBe('needs_verification');
    });

    it('never withdraws a row a person has written to, or one a person marked gone', async () => {
      const vouched = candidate('way', LON + 0.001, LAT);
      const verified = candidate('way', LON + 0.002, LAT);
      await importCandidates(client, [vouched, verified]);
      const vouchedRow = await row(vouched);
      const verifiedRow = await row(verified);
      // A condition report / correction by a member …
      await client.query(
        `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
         VALUES ($1, 'import-osm-test', 'crowd', 'surface', NULL, '"asphalt"'::jsonb)`,
        [vouchedRow?.id],
      );
      // … and a facility a person verified on the spot.
      await client.query(`UPDATE facilities SET status = 'active' WHERE id = $1`, [
        verifiedRow?.id,
      ]);

      const result = await importCandidates(client, [], {
        withdrawn: new Set([keyOf(vouched), keyOf(verified)]),
      });
      expect(result.withdrawn).toBe(0);
      expect(result.withdrawnKept.map((k) => [k.ref, k.status]).sort()).toEqual(
        [
          [keyOf(verified), 'active'],
          [keyOf(vouched), 'needs_verification'],
        ].sort(),
      );
      expect((await row(vouched))?.status).toBe('needs_verification');
      expect((await row(verified))?.status).toBe('active');

      // A `gone` decided by a person is theirs: the tag disappearing does not
      // bring the row back.
      await client.query(`UPDATE facilities SET status = 'gone' WHERE id = $1`, [verifiedRow?.id]);
      await client.query(
        `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
         VALUES ($1, 'import-osm-test', 'crowd', 'status', '"active"'::jsonb, '"gone"'::jsonb)`,
        [verifiedRow?.id],
      );
      const rerun = await importCandidates(client, [verified]);
      expect(rerun.restored).toBe(0);
      expect((await row(verified))?.status).toBe('gone');
    });
  });

  describe('cross-element duplicates (finding 88)', () => {
    it('inserts the way and not the node mapped on top of it', async () => {
      const node = candidate('node', LON + 0.004, LAT);
      const way = candidate('way', LON + 0.004 + 0.00002, LAT); // ~2 m east
      const counts = await importCandidates(client, [node, way]);
      expect(counts.inserted).toBe(1);
      expect(counts.duplicatesSkipped).toEqual([
        { keep: keyOf(way), drop: keyOf(node), distanceM: expect.any(Number) },
      ]);
      expect(await row(way)).toBeDefined();
      expect(await row(node)).toBeUndefined();
    });

    it('keeps an existing row and does not add a new duplicate of it', async () => {
      const node = candidate('node', LON + 0.006, LAT);
      await importCandidates(client, [node]);
      const way = candidate('way', LON + 0.006, LAT);
      const counts = await importCandidates(client, [node, way]);
      expect(counts.inserted).toBe(0);
      expect(counts.duplicatesSkipped.map((p) => p.drop)).toEqual([keyOf(way)]);
      expect(await row(node)).toBeDefined();
      expect(await row(way)).toBeUndefined();
    });

    it('does not let a row someone marked gone block a new mapping of the place', async () => {
      const node = candidate('node', LON + 0.008, LAT);
      await importCandidates(client, [node]);
      const nodeRow = await row(node);
      await client.query(`UPDATE facilities SET status = 'gone' WHERE id = $1`, [nodeRow?.id]);
      await client.query(
        `INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
         VALUES ($1, 'import-osm-test', 'crowd', 'status', '"needs_verification"'::jsonb, '"gone"'::jsonb)`,
        [nodeRow?.id],
      );
      const way = candidate('way', LON + 0.008, LAT);
      const counts = await importCandidates(client, [node, way]);
      expect(counts.inserted).toBe(1);
      expect(await row(way)).toBeDefined();
    });
  });

  describe('municipality border (finding 87)', () => {
    // The easternmost municipality's boundary point due east of its centre is
    // on the coast in reality (and on the placeholder box's edge in CI), so a
    // few metres further east no municipality contains the point.
    async function coastPoint(): Promise<{ municipalityId: number; lon: number; lat: number }> {
      const result = await client.query<{ id: number; lon: number; lat: number }>(`
        SELECT m.id,
               ST_X(p) AS lon, ST_Y(p) AS lat
          FROM (SELECT id, geom FROM municipalities ORDER BY ST_XMax(geom) DESC, id LIMIT 1) m,
               LATERAL (SELECT ST_ClosestPoint(m.geom,
                         ST_SetSRID(ST_MakePoint(29.0, ST_Y(ST_Centroid(m.geom))), 4326)) AS p) c
      `);
      const r = result.rows[0];
      if (!r) throw new Error('fixture: no municipalities — run pnpm db:seed');
      return { municipalityId: r.id, lon: Number(r.lon), lat: Number(r.lat) };
    }

    const metresEast = (lon: number, lat: number, m: number): number =>
      lon + m / (111_320 * Math.cos((lat * Math.PI) / 180));

    it('snaps a facility a few metres off the coast to that municipality', async () => {
      const coast = await coastPoint();
      const beach = candidate('node', metresEast(coast.lon, coast.lat, 5), coast.lat);
      const counts = await importCandidates(client, [beach], { dropOutsideMunicipalities: true });
      expect(counts.inserted).toBe(1);
      expect((await row(beach))?.municipality_id).toBe(coast.municipalityId);
    });

    it('refuses a new facility outside every municipality only when told the layer is complete', async () => {
      const coast = await coastPoint();
      const offshore = candidate('node', metresEast(coast.lon, coast.lat, 1000), coast.lat);

      const refused = await importCandidates(client, [offshore], {
        dropOutsideMunicipalities: true,
      });
      expect(refused.inserted).toBe(0);
      expect(refused.outsideMunicipalities.map((o) => o.ref)).toEqual([keyOf(offshore)]);
      expect(await row(offshore)).toBeUndefined();

      // With a boundary missing, "outside every municipality" proves nothing.
      const kept = await importCandidates(client, [offshore]);
      expect(kept.inserted).toBe(1);
      expect((await row(offshore))?.municipality_id).toBeNull();
    });
  });
});
