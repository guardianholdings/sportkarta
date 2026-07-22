import { config } from 'dotenv';
import pg from 'pg';

import { backfillSlugs } from './backfill-slugs.js';

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

const SOFIA_FACILITIES: SeedFacility[] = [
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
];

// Idempotent dev/prod seed: _health smoke row + 5 hand-made Sofia facilities.
// Every facility creation is audited in facility_edits (append-only), written
// only when the INSERT actually happened — municipality_id stays NULL until
// the boundaries import lands (Stage 1).
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

    let inserted = 0;
    for (const f of SOFIA_FACILITIES) {
      const result = await client.query(
        `
        WITH ins AS (
          INSERT INTO facilities
            (id, geom, name, sport_types, surface, lighting, covered,
             access, status, quarter, source, attrs)
          VALUES
            ($1::uuid, ST_SetSRID(ST_MakePoint($2, $3), 4326), $4, $5::text[],
             $6, $7, false, 'free', 'active', $8, 'crowd', '{"seed": true}'::jsonb)
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
      `seed: ${String(inserted)} of ${String(SOFIA_FACILITIES.length)} Sofia facilities inserted (rest already present)`,
    );

    // Assign public slugs to the seed rows (and any other unslugged rows) so
    // the seeded DB is directly usable by the public map / facility pages.
    const slugged = await backfillSlugs(client);
    console.log(`seed: assigned ${String(slugged)} facility slug(s)`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] failed', error);
  process.exit(1);
});
