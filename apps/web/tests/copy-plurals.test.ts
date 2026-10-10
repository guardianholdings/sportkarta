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

describe('counts that can be 1 (S-15, T-10, T-16)', () => {
  const t = {
    session: createTranslator({ locale: 'bg', messages: bg, namespace: 'Session' }),
    digest: createTranslator({ locale: 'bg', messages: bg, namespace: 'Digest' }),
    share: createTranslator({ locale: 'bg', messages: bg, namespace: 'ShareSheet' }),
    shareEn: createTranslator({ locale: 'en', messages: en, namespace: 'ShareSheet' }),
    campaign: createTranslator({ locale: 'bg', messages: bg, namespace: 'Campaign' }),
    training: createTranslator({ locale: 'bg', messages: bg, namespace: 'Training' }),
    checkin: createTranslator({ locale: 'bg', messages: bg, namespace: 'Checkin' }),
    roster: createTranslator({ locale: 'bg', messages: bg, namespace: 'Roster' }),
  };

  it('agrees «записан» with one and «записани» with more', () => {
    expect(t.session('spotsUnlimited', { going: 1 })).toBe('1 записан');
    expect(t.session('spotsUnlimited', { going: 4 })).toBe('4 записани');
    expect(t.digest('spotsUnlimited', { going: 1 })).toBe('1 записан');
    expect(t.checkin('attendance', { checkedIn: 1, going: 1 })).toBe('1 отбелязан от 1 записан');
    expect(t.roster('attendance', { checkedIn: 0, going: 3 })).toBe('0 отбелязани · 3 записани');
  });

  it('shares one training, one day and one point in the singular', () => {
    expect(t.share('textWeek', { sessions: 1 })).toMatch(/^1 тренировка за последните 30 дни\./);
    expect(t.shareEn('textWeek', { sessions: 1 })).toMatch(/^1 training session in the last/);
    expect(t.share('textLegend', { place: 'Южен парк', days: 1 })).toBe(
      'Южен парк: най-редовният тук е идвал 1 ден.',
    );
    expect(t.campaign('yourScore', { score: 1 })).toBe('Имате 1 точка в тази кампания.');
  });

  it('labels the training totals in agreement with the number above them', () => {
    expect(t.training('statSports', { count: 1 })).toBe('спорт');
    expect(t.training('statSports', { count: 3 })).toBe('спорта');
    expect(t.training('statSessions', { count: 1 })).toBe('тренировка (30 дни)');
    expect(t.training('statMinutes', { count: 1 })).toBe('минута');
  });

  it('gives the worker two plain forms, never ICU it cannot interpret', () => {
    // lib/src/email renders with a {placeholder} fill, not next-intl.
    for (const catalogue of [bg, en]) {
      for (const ns of [catalogue.DigestEmail, catalogue.SessionEmail]) {
        for (const form of [ns.spotsUnlimitedOne, ns.spotsUnlimitedOther]) {
          expect(form).toContain('{going}');
          expect(form).not.toMatch(/plural|#/);
        }
      }
    }
    expect(bg.SessionEmail.spotsUnlimitedOne).toBe('{going} записан');
  });

  it('names the 30-day summary trigger for what it shares', () => {
    expect(bg.ShareSheet.triggerThirtyDays).toBe('Сподели последните 30 дни');
    expect('triggerWeek' in bg.ShareSheet).toBe(false);
  });
});
