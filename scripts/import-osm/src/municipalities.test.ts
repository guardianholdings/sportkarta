import { describe, expect, it } from 'vitest';

import {
  loadRegister,
  matchBoundaries,
  normalizeMunicipalityName,
  type BoundaryFeature,
  type RegisterRow,
} from './municipalities.js';

const boundary = (relationId: number, name: string): BoundaryFeature => ({
  relationId,
  name,
  geometryJson: '{"type":"MultiPolygon","coordinates":[]}',
  center: null,
});

const row = (ekatteCode: string, nameBg: string): RegisterRow => ({
  ekatteCode,
  nameBg,
  nameEn: nameBg,
});

describe('normalizeMunicipalityName', () => {
  it('casefolds, strips „община“, unifies dashes', () => {
    expect(normalizeMunicipalityName('Столична община')).toBe('столична');
    expect(normalizeMunicipalityName('Община Марица')).toBe('марица');
    expect(normalizeMunicipalityName('Генерал-Тошево')).toBe('генерал тошево');
    expect(normalizeMunicipalityName('Добрич-селска')).toBe('добрич селска');
  });
});

describe('matchBoundaries', () => {
  const register = [row('AAA01', 'Алфа'), row('BBB01', 'Бяла'), row('CCC01', 'Бяла')];

  it('matches unique normalized names only', () => {
    const r = matchBoundaries([boundary(1, 'Община Алфа')], register, new Map());
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]?.register.ekatteCode).toBe('AAA01');
    expect(r.missingFromOsm.map((m) => m.ekatteCode)).toEqual(['BBB01', 'CCC01']);
  });

  it('flags ambiguous names with candidates — never guesses', () => {
    const r = matchBoundaries([boundary(2, 'Бяла')], register, new Map());
    expect(r.matched).toHaveLength(0);
    expect(r.unmatched[0]?.reason).toBe('ambiguous_name');
    expect(r.unmatched[0]?.candidates).toEqual(['BBB01 (Бяла)', 'CCC01 (Бяла)']);
  });

  it('flags unknown names as no_match', () => {
    const r = matchBoundaries([boundary(3, 'Несъществуваща')], register, new Map());
    expect(r.unmatched[0]?.reason).toBe('no_match');
  });

  it('operator overrides win and disambiguate by relation id', () => {
    const overrides = new Map([
      [2, 'BBB01'],
      [4, 'CCC01'],
    ]);
    const r = matchBoundaries([boundary(2, 'Бяла'), boundary(4, 'Бяла')], register, overrides);
    expect(r.matched.map((m) => m.register.ekatteCode).sort()).toEqual(['BBB01', 'CCC01']);
    expect(r.unmatched).toHaveLength(0);
  });

  it('rejects an override pointing at an unknown code', () => {
    expect(() => matchBoundaries([boundary(9, 'Бяла')], register, new Map([[9, 'NOPE9']]))).toThrow(
      /unknown code/,
    );
  });

  it('flags a second boundary claiming an already-used code', () => {
    const r = matchBoundaries([boundary(1, 'Алфа'), boundary(2, 'Алфа')], register, new Map());
    expect(r.matched).toHaveLength(1);
    expect(r.unmatched[0]?.reason).toBe('duplicate_code');
  });
});

describe('checked-in register CSV', () => {
  it('loads 265 municipalities with unique codes and the known Бяла duplicate', async () => {
    const rows = await loadRegister();
    expect(rows).toHaveLength(265);
    expect(new Set(rows.map((r) => r.ekatteCode)).size).toBe(265);
    const byala = rows.filter((r) => r.nameBg === 'Бяла');
    expect(byala.map((b) => b.ekatteCode).sort()).toEqual(['RSE04', 'VAR05']);
  });
});
