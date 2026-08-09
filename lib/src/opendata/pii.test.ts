import { describe, expect, it } from 'vitest';

import {
  ALLOWED_RELATIONS,
  assertSafeFragment,
  deniedTokensIn,
  DENIED_IDENTIFIERS,
  EXPORT_DATASETS,
  FORBIDDEN_TYPES,
  identifierTokens,
  PUBLIC_FACILITY_PREDICATE,
  relationsIn,
  type ExportDataset,
} from './schema.js';
import { serializeCsv, serializeGeoJSON, serializeJson } from './serialize.js';

/**
 * THE PII DENYLIST (docs/ROADMAP.md §8, Stage 6.1).
 *
 * This suite is the reason lib/src/opendata/schema.ts exists as a catalogue
 * instead of as four route handlers. It does not test three endpoints somebody
 * remembered to list here; it enumerates EXPORT_DATASETS, which is the only
 * path from a column in the database to a file on the internet. A dataset added
 * next year is scanned by these tests on the day it is added, by an author who
 * does not have to know this file exists.
 *
 * The guards are layered, weakest to strongest:
 *
 *   1. Field NAMES may not contain a person-bearing token.
 *   2. Field SQL may not contain one either — a column can be aliased to
 *      something innocent, and the alias is what layer 1 sees.
 *   3. Every relation read must be on an ALLOWLIST. This is the strong one:
 *      layers 1 and 2 catch names somebody chose, this catches the table
 *      whatever its columns are called, including tables that do not exist yet.
 *   4. No field may have a type that can hide data from review (jsonb).
 *   5. The facility export must carry the public map's own visibility
 *      predicate, so a download can never contain a row the site would not show.
 *
 * db/src/opendata.test.ts adds the sixth, which only a database can make: run
 * every dataset and assert the columns that come back are exactly the columns
 * declared here.
 */

/**
 * Every field in the catalogue, tagged with the dataset it came from and with a
 * flat `label`. The label matters: vitest's `$a.b` title interpolation does not
 * reach nested properties, so titling these cases `$dataset.id` prints
 * "undefined" and a real failure tells you a field is dirty without telling you
 * WHICH field. A denylist whose failure message is unreadable gets muted.
 */
function allFields(): {
  label: string;
  dataset: ExportDataset;
  field: ExportDataset['fields'][number];
}[] {
  return EXPORT_DATASETS.flatMap((dataset) =>
    dataset.fields.map((field) => ({ label: `${dataset.id}.${field.name}`, dataset, field })),
  );
}

describe('open-data catalogue: the denylist cannot pass vacuously', () => {
  // A denylist suite that iterates an empty array is green and worthless. This
  // is the test that fails first if the catalogue is ever emptied, renamed or
  // accidentally shadowed by a bad import.
  it('has datasets, and every dataset has fields', () => {
    expect(EXPORT_DATASETS.length).toBeGreaterThan(0);
    for (const dataset of EXPORT_DATASETS) {
      expect(dataset.fields.length, `${dataset.id} has no fields`).toBeGreaterThan(0);
    }
    expect(allFields().length).toBeGreaterThan(10);
  });

  it('recognises a person-bearing token when it sees one', () => {
    // Proves the matcher works, so a green run above means "clean" rather than
    // "the matcher silently returns nothing".
    expect(deniedTokensIn('uploaded_by')).toContain('uploaded');
    expect(deniedTokensIn('u.email')).toContain('email');
    expect(deniedTokensIn('p.organizer_id')).toContain('organizer');
    expect(deniedTokensIn('c.recorded_by')).toContain('recorded');
    expect(deniedTokensIn('users.public_handle')).toEqual(
      expect.arrayContaining(['users', 'handle']),
    );
  });

  it('matches whole tokens, not substrings — "municipality" is not "ip"', () => {
    // The bug this guards against would have rejected the most important column
    // in the dataset while appearing to work perfectly.
    expect(DENIED_IDENTIFIERS).toContain('ip');
    expect(deniedTokensIn('m.name_bg AS municipality')).toEqual([]);
    expect(identifierTokens('municipality_ekatte')).toEqual(['municipality', 'ekatte']);
    // ...but a column actually called `ip` is still caught.
    expect(deniedTokensIn('s.ip_address')).toContain('ip');
  });

  it('dataset ids and field names are unique', () => {
    const ids = EXPORT_DATASETS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const dataset of EXPORT_DATASETS) {
      const names = dataset.fields.map((f) => f.name);
      expect(new Set(names).size, `${dataset.id} has duplicate field names`).toBe(names.length);
    }
  });
});

