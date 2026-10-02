import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * db/data/population.csv is the denominator of every "per 10,000 residents"
 * figure the site publishes (/statistika, /obshtina/[city] and the embeddable
 * widget a municipality puts on its own site). It held five municipalities
 * until 2026-09-30, so 260 of 265 pages printed "no data" — and four of the
 * five figures were not the census count. This pins the file to the census:
 * every register municipality present exactly once, nothing else, and the
 * totals equal to NSI's own published totals.
 *
 * The totals come from a DIFFERENT NSI publication than the per-municipality
 * table the file was built from — the final-results press release, «Население
 * към 7 септември 2021 година. Окончателни данни» (nsi.bg, Census2021_population
 * .pdf), table «Прираст на населението по области». A typo, a transposed row or
 * a figure from another year shifts one of the 28 region sums, so the file
 * cannot drift from the census without this failing. Pure file check: no
 * database needed.
 */

const NATIONAL_TOTAL = 6_519_789;

/** Population on 7.09.2021 by region (област), keyed by EKATTE region prefix. */
const REGION_TOTALS: Record<string, number> = {
  BLG: 292_227, // Благоевград
  BGS: 380_286, // Бургас
  VAR: 432_198, // Варна
  VTR: 207_371, // Велико Търново
  VID: 75_408, // Видин
  VRC: 152_813, // Враца
  GAB: 98_387, // Габрово
  DOB: 150_146, // Добрич
  KRZ: 141_177, // Кърджали
  KNL: 111_736, // Кюстендил
  LOV: 116_394, // Ловеч
  MON: 119_950, // Монтана
  PAZ: 229_814, // Пазарджик
  PER: 114_162, // Перник
  PVN: 226_120, // Плевен
  PDV: 634_497, // Пловдив
  RAZ: 103_223, // Разград
  RSE: 193_483, // Русе
  SLS: 97_770, // Силистра
  SLV: 172_690, // Сливен
  SML: 96_284, // Смолян
  SOF: 1_274_290, // София (столица)
  SFO: 231_989, // София
  SZR: 296_507, // Стара Загора
  TGV: 98_144, // Търговище
  HKV: 211_565, // Хасково
  SHU: 151_465, // Шумен
  JAM: 109_693, // Ямбол
};

function lines(relative: string): string[] {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
    .trim()
    .split(/\r?\n/);
}

const [header, ...rows] = lines('../data/population.csv');
const population = rows.map((line) => {
  const [code = '', value = '', ...rest] = line.split(',');
  return { line, code, value, extra: rest.length };
});
// The importer's register of municipalities — the same codes the
// `municipalities` table is loaded from, so it is what the loader matches.
const register = lines('../../scripts/import-osm/data/ekatte-municipalities.csv')
  .slice(1)
  .map((line) => line.split(',')[0] ?? '');

describe('db/data/population.csv (NSI 2021 census)', () => {
  it('keeps the format the loader reads', () => {
    expect(header).toBe('ekatte_code,population');
    for (const row of population) {
      expect(row.extra, row.line).toBe(0);
      expect(row.code, row.line).toMatch(/^[A-Z]{3}[0-9]{2}$/);
      // A plain positive integer: load-population skips anything else silently.
      expect(row.value, row.line).toMatch(/^[1-9][0-9]*$/);
    }
  });

  it('covers every register municipality exactly once, and nothing else', () => {
    const codes = population.map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(register).toHaveLength(265);
    expect([...codes].sort()).toEqual([...register].sort());
  });

  it('sums to the census totals, nationally and for each of the 28 regions', () => {
    const byRegion: Record<string, number> = {};
    let national = 0;
    for (const row of population) {
      const value = Number(row.value);
      national += value;
      const region = row.code.slice(0, 3);
      byRegion[region] = (byRegion[region] ?? 0) + value;
    }
    expect(national).toBe(NATIONAL_TOTAL);
    expect(byRegion).toEqual(REGION_TOTALS);
  });
});
