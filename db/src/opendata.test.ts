import {
  ALLOWED_RELATIONS,
  EXPORT_DATASETS,
  PUBLIC_FACILITY_PREDICATE,
  serializeGeoJSON,
  serializeJson,
} from '@sportkarta/lib/opendata';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertDatasetSafe, exportQuery } from './opendata/export.js';
import { dumpGeneratedAt, dumpStoragePath, dumpVersionFor } from './opendata/dumps.js';
import { renderSql } from './render-sql.js';
import { publicFacilityVisible } from './opendata/visibility.js';

/**
 * The database half of the open-data guarantees (Stage 6.1).
 *
 * lib/src/opendata/pii.test.ts scans the CATALOGUE — what we declared. This
 * file checks what the database actually DOES with those declarations, which is
 * the assertion the pure tests structurally cannot make:
 *
 *   - the compiled SQL selects the declared fields and no star;
 *   - the columns that come back are EXACTLY the declared field names, in
 *     order, so a hand-edited query cannot smuggle one past the catalogue;
 *   - no column comes back as jsonb or geometry, whatever the catalogue says
 *     its type was.
 *
 * The compilation tests need no database. The result-shape tests do, and skip
 * without DATABASE_URL exactly like the rest of the db suite.
 */

describe('open-data export compiler (no database required)', () => {
  it.each(EXPORT_DATASETS)('$id compiles to a bounded SELECT with no star', (dataset) => {
    const { sql } = renderSql(exportQuery(dataset));
    expect(sql).not.toContain('*');
    expect(sql.startsWith('SELECT ')).toBe(true);
    expect(sql).toContain(' FROM ');
    expect(sql).toContain(' ORDER BY ');
    // One aliased column per declared field, and nothing else between SELECT
    // and FROM: this is the compiled form of "the select list IS the catalogue".
    const selectList = sql.slice('SELECT '.length, sql.indexOf(' FROM '));
    expect(selectList.split(' AS ').length - 1).toBe(dataset.fields.length);
    for (const field of dataset.fields) {
      expect(selectList).toContain(`"${field.name}"`);
    }
  });

  it('the facility export compiles the public map visibility predicate', () => {
    const facilities = EXPORT_DATASETS.find((d) => d.id === 'facilities');
    if (!facilities) throw new Error('facilities dataset missing');
    const { sql } = renderSql(exportQuery(facilities));
    expect(sql).toContain(PUBLIC_FACILITY_PREDICATE);
    // ...and it is the same fragment apps/web/lib/public-data.ts builds from,
    // so the map and the download cannot disagree about what is public.
    expect(renderSql(publicFacilityVisible).sql).toBe(PUBLIC_FACILITY_PREDICATE);
  });

  it('binds the row limit as a parameter rather than interpolating it', () => {
    const dataset = EXPORT_DATASETS[0];
    if (!dataset) throw new Error('catalogue is empty');
    const { sql, params } = renderSql(exportQuery(dataset, { limit: 25 }));
    expect(sql).toContain('LIMIT');
    expect(params).toContain(25);
  });

  it('rejects a dataset that reads a relation off the allowlist', () => {
    // The guard that matters most, exercised rather than assumed: this is what
    // stands between a hand-written FROM clause and the users table.
    const dataset = EXPORT_DATASETS[0];
    if (!dataset) throw new Error('catalogue is empty');
    expect(() => {
      assertDatasetSafe({ ...dataset, from: 'users u' });
    }).toThrow(/non-allowlisted relation/);
    expect(() => {
      assertDatasetSafe({ ...dataset, from: 'facilities f JOIN users u ON u.id = f.id' });
    }).toThrow(/non-allowlisted relation/);
  });

  it('rejects a field whose SQL could close the generated alias or chain a statement', () => {
    const dataset = EXPORT_DATASETS[0];
    if (!dataset) throw new Error('catalogue is empty');
    const withField = (sql: string, name = 'x') => ({
      ...dataset,
      fields: [{ name, type: 'string' as const, sql, descriptionKey: 'x' }],
    });
    expect(() => {
      assertDatasetSafe(withField('f.slug; DROP TABLE users'));
    }).toThrow();
    expect(() => {
      assertDatasetSafe(withField('f.slug -- comment'));
    }).toThrow();
    expect(() => {
      assertDatasetSafe(withField('f.*'));
    }).toThrow(/star/);
    expect(() => {
      assertDatasetSafe(withField('f.slug', 'bad"name'));
    }).toThrow(/plain identifier/);
  });

  it('no dataset id collides with a reserved API path segment', () => {
    // /api/opendata/v1/dumps is a static route that would otherwise be shadowed
    // by — or would shadow — a dataset with the same id.
    for (const dataset of EXPORT_DATASETS) {
      expect(['dumps']).not.toContain(dataset.id);
    }
  });
});

