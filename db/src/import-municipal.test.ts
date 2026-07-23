import type { NormalizedRow } from '@sportkarta/lib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { commitMunicipalImport, previewMunicipalRows } from './import/municipal.js';

/**
 * The database half of the municipal CSV inbox (docs/ROADMAP.md §8, Stage 6.3).
 * The pure classification and normalisation are in
 * lib/src/import-municipal/import-municipal.test.ts; this proves what only a
 * database can — that a commit writes source=municipal through facility_edits
 * and the merge policy, so a crowd field freezes and an OSM field is overwritten
 * — inside a transaction that is always rolled back.
 */

const url = process.env.DATABASE_URL;

// A spot comfortably inside Bulgaria and away from any seeded facility, so the
// dedupe search starts from an empty neighbourhood.
const LON = 27.912;
const LAT = 43.201;

function row(over: Partial<NormalizedRow> & { rowNumber: number }): NormalizedRow {
  return {
    name: 'Общинска площадка',
    sportTypes: ['football'],
    access: 'free',
    surface: 'grass',
    lighting: null,
    covered: false,
    quarter: null,
    lon: LON,
    lat: LAT,
    ...over,
  };
}

describe.skipIf(!url)('municipal import against the real database', () => {
  let client: pg.Client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function fieldEdit(
    facilityId: string,
    field: string,
  ): Promise<{ source: string } | undefined> {
    const result = await client.query<{ source: string }>(
      `SELECT source FROM facility_edits
       WHERE facility_id = $1 AND field = $2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [facilityId, field],
    );
    return result.rows[0];
  }

  it('a new row inserts a source=municipal facility with a created audit row', async () => {
    await client.query('BEGIN');
    try {
      const preview = await previewMunicipalRows(client, [row({ rowNumber: 2 })]);
      expect(preview[0]?.outcome.kind).toBe('new');

      const counts = await commitMunicipalImport(client, {
        rows: [row({ rowNumber: 2 })],
        resolutions: {},
        registryLabel: 'Тестова община 2026',
      });
      expect(counts.inserted).toBe(1);

      const facility = await client.query<{
        id: string;
        source: string;
        status: string;
        municipality_id: number | null;
        registry: string;
      }>(
        `SELECT id, source, status, municipality_id, attrs #>> '{municipal,registry}' AS registry
         FROM facilities
         WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326), 0.0001)
           AND source = 'municipal'`,
        [LON, LAT],
      );
      const inserted = facility.rows[0];
      expect(inserted).toBeDefined();
      expect(inserted?.source).toBe('municipal');
      // A new facility lands unverified, like every import — a registry entry is
      // a claim to be checked, not a confirmed fact.
      expect(inserted?.status).toBe('needs_verification');
      // Municipality derived by ST_Contains at insert, so the row is on its
      // city and quarter pages without waiting for an OSM run.
      expect(inserted?.municipality_id).not.toBeNull();
      // Provenance recorded on the record itself (CLAUDE.md).
      expect(inserted?.registry).toBe('Тестова община 2026');

      const created = await fieldEdit(inserted?.id ?? '', 'created');
      expect(created?.source).toBe('municipal');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('overwrites an OSM-set field and freezes a crowd-set one', async () => {
    await client.query('BEGIN');
    try {
      // An existing facility whose surface OSM set and whose name a resident
      // corrected — the exact mix the merge policy exists for.
      const facility = await client.query<{ id: string }>(
        `INSERT INTO facilities (geom, name, sport_types, surface, access, source, status)
         VALUES (ST_SetSRID(ST_MakePoint($1, $2), 4326), 'Име от гражданин', '{football}',
                 'grass', 'free', 'crowd', 'active')
         RETURNING id`,
        [LON, LAT],
      );
      const id = facility.rows[0]?.id;
      if (!id) throw new Error('fixture facility not created');
      await client.query(
        `INSERT INTO facility_edits (facility_id, actor, source, field, new_value)
         VALUES ($1, NULL, 'osm', 'surface', '"grass"'::jsonb),
                ($1, 'someone', 'crowd', 'name', '"Име от гражданин"'::jsonb)`,
        [id],
      );

      // The registry says a different name AND a different surface, at the same
      // spot. It must be recognised as the same facility...
      const incoming = row({
        rowNumber: 2,
        name: 'Име от общината',
        surface: 'artificial',
        sportTypes: ['football'],
      });
      const preview = await previewMunicipalRows(client, [incoming]);
      expect(preview[0]?.outcome.kind).toBe('conflict'); // same spot, different name

      // ...and the operator links it. The surface (OSM) updates; the name
      // (crowd) is frozen.
      const counts = await commitMunicipalImport(client, {
        rows: [incoming],
        resolutions: { 2: { action: 'link', facilityId: id } },
        registryLabel: 'Тест',
      });
      expect(counts.updated).toBe(1);
      expect(counts.frozenFields.name).toBe(1);

      const after = await client.query<{ name: string; surface: string }>(
        `SELECT name, surface FROM facilities WHERE id = $1`,
        [id],
      );
      expect(after.rows[0]?.surface).toBe('artificial'); // osm field overwritten
      expect(after.rows[0]?.name).toBe('Име от гражданин'); // crowd field frozen

      // The overwrite is audited as municipal; the name has no new municipal
      // edit, because it was never applied.
      expect((await fieldEdit(id, 'surface'))?.source).toBe('municipal');
      expect((await fieldEdit(id, 'name'))?.source).toBe('crowd');
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('auto-matches a same-named facility on the same spot without a resolution', async () => {
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO facilities (geom, name, sport_types, surface, access, source, status)
         VALUES (ST_SetSRID(ST_MakePoint($1, $2), 4326), 'Общинска площадка', '{football}',
                 'grass', 'free', 'crowd', 'active')`,
        [LON, LAT],
      );
      const incoming = row({ rowNumber: 2, name: 'Общинска площадка', surface: 'asphalt' });

      const preview = await previewMunicipalRows(client, [incoming]);
      expect(preview[0]?.outcome.kind).toBe('match');

      const counts = await commitMunicipalImport(client, {
        rows: [incoming],
        resolutions: {},
        registryLabel: 'Тест',
      });
      expect(counts.updated).toBe(1);
      expect(counts.inserted).toBe(0);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('leaves an unresolved conflict untouched — no write without a decision', async () => {
    await client.query('BEGIN');
    try {
      const before = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM facilities`);
      await client.query(
        `INSERT INTO facilities (geom, name, sport_types, access, source, status)
         VALUES (ST_SetSRID(ST_MakePoint($1, $2), 4326), 'Съществуваща', '{football}',
                 'free', 'crowd', 'active')`,
        [LON, LAT],
      );
      const incoming = row({ rowNumber: 2, name: 'Съвсем различно име' });

      const preview = await previewMunicipalRows(client, [incoming]);
      expect(preview[0]?.outcome.kind).toBe('conflict');

      const counts = await commitMunicipalImport(client, {
        rows: [incoming],
        resolutions: {}, // operator did not resolve it
        registryLabel: 'Тест',
      });
      expect(counts.skipped).toBe(1);
      expect(counts.inserted).toBe(0);
      expect(counts.updated).toBe(0);

      // Exactly one facility was added (the fixture), none by the import.
      const after = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM facilities`);
      expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n) + 1);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('a conflict resolved as "new" inserts a distinct facility', async () => {
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO facilities (geom, name, sport_types, access, source, status)
         VALUES (ST_SetSRID(ST_MakePoint($1, $2), 4326), 'Друг обект', '{football}',
                 'free', 'crowd', 'active')`,
        [LON, LAT],
      );
      const incoming = row({ rowNumber: 2, name: 'Нова общинска площадка' });

      const counts = await commitMunicipalImport(client, {
        rows: [incoming],
        resolutions: { 2: { action: 'new' } },
        registryLabel: 'Тест',
      });
      expect(counts.inserted).toBe(1);

      const municipal = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM facilities
         WHERE ST_DWithin(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326), 0.0001)
           AND source = 'municipal'`,
        [LON, LAT],
      );
      expect(Number(municipal.rows[0]?.n)).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('a link to a facility the row did not collide with is refused, not obeyed', async () => {
    await client.query('BEGIN');
    try {
      // A facility far away — not among the incoming row's live candidates.
      const far = await client.query<{ id: string }>(
        `INSERT INTO facilities (geom, name, sport_types, access, source, status)
         VALUES (ST_SetSRID(ST_MakePoint(23.0, 42.0), 4326), 'Далечен обект', '{football}',
                 'free', 'crowd', 'active')
         RETURNING id`,
      );
      const farId = far.rows[0]?.id;
      if (!farId) throw new Error('fixture not created');

      const counts = await commitMunicipalImport(client, {
        rows: [row({ rowNumber: 2 })],
        // The operator (or a tampered form post) asks to link to a facility the
        // row is nowhere near; the commit re-checks candidates and refuses.
        resolutions: { 2: { action: 'link', facilityId: farId } },
        registryLabel: 'Тест',
      });
      expect(counts.updated).toBe(0);
      expect(counts.skipped).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });

  it('a re-import of the same registry writes nothing the second time', async () => {
    await client.query('BEGIN');
    try {
      const rows = [row({ rowNumber: 2 })];
      const first = await commitMunicipalImport(client, {
        rows,
        resolutions: {},
        registryLabel: 'Тест',
      });
      expect(first.inserted).toBe(1);

      // Second run: the freshly-inserted facility is now a same-named match on
      // the same spot with identical fields, so the merge yields no changes.
      const second = await commitMunicipalImport(client, {
        rows,
        resolutions: {},
        registryLabel: 'Тест',
      });
      expect(second.inserted).toBe(0);
      expect(second.updated).toBe(0);
      expect(second.unchanged).toBe(1);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
