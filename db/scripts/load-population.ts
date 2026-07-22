import { readFileSync } from 'node:fs';

import { config } from 'dotenv';
import pg from 'pg';

// Root .env (relative to this file: db/scripts/ -> repo root).
config({ path: new URL('../../.env', import.meta.url).pathname });

// Provenance stored on every row + shown in the /statistika methodology.
const SOURCE = 'НСИ, Преброяване 2021 / NSI 2021 Census';

/**
 * Load db/data/population.csv into municipality_population (idempotent upsert).
 * Rows whose ekatte_code is not a known municipality are skipped (the FK would
 * reject them), so a stray code never aborts the load. Returns rows written.
 */
export async function loadPopulation(client: pg.ClientBase): Promise<number> {
  const csvPath = new URL('../data/population.csv', import.meta.url).pathname;
  const lines = readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);

  const known = new Set(
    (
      await client.query<{ ekatte_code: string }>('SELECT ekatte_code FROM municipalities')
    ).rows.map((r) => r.ekatte_code),
  );

  let written = 0;
  for (const line of lines.slice(1)) {
    const [ekatteRaw, popRaw] = line.split(',');
    const ekatte = ekatteRaw?.trim();
    const population = Number(popRaw);
    if (!ekatte || !known.has(ekatte) || !Number.isInteger(population) || population <= 0) continue;
    const result = await client.query(
      `
      INSERT INTO municipality_population (ekatte_code, population, source, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (ekatte_code)
      DO UPDATE SET population = EXCLUDED.population, source = EXCLUDED.source, updated_at = now()
      `,
      [ekatte, population, SOURCE],
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env.example)');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const n = await loadPopulation(client);
    console.log(`load-population: upserted ${String(n)} municipality population row(s)`);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('[load-population] failed', error);
    process.exit(1);
  });
}