describe('open-data dump versioning', () => {
  it('versions on the civil Sofia date, not the UTC one', () => {
    // 00:40 UTC on 23 July is 03:40 in Sofia — the hour the nightly job runs.
    // A UTC date would file this dump under the 23rd's predecessor for the four
    // months of the year Sofia is UTC+3... which is precisely the case here.
    expect(dumpVersionFor(new Date('2026-07-23T00:40:00Z'))).toBe('2026-07-23');
    // And the reverse: 22:30 UTC on the 22nd is already the 23rd in Sofia.
    expect(dumpVersionFor(new Date('2026-07-22T22:30:00Z'))).toBe('2026-07-23');
    // Winter, UTC+2.
    expect(dumpVersionFor(new Date('2026-01-15T01:40:00Z'))).toBe('2026-01-15');
  });

  it('stamps artifacts with the version, so a re-run is byte-identical', () => {
    // Found by running the job twice and diffing: the CSVs matched and the
    // GeoJSON did not, because it embeds `generated_at`. That breaks the
    // `Cache-Control: immutable` on every dump URL — caches would serve bytes
    // whose checksum no longer matched the manifest, invisibly.
    const facilities = EXPORT_DATASETS.find((d) => d.id === 'facilities');
    const sports = EXPORT_DATASETS.find((d) => d.id === 'stats-sports');
    if (!facilities || !sports) throw new Error('catalogue changed shape');

    const version = '2026-07-23';
    const rows = [
      {
        slug: 'a',
        name: 'A',
        sports: ['football'],
        surface: null,
        lighting: null,
        covered: false,
        access: 'free',
        status: 'active',
        source: 'osm',
        municipality: 'Столична',
        municipality_ekatte: 'SOF46',
        quarter: null,
        condition: null,
        condition_reported_at: null,
        longitude: 23.3,
        latitude: 42.7,
        updated_at: new Date('2026-07-01T00:00:00Z'),
      },
    ];

    // Two "runs", a simulated hour apart. The stamp comes from the version, so
    // the wall clock cannot reach the bytes.
    const first = JSON.stringify(serializeGeoJSON(facilities, rows, dumpGeneratedAt(version)));
    const second = JSON.stringify(serializeGeoJSON(facilities, rows, dumpGeneratedAt(version)));
    expect(second).toBe(first);
    expect(first).toContain('2026-07-23T00:00:00.000Z');

    expect(
      JSON.stringify(
        serializeJson(sports, [{ sport: 'football', total: 3 }], dumpGeneratedAt(version)),
      ),
    ).toBe(
      JSON.stringify(
        serializeJson(sports, [{ sport: 'football', total: 3 }], dumpGeneratedAt(version)),
      ),
    );

    // A different version must produce different bytes — otherwise the stamp
    // would be decorative and nobody could tell two versions apart.
    expect(
      JSON.stringify(serializeGeoJSON(facilities, rows, dumpGeneratedAt('2026-07-24'))),
    ).not.toBe(first);
  });

  it('puts the version in the path, so a version is never overwritten', () => {
    expect(dumpStoragePath('2026-07-23', 'facilities', 'csv')).toBe(
      'opendata/2026-07-23/facilities.csv',
    );
    expect(dumpStoragePath('2026-07-24', 'facilities', 'csv')).not.toBe(
      dumpStoragePath('2026-07-23', 'facilities', 'csv'),
    );
  });
});

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('open-data exports against the real database', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it.each(EXPORT_DATASETS)(
    '$id returns exactly the declared columns, in order',
    async (dataset) => {
      // THE ASSERTION THE PURE TESTS CANNOT MAKE. The catalogue says which
      // columns exist; only the database can say which columns actually come
      // back. LIMIT 0 keeps it a metadata check — the column list is returned
      // for an empty result set too, so this costs nothing and reads no data.
      const { sql, params } = renderSql(exportQuery(dataset, { limit: 0 }));
      const result = await client.query({ text: sql, values: params, rowMode: 'array' });
      expect(result.fields.map((f) => f.name)).toEqual(dataset.fields.map((f) => f.name));
    },
  );

  it.each(EXPORT_DATASETS)('$id returns no jsonb or geometry column', async (dataset) => {
    const { sql, params } = renderSql(exportQuery(dataset, { limit: 0 }));
    const result = await client.query({ text: sql, values: params, rowMode: 'array' });
    const oids = result.fields.map((f) => f.dataTypeID);

    // Resolve the OIDs to type names rather than hardcoding them: jsonb is 3802
    // on every stock build, but PostGIS types are assigned at extension install
    // time and differ per database, so a hardcoded geometry OID would silently
    // pass on the machine that mattered.
    const types = await client.query<{ typname: string }>(
      `SELECT typname FROM pg_type WHERE oid = ANY($1::oid[])`,
      [oids],
    );
    const names = types.rows.map((r) => r.typname);
    for (const forbidden of ['json', 'jsonb', 'geometry', 'geography', 'bytea']) {
      expect(names, `${dataset.id} returns a ${forbidden} column`).not.toContain(forbidden);
    }
  });

  it('the facility export can never return a row the public map hides', async () => {
    // Belt and braces on the shared predicate: ask the database directly
    // whether the export's row set is a subset of the map's.
    const facilities = EXPORT_DATASETS.find((d) => d.id === 'facilities');
    if (!facilities) throw new Error('facilities dataset missing');
    const { sql } = renderSql(exportQuery(facilities));
    const leaked = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM (${sql}) e
       WHERE e.slug NOT IN (
         SELECT f.slug FROM facilities f WHERE ${PUBLIC_FACILITY_PREDICATE}
       )`,
    );
    expect(leaked.rows[0]?.n).toBe('0');
  });

  it('no allowlisted relation has a column that references a person', async () => {
    // The allowlist is the strong guard, so it is checked against the live
    // catalogue rather than against our memory of the schema: if somebody adds
    // an `owner_id` to `facilities` next year, this fails on that day — before
    // anybody thinks to export it.
    const result = await client.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [[...ALLOWED_RELATIONS]],
    );
    expect(result.rows.length).toBeGreaterThan(0);
    const personBearing = result.rows.filter((row) =>
      /(^|_)(user|users|actor|owner|member|organizer|uploaded|recorded|reporter|email|handle|token|participant)(_|$)/.test(
        row.column_name,
      ),
    );
    expect(personBearing.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([]);
  });

  it('api_keys cannot store a plaintext key in the LABEL either', async () => {
    // Found by the db-migration-reviewer: the first draft constrained only
    // key_hash, while `label` accepted 60 characters of anything — and an
    // issued key is 48. Somebody pasting their key into the name box would
    // have stored it in cleartext, seen it rendered back on the keys page, and
    // shipped it into every nightly backup, while the hash carried on
    // authenticating it.
    await client.query('BEGIN');
    try {
      await expect(
        client.query(
          `INSERT INTO api_keys (user_id, label, key_hash, prefix)
           VALUES ('nobody', 'skbg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
                   repeat('a', 64), 'skbg_AAAAAA')`,
        ),
      ).rejects.toThrow(/api_keys_label_no_key|violates check constraint/);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('api_keys_prefix_shape pins the prefix to the marker plus six characters', async () => {
    // The header claims "36 bits revealed, 220 withheld" is a constraint rather
    // than a convention. It only is if the shape rule says so.
    await client.query('BEGIN');
    try {
      await expect(
        client.query(
          `INSERT INTO api_keys (user_id, label, key_hash, prefix)
           VALUES ('nobody', 'too much prefix', repeat('a', 64), 'skbg_AAAAAAAAAA')`,
        ),
      ).rejects.toThrow(/api_keys_prefix_shape|violates check constraint/);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('opendata_dumps refuses two rows claiming one file', async () => {
    // "The row is the index, the file is the artifact" only holds if a path
    // belongs to exactly one row — otherwise the retention pruner can delete a
    // file that a live row still advertises.
    await client.query('BEGIN');
    try {
      const row = (dataset: string) =>
        `INSERT INTO opendata_dumps (version, dataset, format, storage_path, bytes, row_count, sha256)
         VALUES ('1999-01-01', '${dataset}', 'csv', 'opendata/1999-01-01/collide.csv', 1, 0, repeat('b', 64))`;
      await client.query(row('one'));
      await expect(client.query(row('two'))).rejects.toThrow(
        /opendata_dumps_storage_path_unique|duplicate key/,
      );
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('api_keys cannot store a plaintext key', async () => {
    // The claim migration 0015 makes, exercised: the CHECK, not a convention.
    await client.query('BEGIN');
    try {
      await expect(
        client.query(
          `INSERT INTO api_keys (user_id, label, key_hash, prefix)
           VALUES ('nobody', 'test', 'skbg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'skbg_AA')`,
        ),
      ).rejects.toThrow(/api_keys_hash_is_sha256_hex|violates check constraint/);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
