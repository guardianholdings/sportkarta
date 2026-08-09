import { config } from 'dotenv';
import pg from 'pg';

import { refreshStats } from '../src/stats.js';
import { backfillSlugs } from './backfill-slugs.js';
import { loadPopulation } from './load-population.js';

// Root .env (relative to this file: db/scripts/ -> repo root).
config({ path: new URL('../../.env', import.meta.url).pathname });

// Fixed UUIDs make re-runs idempotent (ON CONFLICT (id) DO NOTHING) and mark
// the rows as unmistakably synthetic.
interface SeedFacility {
  id: string;
  name: string;
  sportTypes: string[];
  surface: string;
  lighting: boolean | null; // null = unknown
  quarter: string;
  lon: number;
  lat: number;
}

// Minimal municipality set so a seed-only database has the world the
// db-backed tests BORROW rather than create (facilities in more than one
// municipality, ST_Contains assignment at insert). Real EKATTE codes on
// deliberately crude bounding boxes: the OSM importer upserts municipalities
// by ekatte_code (ON CONFLICT DO UPDATE), so a real import replaces these
// placeholder shapes with true boundaries instead of colliding with them.
interface SeedMunicipality {
  ekatte: string;
  nameBg: string;
  nameEn: string;
  /** [west, south, east, north] box in EPSG:4326. */
  box: [number, number, number, number];
}

const SEED_MUNICIPALITIES: SeedMunicipality[] = [
  { ekatte: 'SOF46', nameBg: 'Столична', nameEn: 'Stolichna', box: [23.1, 42.55, 23.55, 42.8] },
  { ekatte: 'PDV22', nameBg: 'Пловдив', nameEn: 'Plovdiv', box: [24.68, 42.08, 24.83, 42.2] },
  { ekatte: 'VAR06', nameBg: 'Варна', nameEn: 'Varna', box: [27.8, 43.12, 28.0, 43.3] },
];

const SEED_FACILITIES: SeedFacility[] = [
  {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Стрийтбол игрища – Борисова градина',
    sportTypes: ['basketball'],
    surface: 'asphalt',
    lighting: true,
    quarter: 'Средец',
    lon: 23.3389,
    lat: 42.6839,
  },
  {
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Фитнес на открито – Южен парк',
    sportTypes: ['fitness', 'calisthenics'],
    surface: 'rubber',
    lighting: null,
    quarter: 'Триадица',
    lon: 23.3106,
    lat: 42.6712,
  },
  {
    id: '00000000-0000-4000-8000-000000000003',
    name: 'Футболно игрище – парк „Гео Милев“',
    sportTypes: ['football'],
    surface: 'artificial_turf',
    lighting: false,
    quarter: 'Гео Милев',
    lon: 23.3593,
    lat: 42.6819,
  },
  {
    id: '00000000-0000-4000-8000-000000000004',
    name: 'Тенис на маса – парк „Заимов“',
    sportTypes: ['table_tennis'],
    surface: 'concrete',
    lighting: null,
    quarter: 'Оборище',
    lon: 23.3441,
    lat: 42.6926,
  },
  {
    id: '00000000-0000-4000-8000-000000000005',
    name: 'Стрийт фитнес – Студентски град',
    sportTypes: ['calisthenics'],
    surface: 'rubber',
    lighting: true,
    quarter: 'Студентски град',
    lon: 23.3465,
    lat: 42.6506,
  },
  {
    id: '00000000-0000-4000-8000-000000000006',
    name: 'Фитнес на открито – Гребен канал',
    sportTypes: ['fitness'],
    surface: 'rubber',
    lighting: null,
    quarter: 'Западен',
    lon: 24.7398,
    lat: 42.1354,
  },
  {
    id: '00000000-0000-4000-8000-000000000007',
    name: 'Стрийтбол – Морска градина',
    sportTypes: ['basketball'],
    surface: 'asphalt',
    lighting: true,
    quarter: 'Приморски',
    lon: 27.926,
    lat: 43.2141,
  },
];

