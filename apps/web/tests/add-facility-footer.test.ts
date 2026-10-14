import { describe, expect, it } from 'vitest';

import { appearsOnMapNow } from '../lib/contributions/map-note';
import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * B, contradiction (c) (CEO 2026-10-11 12:16): picking «Платено» showed
 * paidHiddenHint («…там няма да се вижда») right above «Новото съоръжение се
 * появява на картата веднага…». The note is split in two with no wording
 * change, the ODbL sentence word for word, and the map sentence follows the
 * same rule as the hint, so the two can never disagree.
 */
const MAIN_NOTE = {
  bg: 'Новото съоръжение се появява на картата веднага — още преди друг потребител или модератор да го е проверил. Данните стават част от отворените данни под лиценз ODbL (вижте Общите условия).',
  en: 'The new facility appears on the map straight away — before another member or a moderator has checked it. The data becomes part of the open data under the ODbL licence (see the Terms of use).',
};

/** Ruling (a): main's text as it is; only „пишете ни“ becomes a link. */
const MAIN_HIDDEN_DUPLICATE = {
  bg: 'На това място вече е записано съоръжение за същия спорт, което не се показва публично (например платено). Ако то всъщност е безплатно, пишете ни.',
  en: 'A facility for the same sport is already recorded here but is not shown publicly (for example, a paid one). If it is actually free, write to us.',
};

const ADD = { bg: bg.AddFacility, en: en.AddFacility } as Record<
  'bg' | 'en',
  Record<string, string>
>;

describe('the add form footer (B, ruling (c))', () => {
  for (const locale of ['bg', 'en'] as const) {
    it(`${locale}: the two halves are main's note, word for word, and the old key is gone`, () => {
      const messages = ADD[locale];
      expect(`${messages.moderationNoteMap} ${messages.moderationNoteData}`).toBe(
        MAIN_NOTE[locale],
      );
      expect(messages).not.toHaveProperty('moderationNote');
    });
  }

  it('drops the map sentence exactly when the hint says the place will not be on the map', () => {
    expect(appearsOnMapNow('free', true)).toBe(true);
    expect(appearsOnMapNow('restricted', true)).toBe(true);
    expect(appearsOnMapNow('school', true)).toBe(true);
    expect(appearsOnMapNow('paid', true)).toBe(false);
    // While paid venues are shown, a paid place does appear straight away.
    expect(appearsOnMapNow('paid', false)).toBe(true);
  });
});

describe('„пишете ни“ links to the contact page (B, ruling (a))', () => {
  for (const locale of ['bg', 'en'] as const) {
    it(`${locale}: main's text word for word, with one <contact> link`, () => {
      const text = ADD[locale].error_duplicate_hidden ?? '';
      expect(text.replace(/<\/?contact>/g, '')).toBe(MAIN_HIDDEN_DUPLICATE[locale]);
      expect(text.match(/<contact>/g)).toHaveLength(1);
    });
  }

  it('wraps exactly the words of the invitation', () => {
    expect(ADD.bg.error_duplicate_hidden).toContain('<contact>пишете ни</contact>.');
    expect(ADD.en.error_duplicate_hidden).toContain('<contact>write to us</contact>.');
  });
});