describe('open-data catalogue: no exported field can name a person', () => {
  it.each(allFields())('$label — field name is clean', ({ field }) => {
    expect(deniedTokensIn(field.name)).toEqual([]);
  });

  it.each(allFields())('$label — SQL expression is clean', ({ field }) => {
    // Layer 2: `SELECT u.email AS contact` passes layer 1 and dies here.
    expect(deniedTokensIn(field.sql)).toEqual([]);
  });

  it.each(EXPORT_DATASETS)('$id — FROM, WHERE and ORDER BY are clean', (dataset) => {
    expect(deniedTokensIn(dataset.from)).toEqual([]);
    expect(deniedTokensIn(dataset.where ?? '')).toEqual([]);
    expect(deniedTokensIn(dataset.orderBy)).toEqual([]);
  });
});

describe('open-data catalogue: only allowlisted relations are readable', () => {
  it.each(EXPORT_DATASETS)('$id reads only allowlisted relations', (dataset) => {
    const relations = relationsIn(dataset.from);
    expect(relations.length, `${dataset.id}: no relation parsed from FROM`).toBeGreaterThan(0);
    for (const relation of relations) {
      expect(ALLOWED_RELATIONS as readonly string[], `${dataset.id} reads ${relation}`).toContain(
        relation,
      );
    }
  });

  it('the allowlist contains no table that can resolve to a person', () => {
    // Read the other way round: if somebody widens ALLOWED_RELATIONS to add
    // `users` or a play table, this fails before any field is even written.
    for (const relation of ALLOWED_RELATIONS) {
      expect(deniedTokensIn(relation), `${relation} is on the allowlist`).toEqual([]);
    }
  });
});

describe('open-data catalogue: no field can hide data from review', () => {
  it.each(allFields())('$label — declares a reviewable type', ({ field }) => {
    // jsonb is the one that matters: facilities.attrs is an open bag of OSM
    // tags, and OSM tags include contact:phone, contact:email and operator. No
    // field-level review can see inside a jsonb column, so the rule is that the
    // type is not exportable at all.
    for (const forbidden of FORBIDDEN_TYPES) {
      expect(identifierTokens(field.sql), `${field.name} casts to ${forbidden}`).not.toContain(
        forbidden,
      );
      expect(field.type as string).not.toBe(forbidden);
    }
  });

  it.each(allFields())('$label — SQL is a safe constant fragment', ({ field }) => {
    expect(() => {
      assertSafeFragment(field.sql, field.name);
    }).not.toThrow();
    // No star: the SELECT list must be the declared fields and nothing else.
    expect(field.sql).not.toContain('*');
  });

  it.each(allFields())('$label — enums declare a vocabulary', ({ field }) => {
    if (field.type === 'enum' || field.type === 'enum_list') {
      expect(field.vocabulary, `${field.name} is an enum with no vocabulary`).toBeDefined();
      expect(field.vocabulary?.length ?? 0).toBeGreaterThan(0);
    } else {
      expect(field.vocabulary, `${field.name} declares a vocabulary it cannot use`).toBeUndefined();
    }
  });

  it.each(allFields())('$label — documents itself', ({ field }) => {
    // The /danni field tables render from descriptionKey, so a field cannot be
    // exported undocumented. apps/web/tests/opendata.test.ts checks the key
    // actually resolves in both catalogues.
    expect(field.descriptionKey.length).toBeGreaterThan(0);
    expect(field.descriptionKey).not.toContain('.');
  });
});

describe('open-data catalogue: the export cannot out-publish the map', () => {
  it('the facility export carries the public map visibility predicate', () => {
    const facilities = EXPORT_DATASETS.find((d) => d.id === 'facilities');
    expect(facilities).toBeDefined();
    expect(facilities?.where).toBe(PUBLIC_FACILITY_PREDICATE);
    // Both halves stated explicitly, so a rewrite that drops one is visible
    // here rather than three months later in a download.
    expect(PUBLIC_FACILITY_PREDICATE).toContain("status <> 'gone'");
    expect(PUBLIC_FACILITY_PREDICATE).toContain('slug IS NOT NULL');
  });

  it('every geojson dataset declares a geometry, and only those do', () => {
    for (const dataset of EXPORT_DATASETS) {
      const emitsGeoJSON = dataset.formats.includes('geojson');
      expect(Boolean(dataset.geometry), `${dataset.id} geometry/format mismatch`).toBe(
        emitsGeoJSON,
      );
      if (!dataset.geometry) continue;
      for (const name of [dataset.geometry.lon, dataset.geometry.lat]) {
        const field = dataset.fields.find((f) => f.name === name);
        expect(field, `${dataset.id} geometry names missing field ${name}`).toBeDefined();
        expect(field?.type).toBe('coordinate');
      }
    }
  });
});

