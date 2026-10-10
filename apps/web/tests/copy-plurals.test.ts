import { readFileSync } from 'node:fs';

import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { takesVav } from '@/lib/grammar';

import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * Numbers in copy read the way the language says them (UX audit 2026-10-10).
 *
 * Rendered through next-intl's own ICU formatter rather than string-compared,
 * so a plural branch that does not parse, or a count that lands in the wrong
 * branch, fails here instead of on somebody's screen.
 */
const bgShare = createTranslator({ locale: 'bg', messages: bg, namespace: 'ShareSheet' });
const enShare = createTranslator({ locale: 'en', messages: en, namespace: 'ShareSheet' });
const bgLeaderboard = createTranslator({ locale: 'bg', messages: bg, namespace: 'Leaderboard' });
const enLeaderboard = createTranslator({ locale: 'en', messages: en, namespace: 'Leaderboard' });

describe('ordinals (S-12, T-9)', () => {
  it('never prints «1-о място» or "1th"', () => {
    expect(bgShare('textDivision', { tier: 'Рила', rank: 1 })).toBe('Рила: място 1 тази седмица.');
    expect(bgShare('textDivision', { tier: 'Рила', rank: 2 })).toBe('Рила: място 2 тази седмица.');
    expect(enShare('textDivision', { tier: 'Rila', rank: 1 })).toBe('Rila: 1st place this week.');
    expect(enShare('textDivision', { tier: 'Rila', rank: 2 })).toBe('Rila: 2nd place this week.');
    expect(enShare('textDivision', { tier: 'Rila', rank: 3 })).toBe('Rila: 3rd place this week.');
    expect(enShare('textDivision', { tier: 'Rila', rank: 11 })).toBe('Rila: 11th place this week.');
  });

  it('states a standing with agreeing nouns', () => {
    expect(bgLeaderboard('standingRanked', { rank: 1, total: 1, points: 1 })).toBe(
      'Вашето място: 1 от 1 участник, 1 точка.',
    );
    expect(bgLeaderboard('standingRanked', { rank: 3, total: 12, points: 40 })).toBe(
      'Вашето място: 3 от 12 участници, 40 точки.',
    );
    expect(enLeaderboard('standingRanked', { rank: 1, total: 1, points: 1 })).toBe(
      'You are 1st of 1 member, with 1 point.',
    );
    expect(enLeaderboard('standingRanked', { rank: 22, total: 40, points: 5 })).toBe(
      'You are 22nd of 40 members, with 5 points.',
    );
  });
});

describe('a campaign names its place (S-11)', () => {
  const bgCampaign = createTranslator({ locale: 'bg', messages: bg, namespace: 'Campaign' });
  const enCampaign = createTranslator({ locale: 'en', messages: en, namespace: 'Campaign' });
  const page = readFileSync(
    new URL('../app/[locale]/kampanii/[slug]/page.tsx', import.meta.url),
    'utf8',
  );

  it('says which municipality, with «във» where Bulgarian needs it', () => {
    expect(bgCampaign('scopeNote_city', { city: 'Варна', cityVav: takesVav('Варна') })).toBe(
      'Кампанията важи за съоръжения във Варна.',
    );
    expect(bgCampaign('scopeNote_city', { city: 'Пловдив', cityVav: takesVav('Пловдив') })).toBe(
      'Кампанията важи за съоръжения в Пловдив.',
    );
    expect(enCampaign('scopeNote_city', { city: 'Plovdiv', cityVav: 'no' })).toBe(
      'This campaign covers facilities in Plovdiv.',
    );
  });

  it('says which quarter, and of which city', () => {
    expect(bgCampaign('scopeNote_quarter', { quarter: 'Лозенец', city: 'София' })).toBe(
      'Кампанията важи за съоръжения в квартал Лозенец (София).',
    );
  });

  it('is fed the real names, not the generic sentence', () => {
    expect(page).not.toContain('t(`scopeNote_${campaign.scope.kind}`)');
    expect(page).toMatch(/t\('scopeNote_quarter', \{ quarter: campaign\.scope\.quarter, city:/);
  });
});