// Idempotent dev/prod seed: _health smoke row + 3 placeholder municipalities +
// 7 hand-made facilities across them (Sofia, Plovdiv, Varna). Every facility
// creation is audited in facility_edits (append-only), written only when the
// INSERT actually happened. municipality_id is derived by ST_Contains at
// insert, exactly like the importer — the db-backed tests borrow facilities
// in distinct municipalities instead of creating their own (creating would
// drift the stats materialized views), so the seed must provide that world.
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required (see .env.example)');
  }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      INSERT INTO _health (label, geom)
      VALUES ('sofia-center', ST_SetSRID(ST_MakePoint(23.3219, 42.6977), 4326))
      ON CONFLICT (label) DO NOTHING
    `);
    console.log('seed: _health row "sofia-center" present');

    let municipalitiesInserted = 0;
    for (const m of SEED_MUNICIPALITIES) {
      const result = await client.query(
        `
        INSERT INTO municipalities (ekatte_code, name_bg, name_en, geom)
        VALUES ($1, $2, $3, ST_Multi(ST_MakeEnvelope($4, $5, $6, $7, 4326)))
        ON CONFLICT (ekatte_code) DO NOTHING
        `,
        [m.ekatte, m.nameBg, m.nameEn, ...m.box],
      );
      municipalitiesInserted += result.rowCount ?? 0;
    }
    console.log(
      `seed: ${String(municipalitiesInserted)} of ${String(SEED_MUNICIPALITIES.length)} municipalities inserted (rest already present)`,
    );

    let inserted = 0;
    for (const f of SEED_FACILITIES) {
      const result = await client.query(
        `
        WITH ins AS (
          INSERT INTO facilities
            (id, geom, name, sport_types, surface, lighting, covered,
             access, status, quarter, source, attrs, municipality_id)
          VALUES
            ($1::uuid, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5::text[],
             $6, $7, false, 'free', 'active', $8, 'crowd', '{"seed": true}'::jsonb,
             (SELECT m.id FROM municipalities m
               WHERE ST_Contains(m.geom, ST_SetSRID(ST_MakePoint($2, $3), 4326))
               ORDER BY m.id LIMIT 1))
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        )
        INSERT INTO facility_edits (facility_id, actor, source, field, old_value, new_value)
        SELECT id, NULL, 'crowd', 'created', NULL, '{"seed": true}'::jsonb FROM ins
        RETURNING facility_id
        `,
        [f.id, f.lon, f.lat, f.name, f.sportTypes, f.surface, f.lighting, f.quarter],
      );
      inserted += result.rowCount ?? 0;
    }
    console.log(
      `seed: ${String(inserted)} of ${String(SEED_FACILITIES.length)} facilities inserted (rest already present)`,
    );

    // Re-seeding an older database: assign municipalities to rows that predate
    // the seeded boundaries. Mirrors the importer's ST_Contains assignment and
    // touches only unassigned rows, so real import assignments are never moved.
    const assigned = await client.query(`
      UPDATE facilities f
         SET municipality_id = m.id
        FROM municipalities m
       WHERE f.municipality_id IS NULL AND ST_Contains(m.geom, f.geom)
    `);
    console.log(`seed: assigned municipality to ${String(assigned.rowCount ?? 0)} facility row(s)`);

    // Assign public slugs to the seed rows (and any other unslugged rows) so
    // the seeded DB is directly usable by the public map / facility pages.
    const slugged = await backfillSlugs(client);
    console.log(`seed: assigned ${String(slugged)} facility slug(s)`);

    // Load municipality population (per-10k) then refresh the statistics
    // materialized views so /statistika reflects the seeded data.
    const populated = await loadPopulation(client);
    console.log(`seed: loaded ${String(populated)} municipality population row(s)`);
    await refreshStats(client);
    console.log('seed: refreshed statistics materialized views');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] failed', error);
  process.exit(1);
});