describe('open-data serializers publish declared fields and nothing else', () => {
  /**
   * A row carrying columns the catalogue does not declare — which is what a
   * hand-edited query, a `SELECT *`, or a view that grew a column would hand
   * back. The serializers must drop every one of them.
   */
  function pollutedRow(dataset: ExportDataset): Record<string, unknown> {
    const row: Record<string, unknown> = {
      email: 'someone@example.org',
      user_id: 'usr_123',
      uploaded_by: 'usr_456',
      attrs: { 'contact:phone': '+359888123456' },
    };
    for (const field of dataset.fields) {
      row[field.name] =
        field.type === 'enum_list'
          ? [field.vocabulary?.[0] ?? 'x']
          : field.type === 'coordinate'
            ? 23.321589123456789
            : field.type === 'boolean'
              ? true
              : field.type === 'integer' || field.type === 'number'
                ? 7
                : field.type === 'timestamp'
                  ? new Date('2026-07-23T05:00:00.000Z')
                  : (field.vocabulary?.[0] ?? 'value');
    }
    return row;
  }

  it.each(EXPORT_DATASETS)('$id — CSV header is exactly the declared fields', (dataset) => {
    const csv = serializeCsv(dataset, [pollutedRow(dataset)]);
    const header = csv.replace(/^\uFEFF/, '').split('\r\n')[0] ?? '';
    expect(header.split(',').map((c) => c.replaceAll('"', ''))).toEqual(
      dataset.fields.map((f) => f.name),
    );
    for (const leaked of ['email', 'user_id', 'uploaded_by', 'someone@example.org', '+359888']) {
      expect(csv, `${dataset.id} CSV leaked ${leaked}`).not.toContain(leaked);
    }
  });

  it.each(EXPORT_DATASETS)('$id — JSON/GeoJSON properties are the declared fields', (dataset) => {
    const row = pollutedRow(dataset);
    const serialized = dataset.geometry
      ? JSON.stringify(serializeGeoJSON(dataset, [row]))
      : JSON.stringify(serializeJson(dataset, [row]));
    for (const leaked of ['email', 'user_id', 'uploaded_by', 'someone@example.org', 'contact:']) {
      expect(serialized, `${dataset.id} leaked ${leaked}`).not.toContain(leaked);
    }
  });

  it('GeoJSON moves the coordinates out of properties into the geometry', () => {
    const facilities = EXPORT_DATASETS.find((d) => d.id === 'facilities');
    if (!facilities?.geometry) throw new Error('facilities dataset lost its geometry');
    const collection = serializeGeoJSON(facilities, [pollutedRow(facilities)]);
    const feature = collection.features[0];
    expect(feature?.geometry?.coordinates).toEqual([23.321589, 23.321589]);
    expect(feature?.properties).not.toHaveProperty('longitude');
    expect(feature?.properties).not.toHaveProperty('latitude');
  });
});

describe('open-data serializers always state the licence', () => {
  const facilities = EXPORT_DATASETS.find((d) => d.id === 'facilities');
  const stats = EXPORT_DATASETS.find((d) => d.id === 'stats-sports');

  it('GeoJSON carries the ODbL and the attribution', () => {
    if (!facilities) throw new Error('facilities dataset missing');
    const collection = serializeGeoJSON(facilities, []);
    expect(collection.license).toBe('ODbL-1.0');
    expect(collection.attribution).toBe('© OpenStreetMap contributors + POPS community');
  });

  it('JSON carries the ODbL and the attribution', () => {
    if (!stats) throw new Error('stats-sports dataset missing');
    const json = serializeJson(stats, []);
    expect(json.license).toBe('ODbL-1.0');
    expect(json.attribution).toBe('© OpenStreetMap contributors + POPS community');
  });

  it('CSV is left parseable, with the licence carried out of band', () => {
    // The deliberate exception, stated as a test so nobody "fixes" it by
    // prepending a comment line that breaks every parser in the country.
    if (!stats) throw new Error('stats-sports dataset missing');
    const csv = serializeCsv(stats, []);
    expect(csv.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe('sport,total');
    expect(csv).not.toContain('OpenStreetMap');
  });
});
