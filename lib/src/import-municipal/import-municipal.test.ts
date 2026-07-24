import { describe, expect, it } from 'vitest';

import {
  CANDIDATE_M,
  CLOSE_M,
  classify,
  namesMatch,
  normalizeName,
  type NearbyCandidate,
} from './dedupe.js';
import { normalizeRow, type RawRow } from './normalize.js';

/**
 * The pure half of the municipal importer (Stage 6.3): row normalisation and
 * the new/match/conflict decision. The database half — that a commit writes
 * source=municipal through the merge policy, freezing crowd fields — is in
 * db/src/import-municipal.test.ts, because only a database can make it.
 */

function row(over: Partial<RawRow>): RawRow {
  return {
    rowNumber: 2,
    name: 'Тестова площадка',
    sport: 'football',
    access: 'свободен',
    lon: '23.32',
    lat: '42.70',
    ...over,
  };
}

describe('normalizeRow', () => {
  it('accepts a well-formed Bulgarian row', () => {
    const out = normalizeRow(
      row({ sport: 'football, basketball', surface: 'asphalt', lighting: 'да', covered: 'не' }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.row.sportTypes).toEqual(['basketball', 'football']); // canonical order
    expect(out.row.access).toBe('free');
    expect(out.row.lighting).toBe(true);
    expect(out.row.covered).toBe(false);
    expect(out.row.lon).toBe(23.32);
  });

  it('reads access in Bulgarian or English', () => {
    for (const [cell, value] of [
      ['платен', 'paid'],
      ['paid', 'paid'],
      ['училищен', 'school'],
      ['ограничен', 'restricted'],
    ] as const) {
      const out = normalizeRow(row({ access: cell }));
      expect(out.ok && out.row.access).toBe(value);
    }
  });

  it('treats an empty lighting cell as unknown, not false', () => {
    // "we do not know" and "there is none" are different facts about a pitch.
    const out = normalizeRow(row({ lighting: '' }));
    expect(out.ok && out.row.lighting).toBeNull();
  });

  it('rejects an unrecognised lighting word rather than reading it as unknown', () => {
    // An unknown word means the column was mapped wrong; swallowing it as null
    // would hide that from the operator.
    expect(normalizeRow(row({ lighting: 'понякога' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_lighting' },
    });
  });

  it('rejects a row it cannot place on the map', () => {
    // A facility has a NOT NULL geom; a registry row without coordinates is not
    // importable, and geocoding an address is out of scope.
    expect(normalizeRow(row({ lon: '', lat: '' }))).toMatchObject({
      ok: false,
      error: { code: 'coordinates_required' },
    });
    expect(normalizeRow(row({ lon: 'n/a' }))).toMatchObject({
      ok: false,
      error: { code: 'coordinates_required' },
    });
  });

  it('rejects coordinates outside Bulgaria before they can hit the CHECK', () => {
    expect(normalizeRow(row({ lon: '2.35', lat: '48.85' }))).toMatchObject({
      ok: false,
      error: { code: 'outside_bulgaria' },
    });
  });

  it('accepts a comma decimal separator', () => {
    // Bulgarian spreadsheets on a comma-locale write "23,32".
    const out = normalizeRow(row({ lon: '23,32', lat: '42,70' }));
    expect(out.ok && out.row.lon).toBe(23.32);
  });

  it('rejects an unknown sport rather than silently dropping it', () => {
    expect(normalizeRow(row({ sport: 'football, quidditch' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_sport' },
    });
  });

  it('reads sports in Bulgarian or English, mixed in one cell (AUDIT-F3)', () => {
    // The one column a Bulgarian registry will always write in Bulgarian.
    const out = normalizeRow(row({ sport: 'футбол; баскетбол, tennis' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.row.sportTypes).toEqual(['basketball', 'football', 'tennis']); // canonical order
  });

  it('canonicalises multi-word Bulgarian sport names', () => {
    for (const [cell, value] of [
      ['тенис на маса', 'table_tennis'],
      ['Лека атлетика', 'athletics'],
      ['плажен волейбол', 'beach_volleyball'],
      ['стрелба с лък', 'archery'],
      ['басейн', 'swimming'],
    ] as const) {
      const out = normalizeRow(row({ sport: cell }));
      expect(out.ok && out.row.sportTypes, cell).toEqual([value]);
    }
  });

  it('dedupes when an alias and its canonical name appear together', () => {
    const out = normalizeRow(row({ sport: 'футбол, football' }));
    expect(out.ok && out.row.sportTypes).toEqual(['football']);
  });

  it('still rejects a Bulgarian word that is not an alias', () => {
    // Ambiguous words are deliberately absent from the alias table: a visible
    // per-row error beats a silent wrong sport on the map.
    expect(normalizeRow(row({ sport: 'крикет' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_sport' },
    });
  });

  it('allows an empty sports list (a multi-use ground)', () => {
    const out = normalizeRow(row({ sport: '' }));
    expect(out.ok && out.row.sportTypes).toEqual([]);
  });

  it('requires access — an unmapped access column is an error, not a default', () => {
    expect(normalizeRow(row({ access: '' }))).toMatchObject({
      ok: false,
      error: { code: 'access_required' },
    });
  });

  it('rejects a surface outside the canonical vocabulary', () => {
    expect(normalizeRow(row({ surface: 'мрамор' }))).toMatchObject({
      ok: false,
      error: { code: 'invalid_surface' },
    });
  });

  it('is stable: normalising twice yields identical managed fields', () => {
    // The property re-imports rely on — an unchanged registry must produce a
    // byte-identical row so the merge policy sees "unchanged", not a rewrite.
    const first = normalizeRow(row({ sport: 'basketball, football', lon: '23,3200000' }));
    const second = normalizeRow(row({ sport: 'football, basketball', lon: '23.32' }));
    expect(first.ok && second.ok && JSON.stringify(first.row) === JSON.stringify(second.row)).toBe(
      true,
    );
  });
});

describe('normalizeName / namesMatch', () => {
  it('folds casing, punctuation and whitespace', () => {
    expect(normalizeName('Спортен  Комплекс — "Раковски"!')).toBe('спортен комплекс раковски');
  });

  it('matches identical and subset names, not a single shared token', () => {
    expect(namesMatch('Спортен комплекс Раковски', 'спортен комплекс раковски')).toBe(true);
    // Fuller registry name vs short map label.
    expect(namesMatch('Спортен комплекс Раковски', 'Комплекс Раковски')).toBe(true);
    // One town's "Градски стадион" is not another's.
    expect(namesMatch('Градски стадион Изток', 'Градски стадион Запад')).toBe(false);
    expect(namesMatch('Раковски', 'Левски')).toBe(false);
  });

  it('a blank name never matches', () => {
    expect(namesMatch('', 'нещо')).toBe(false);
    expect(namesMatch(null, null)).toBe(false);
  });
});

describe('classify', () => {
  const near = (over: Partial<NearbyCandidate>): NearbyCandidate => ({
    facilityId: 'f1',
    name: 'Тестова площадка',
    slug: 'test',
    distanceM: 10,
    ...over,
  });

  it('no nearby candidate → new', () => {
    expect(classify('Нова', [])).toEqual({ kind: 'new' });
    expect(classify('Нова', [near({ distanceM: CANDIDATE_M + 50 })])).toEqual({ kind: 'new' });
  });

  it('one close candidate with a matching name → match', () => {
    const c = near({ name: 'Тестова площадка', distanceM: 12 });
    expect(classify('Тестова площадка', [c])).toEqual({ kind: 'match', candidate: c });
  });

  it('one close candidate with a different name → conflict (same spot, renamed)', () => {
    const result = classify('Съвсем друго име', [near({ name: 'Старо име', distanceM: 8 })]);
    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') expect(result.reason).toBe('same_spot_different_name');
  });

  it('two candidates on the same spot → conflict (ambiguous), never a guess', () => {
    const result = classify('Каквото и да е', [
      near({ facilityId: 'a', distanceM: 5 }),
      near({ facilityId: 'b', distanceM: 20 }),
    ]);
    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') {
      expect(result.reason).toBe('ambiguous');
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('a same-named candidate just past CLOSE_M → conflict, not an auto-match', () => {
    const c = near({ name: 'Тестова площадка', distanceM: CLOSE_M + 20 });
    const result = classify('Тестова площадка', [c]);
    expect(result.kind).toBe('conflict');
    if (result.kind === 'conflict') expect(result.reason).toBe('name_match_farther');
  });

  it('a differently-named neighbour within CANDIDATE_M → new (not a duplicate)', () => {
    expect(classify('Нова площадка', [near({ name: 'Съседна', distanceM: 90 })])).toEqual({
      kind: 'new',
    });
  });
});
