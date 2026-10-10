import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { capitalizeFirst, takesVav } from '../lib/grammar';
import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The SEO landing pages (/igrishta/[city], /igrishta/[city]/[sport]) are the
 * pages meant to rank and be shared, and they read as machine-generated when
 * the grammar slips: „Спортни съоръжения в Варна", „футбол в Брезник". The
 * copy lives in the catalogue; these tests pin the two facts code feeds it.
 */

describe('takesVav — „в" becomes „във" before в/ф', () => {
  it.each(['Варна', 'Велико Търново', 'Видин', 'Враца', 'Велинград', 'Фердинанд', 'варна'])(
    '%s takes „във"',
    (word) => {
      expect(takesVav(word)).toBe('yes');
    },
  );

  it.each(['София', 'Пловдив', 'Бургас', 'Хасково', 'Sofia', 'Varna', ''])(
    '%s keeps „в"',
    (word) => {
      expect(takesVav(word)).toBe('no');
    },
  );
});

describe('capitalizeFirst', () => {
  it('upper-cases only the first letter, in the given locale', () => {
    expect(capitalizeFirst('футбол', 'bg')).toBe('Футбол');
    expect(capitalizeFirst('тенис на маса', 'bg')).toBe('Тенис на маса');
    expect(capitalizeFirst('swimming', 'en')).toBe('Swimming');
    expect(capitalizeFirst('BMX', 'en')).toBe('BMX');
    expect(capitalizeFirst('', 'bg')).toBe('');
  });
});

describe('Places copy with the grammar applied', () => {
  const tBg = createTranslator({ locale: 'bg', messages: bg, namespace: 'Places' });
  const tEn = createTranslator({ locale: 'en', messages: en, namespace: 'Places' });

  it('uses „във" before В-/Ф- cities and „в" otherwise', () => {
    expect(tBg('cityH1', { city: 'Варна', cityVav: takesVav('Варна') })).toBe(
      'Спортни съоръжения във Варна',
    );
    expect(tBg('cityH1', { city: 'София', cityVav: takesVav('София') })).toBe(
      'Спортни съоръжения в София',
    );
    expect(tBg('cityIntro', { city: 'Велико Търново', cityVav: 'yes', count: 12 })).toMatch(
      /^Във Велико Търново има 12 /,
    );
    expect(
      tBg('quarterH1', { quarter: 'Витоша', quarterVav: takesVav('Витоша'), city: 'София' }),
    ).toBe('Спортни съоръжения във Витоша, София');
  });

  it('opens a sport title with a capital letter', () => {
    expect(
      tBg('sportH1', { sport: capitalizeFirst('футбол', 'bg'), city: 'Брезник', cityVav: 'no' }),
    ).toBe('Футбол в Брезник');
    expect(
      tEn('sportH1', { sport: capitalizeFirst('swimming', 'en'), city: 'Bansko', cityVav: 'no' }),
    ).toBe('Swimming in Bansko');
  });

  it('the English catalogue ignores the Bulgarian-only feature', () => {
    expect(tEn('cityH1', { city: 'Varna', cityVav: 'no' })).toBe('Sports facilities in Varna');
  });

  it('no Bulgarian Places string hard-codes „в" in front of a place name', () => {
    // A new key written as „… в {city}" would bring the „в Варна" error back.
    const bare = Object.entries(bg.Places).filter(([, value]) =>
      /(^|\s)[вВ] \{(city|quarter)\}/.test(value),
    );
    expect(bare.map(([key]) => key)).toEqual([]);
  });
});

describe('sport names are catalogue terms, not titles', () => {
  // They sit mid-sentence („места за футбол"); code capitalises where one opens
  // a title. „Пешеходен туризъм" was the one capitalised entry, and it showed.
  it.each([
    ['bg', bg.Sport],
    ['en', en.Sport],
  ] as const)('%s sport labels start lower-case (acronyms aside)', (_locale, sports) => {
    const capitalised = Object.entries(sports).filter(
      ([, label]) => label !== label.toUpperCase() && label[0] !== label[0]?.toLowerCase(),
    );
    expect(capitalised.map(([key]) => key)).toEqual([]);
  });
});

/**
 * The product addresses its reader formally (Вие) everywhere but friend-to-friend
 * share texts. The map and the place pages had slipped into ти — «близо до
 * теб», «Провери връзката и опитай пак», «Бъди първият», «Твоето
 * местоположение» (UX audit 2026-10-10). Short command labels («Опитай пак»,
 * «Виж детайли») are the usual imperative of a button and are left alone; what
 * is pinned is a sentence that speaks to the reader as ти.
 */
describe('the discovery pages address the reader formally', () => {
  const PRONOUN = /(^|[\s(„])(теб|твоят|твоята|твоето|твоите|твоя)(?=$|[\s.,!?)“])/iu;
  const SENTENCE_IMPERATIVE = /[.!?]\s+(Бъди|Провери|Разшири|Разгледай|Виж|Добави|Опитай)\s/u;

  function strings(value: unknown, path: string): [string, string][] {
    if (typeof value === 'string') return [[path, value]];
    if (typeof value !== 'object' || value === null) return [];
    return Object.entries(value).flatMap(([key, child]) => strings(child, `${path}.${key}`));
  }

  it.each(['Map', 'Places', 'Stats', 'Accountability', 'OpenData'] as const)('%s', (ns) => {
    const informal = strings(bg[ns], ns).filter(
      ([, text]) => PRONOUN.test(text) || SENTENCE_IMPERATIVE.test(text),
    );
    expect(informal).toEqual([]);
  });
});
