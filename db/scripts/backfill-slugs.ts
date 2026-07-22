import { facilitySlug } from '@sportkarta/lib';
import { config } from 'dotenv';
import pg from 'pg';

// Root .env (relative to this file: db/scripts/ -> repo root).
config({ path: new URL('../../.env', import.meta.url).pathname });

// Assign stable public slugs to every facility that still has none — the
// existing OSM/seed rows created before the slug column existed (migration
// 0002). Idempotent: only NULL-slug rows are touched, so re-runs are no-ops.
// Slugs are never regenerated for already-slugged rows (links stay stable).
// New facilities are slugged at insert time (importer, seed), so this is a
// one-off catch-up plus a safety net after bulk imports.

interface UnsluggedRow {
  id: string;
  name: string | null;
  osm_type: string | null;
  osm_id: string | null;
}

export async function backfillSlugs(client: pg.ClientBase): Promise<number> {
  const taken = new Set(
    (
      await client.query<{ slug: string }>(`SELECT slug FROM facilities WHERE slug IS NOT NULL`)
    ).rows.map((r) => r.slug),
  );

  // Deterministic order → deterministic collision suffixes across runs.
  const rows = (
    await client.query<UnsluggedRow>(
      `SELECT id, name, osm_type, osm_id FROM facilities WHERE slug IS NULL ORDER BY id`,
    )
  ).rows;

  let assigned = 0;
  for (const row of rows) {
    // Same fallback shape the importer uses, so a row's slug is identical
    // whether it was slugged at insert or backfilled later.
    const fallback = row.osm_type && row.osm_id ? `${row.osm_type}-${row.osm_id}` : row.id;
    const slug = facilitySlug(row.name, fallback, (c) => taken.has(c));
    taken.add(slug);
    await client.query(`UPDATE facilities SET slug = $1 WHERE id = $2`, [slug, row.id]);
    assigned += 1;
  }
  return assigned;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env.example)');

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    const assigned = await backfillSlugs(client);
    await client.query('COMMIT');
    console.log(`backfill-slugs: assigned ${String(assigned)} slug(s)`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

// Run as a CLI, but stay importable by the seed (which calls backfillSlugs
// on its own client). import.meta.url === argv[1] only when executed directly.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error('[backfill-slugs] failed', error);
    process.exit(1);
  });
}
