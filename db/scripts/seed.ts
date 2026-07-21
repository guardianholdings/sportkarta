import { config } from 'dotenv';
import pg from 'pg';

// Root .env (relative to this file: db/scripts/ -> repo root).
config({ path: new URL('../../.env', import.meta.url).pathname });

// Idempotent dev/prod seed: guarantees the _health smoke row exists.
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
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('[seed] failed', error);
  process.exit(1);
});
