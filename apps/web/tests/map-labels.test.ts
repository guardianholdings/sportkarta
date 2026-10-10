import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import {
  facilitySearchText,
  facilitySubtitle,
  facilityTitle,
  type LabelStrings,
} from '../components/map/facility-label';
import { formatKm, placeLabel } from '../lib/geo';
import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * How the map names a facility. 91% of the corpus has no name, and every
 * surface used to print the same «Спортно съоръжение» for all of them — the
 * list, the preview, the pin's accessible name — while search could not find
 * them at all. These pin the replacement against the REAL catalogues, so a
 * message edit that breaks the fallback fails here rather than on the map.
 */

function strings(locale: 'bg' | 'en'): LabelStrings {
  const messages = locale === 'bg' ? bg : en;
  const tFacility = createTranslator({ locale, messages, namespace: 'Facility' });
  const tSport = createTranslator({ locale, messages, namespace: 'Sport' });
  return {
    locale,
    unnamed: tFacility('unnamed'),
    sport: (sport) => tSport(sport as 'football'),
    unnamedAt: (what, place) => tFacility('unnamedAt', { what, place }),
  };
}

const BG = strings('bg');
const EN = strings('en');

describe('facilityTitle', () => {
  it('uses the facility’s own name whenever it has one', () => {
    expect(
      facilityTitle({ name: 'Борисова градина', sports: ['football'], place: 'София' }, BG),
    ).toBe('Борисова градина');
  });

  it('describes an unnamed facility by its primary sport and where it is', () => {
    const f = { name: null, sports: ['football', 'basketball'], place: 'Лозенец, София' };
    expect(facilityTitle(f, BG)).toBe('Футбол — Лозенец, София');
    expect(facilityTitle({ ...f, place: 'Sofia' }, EN)).toBe('Football — Sofia');
  });

  it('tells two unnamed facilities in different towns apart', () => {
    const sofia = facilityTitle({ name: null, sports: ['football'], place: 'София' }, BG);
    const varna = facilityTitle({ name: null, sports: ['football'], place: 'Варна' }, BG);
    expect(sofia).not.toBe(varna);
    expect(sofia).not.toBe(BG.unnamed);
  });

  it('falls back to the sport alone, then to the generic noun only when nothing is known', () => {
    expect(facilityTitle({ name: null, sports: ['tennis'] }, BG)).toBe('Тенис');
    expect(facilityTitle({ name: null, sports: [], place: 'Пловдив' }, BG)).toBe(
      'Спортно съоръжение — Пловдив',
    );
    expect(facilityTitle({ name: null, sports: [] }, BG)).toBe('Спортно съоръжение');
  });

  it('treats a blank name or place as absent rather than printing it', () => {
    expect(facilityTitle({ name: '   ', sports: ['chess'], place: '  ' }, BG)).toBe('Шахмат');
  });
});

describe('facilitySubtitle', () => {
  it('lists up to three sports, and the place for a NAMED facility', () => {
    const named = {
      name: 'Парк',
      sports: ['football', 'tennis', 'chess', 'running'],
      place: 'Варна',
    };
    expect(facilitySubtitle(named, BG)).toBe('футбол · тенис · шахмат — Варна');
  });

  it('does not repeat what an unnamed facility’s title already says', () => {
    // The title is «Футбол — Варна»: the line under it must not say «футбол»
    // (or «Варна») again.
    const unnamed = { name: null, sports: ['football'], place: 'Варна' };
    expect(facilityTitle(unnamed, BG)).toBe('Футбол — Варна');
    expect(facilitySubtitle(unnamed, BG)).toBe('');
    // Without a place (the /igrishta lists): «Тенис» over «тенис» was the bug.
    expect(facilitySubtitle({ name: null, sports: ['tennis'] }, BG)).toBe('');
  });

  it('lists an unnamed facility’s OTHER sports, up to three', () => {
    const f = {
      name: null,
      sports: ['football', 'basketball', 'volleyball', 'tennis', 'chess'],
      place: 'Русе',
    };
    expect(facilitySubtitle(f, BG)).toBe('баскетбол · волейбол · тенис');
  });

  it('is empty when there is nothing to add', () => {
    expect(facilitySubtitle({ name: null, sports: [] }, BG)).toBe('');
  });
});

describe('facilitySearchText', () => {
  it('lets a search find an unnamed facility by its place or its sport', () => {
    const text = facilitySearchText(
      { name: null, sports: ['basketball'], place: 'Младост, София' },
      BG,
    );
    expect(text).toContain('младост');
    expect(text).toContain('баскетбол');
  });

  it('still matches on the name, case-insensitively', () => {
    expect(facilitySearchText({ name: 'Борисова градина', sports: [], place: null }, BG)).toContain(
      'борисова',
    );
  });
});

describe('placeLabel', () => {
  it('joins the quarter and the municipality', () => {
    expect(placeLabel('Лозенец', 'София')).toBe('Лозенец, София');
  });

  it('prints a quarter that repeats the municipality once', () => {
    expect(placeLabel('Варна', 'варна')).toBe('Варна');
  });

  it('uses whichever part is known, and null when neither is', () => {
    expect(placeLabel(null, 'Пловдив')).toBe('Пловдив');
    expect(placeLabel('Център', null)).toBe('Център');
    expect(placeLabel(' ', undefined)).toBeNull();
  });
});

describe('formatKm', () => {
  it('uses the reader’s decimal separator', () => {
    expect(formatKm(0.42, 'bg')).toBe('0,4');
    expect(formatKm(0.42, 'en')).toBe('0.4');
  });

  it('keeps one decimal under 10 km and whole km above', () => {
    expect(formatKm(3, 'bg')).toBe('3,0');
    expect(formatKm(12.6, 'en')).toBe('13');
  });

  it('is wrapped in a unit by the catalogue, not left bare', () => {
    const tBg = createTranslator({ locale: 'bg', messages: bg, namespace: 'Map' });
    const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'Map' });
    expect(tBg('distanceKm', { km: formatKm(0.42, 'bg') })).toBe('на 0,4 км');
    expect(tEn('distanceKm', { km: formatKm(0.42, 'en') })).toBe('0.4 km away');
  });
});

describe('map count and cluster copy', () => {
  const tBg = createTranslator({ locale: 'bg', messages: bg, namespace: 'Map' });
  const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'Map' });

  it('agrees with its number', () => {
    expect(tBg('resultsCount', { count: 1 })).toBe('1 съоръжение');
    expect(tBg('resultsCount', { count: 2 })).toBe('2 съоръжения');
    expect(tEn('resultsCount', { count: 1 })).toBe('1 facility');
    // The filter sheet's button counts the same set, so a search narrowed to
    // one place no longer reads «Покажи 1 съоръжения».
    expect(tBg('showCount', { count: 1 })).toBe('Покажи 1 съоръжение');
    expect(tBg('showCount', { count: 7 })).toBe('Покажи 7 съоръжения');
    expect(tEn('showCount', { count: 1 })).toBe('Show 1 facility');
  });

  it('offers no «Покажи 0 съоръжения» — it says there is nothing', () => {
    expect(tBg('showCount', { count: 0 })).toBe('Няма съвпадения');
    expect(tEn('showCount', { count: 0 })).toBe('No matches');
  });

  it('names a cluster by its count, so a screen reader can announce it', () => {
    expect(tBg('clusterLabel', { count: 23 })).toBe('23 съоръжения — приближи');
    expect(tEn('clusterLabel', { count: 1 })).toBe('1 facility — zoom in');
  });
});
