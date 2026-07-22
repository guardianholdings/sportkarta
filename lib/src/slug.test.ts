import { describe, expect, it } from 'vitest';

import { facilitySlug, resolveSlugCollision, slugify, transliterateBg } from './slug.js';

// The Bulgarian alphabet, each letter → its Streamlined-System rendering
// (Transliteration Law, 2009). Digraphs (zh, ts, ch, sh, sht, yu, ya) and the
// special letters (ъ→a, ь→y, й→y) are the ones most likely to regress.
const LETTER_TABLE: [string, string][] = [
  ['а', 'a'],
  ['б', 'b'],
  ['в', 'v'],
  ['г', 'g'],
  ['д', 'd'],
  ['е', 'e'],
  ['ж', 'zh'],
  ['з', 'z'],
  ['и', 'i'],
  ['й', 'y'],
  ['к', 'k'],
  ['л', 'l'],
  ['м', 'm'],
  ['н', 'n'],
  ['о', 'o'],
  ['п', 'p'],
  ['р', 'r'],
  ['с', 's'],
  ['т', 't'],
  ['у', 'u'],
  ['ф', 'f'],
  ['х', 'h'],
  ['ц', 'ts'],
  ['ч', 'ch'],
  ['ш', 'sh'],
  ['щ', 'sht'],
  ['ъ', 'a'],
  ['ь', 'y'],
  ['ю', 'yu'],
  ['я', 'ya'],
];

describe('transliterateBg — every Bulgarian letter', () => {
  it.each(LETTER_TABLE)('%s → %s', (cyr, latin) => {
    // Wrap in a consonant so the word-final "ия" rule can't interfere.
    expect(transliterateBg(`${cyr}т`)).toBe(`${latin}t`);
  });

  it('maps uppercase identically (slugs lowercase first)', () => {
    for (const [cyr, latin] of LETTER_TABLE) {
      expect(transliterateBg(`${cyr.toUpperCase()}т`)).toBe(`${latin}t`);
    }
  });

  it('passes Latin letters through unchanged', () => {
    expect(transliterateBg('bmx park')).toBe('bmx park');
  });
});

describe('word-final "ия" → "ia" exception', () => {
  it.each([
    ['София', 'sofia'],
    // ъ→a per the Streamlined System (the "Bulgaria" spelling is a separate
    // hard-coded country-name exception in the law, not a general rule).
    ['България', 'balgaria'],
    ['Пловдив', 'plovdiv'],
    ['Варна', 'varna'],
    ['Мария', 'maria'],
    ['гимназия', 'gimnazia'],
  ])('%s → %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('keeps a medial "ия" as "iya"', () => {
    expect(slugify('Диян')).toBe('diyan');
    // "ия" not at the word end stays literal.
    expect(slugify('сиянието')).toBe('siyanieto');
  });
});

describe('slugify — real facility names', () => {
  it.each([
    ['Футболно игрище – парк „Гео Милев“', 'futbolno-igrishte-park-geo-milev'],
    ['Стрийтбол игрища – Борисова градина', 'striytbol-igrishta-borisova-gradina'],
    ['Тенис на маса – парк „Заимов“', 'tenis-na-masa-park-zaimov'],
    ['Фитнес на открито – Южен парк', 'fitnes-na-otkrito-yuzhen-park'],
    ['BMX парк', 'bmx-park'],
    ['Игрище №3', 'igrishte-3'],
  ])('%s → %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('collapses punctuation and trims separators', () => {
    expect(slugify('  ***  Спорт!!!  ***  ')).toBe('sport');
    expect(slugify('--a--b--')).toBe('a-b');
  });

  it('strips Latin diacritics', () => {
    expect(slugify('Café Sport')).toBe('cafe-sport');
  });

  it('returns "" when nothing usable remains', () => {
    expect(slugify('   ')).toBe('');
    expect(slugify('—–—')).toBe('');
    expect(slugify('...')).toBe('');
  });

  it('is idempotent — slugging a slug is a no-op (stability)', () => {
    const once = slugify('Футболно игрище – парк „Гео Милев“');
    expect(slugify(once)).toBe(once);
  });

  it('is deterministic — same input, same output', () => {
    expect(slugify('София парк')).toBe(slugify('София парк'));
  });

  it('truncates at a word boundary within the max length', () => {
    const long = 'дума '.repeat(40).trim(); // "duma duma …" well over 80 chars
    const out = slugify(long);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(out.endsWith('-')).toBe(false);
    expect(out.startsWith('duma')).toBe(true);
  });

  it('hard-cuts a single word longer than the max', () => {
    const out = slugify('a'.repeat(120));
    expect(out.length).toBe(80);
    expect(out).toBe('a'.repeat(80));
  });
});

describe('resolveSlugCollision', () => {
  it('returns the base when it is free', () => {
    expect(resolveSlugCollision('geo-milev', () => false)).toBe('geo-milev');
  });

  it('suffixes -2, -3, … past taken slugs', () => {
    const taken = new Set(['park', 'park-2', 'park-3']);
    expect(resolveSlugCollision('park', (c) => taken.has(c))).toBe('park-4');
  });

  it('every output in a batch is unique and stable', () => {
    const taken = new Set<string>();
    const names = ['Спорт', 'Спорт', 'Спорт', 'спорт!'];
    const slugs = names.map((n) => {
      const s = resolveSlugCollision(slugify(n), (c) => taken.has(c));
      taken.add(s);
      return s;
    });
    expect(slugs).toEqual(['sport', 'sport-2', 'sport-3', 'sport-4']);
    expect(new Set(slugs).size).toBe(slugs.length);
  });
});

describe('facilitySlug — name + fallback + collisions', () => {
  it('slugs the name when present', () => {
    expect(facilitySlug('Южен парк', 'abc123', () => false)).toBe('yuzhen-park');
  });

  it('falls back when the name is null or unusable', () => {
    expect(facilitySlug(null, 'a1b2c3d4', () => false)).toBe('a1b2c3d4');
    expect(facilitySlug('№№№', 'a1b2c3d4', () => false)).toBe('a1b2c3d4');
  });

  it('uses the "obekt" fallback only when both name and fallback are empty', () => {
    expect(facilitySlug('', '', () => false)).toBe('obekt');
  });

  it('resolves collisions against the taken set', () => {
    const taken = new Set(['yuzhen-park']);
    expect(facilitySlug('Южен парк', 'x', (c) => taken.has(c))).toBe('yuzhen-park-2');
  });

  it('every produced slug matches the DB slug format', () => {
    const format = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const name of ['София', 'BMX парк', 'Игрище №3', 'Café']) {
      expect(facilitySlug(name, 'fallback', () => false)).toMatch(format);
    }
  });
});
