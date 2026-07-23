import { describe, expect, it } from 'vitest';

import municipalColumns from '../lib/csv-columns.json';

import {
  guessMunicipalMapping,
  MAX_MUNICIPAL_ROWS,
  MunicipalFileError,
  rowsFromCsv,
} from '@/lib/import/municipal';

/**
 * The web adapter's pure parts (Stage 6.3): header guessing and CSV → mapped
 * rows. The dedupe/merge behaviour is in db/src/import-municipal.test.ts against
 * a real database; the classification and normalisation are in
 * lib/src/import-municipal.
 */

describe('guessMunicipalMapping', () => {
  it('maps Bulgarian and English headers to fields', () => {
    const mapping = guessMunicipalMapping([
      'име',
      'спорт',
      'достъп',
      'настилка',
      'осветление',
      'покрита',
      'квартал',
      'дължина',
      'ширина',
    ]);
    expect(mapping).toEqual({
      name: 0,
      sport: 1,
      access: 2,
      surface: 3,
      lighting: 4,
      covered: 5,
      quarter: 6,
      lon: 7,
      lat: 8,
    });
  });

  it('maps the sample file the template offers', () => {
    const headers = ((municipalColumns.municipalSample as string[])[0] ?? '').split(',');
    const mapping = guessMunicipalMapping(headers);
    // Every column in our own sample must be recognised, or the template is a
    // trap: it looks importable and maps to nothing.
    expect(Object.keys(mapping).sort()).toEqual(
      ['access', 'covered', 'lat', 'lighting', 'lon', 'name', 'quarter', 'sport', 'surface'].sort(),
    );
  });

  it('ignores an unknown header rather than guessing', () => {
    const mapping = guessMunicipalMapping(['име', 'нещо непознато']);
    expect(mapping).toEqual({ name: 0 });
  });
});

describe('rowsFromCsv', () => {
  const mapping = { name: 0, lon: 1, lat: 2 };

  it('numbers rows from 2 (the header is row 1)', () => {
    const rows = rowsFromCsv('name,lon,lat\nA,23.3,42.7\nB,23.4,42.8', mapping);
    expect(rows.map((r) => r.rowNumber)).toEqual([2, 3]);
    expect(rows[0]?.name).toBe('A');
  });

  it('refuses a file with an unterminated quote rather than importing a truncation', () => {
    // A stray quote swallows every following row into one field — the rows we
    // can see are not the rows in the file.
    expect(() => rowsFromCsv('name,lon,lat\n"broken,23.3,42.7\nB,23.4,42.8', mapping)).toThrow(
      MunicipalFileError,
    );
  });

  it('refuses an empty file', () => {
    expect(() => rowsFromCsv('name,lon,lat\n', mapping)).toThrow(MunicipalFileError);
  });

  it('refuses a file over the row cap', () => {
    const body = Array.from({ length: MAX_MUNICIPAL_ROWS + 1 }, (_, i) => `A,23.3,42.${i}`).join(
      '\n',
    );
    expect(() => rowsFromCsv(`name,lon,lat\n${body}`, mapping)).toThrow(/too_many_rows/);
  });

  it('leaves unmapped fields empty', () => {
    const rows = rowsFromCsv('name,lon,lat\nA,23.3,42.7', { name: 0 });
    expect(rows[0]?.lon).toBe('');
    expect(rows[0]?.name).toBe('A');
  });
});
