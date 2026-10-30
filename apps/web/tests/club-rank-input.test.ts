import { describe, expect, it } from 'vitest';

import { parseAward, parseLadder, parseNextAwardPicks, parseRank } from '@/lib/clubs/input';

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    for (const one of Array.isArray(value) ? value : [value]) data.append(name, one);
  }
  return data;
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('parseLadder', () => {
  it('takes a template without a name for a new ladder, never for an edit', () => {
    expect(parseLadder(form({ template: 'judo' }), true)).toEqual({
      ok: true,
      value: { nameBg: null, nameEn: null, sport: null, template: 'judo' },
    });
    expect(parseLadder(form({ template: 'judo' }), false)).toEqual({
      ok: false,
      errors: ['ladder_name_required'],
    });
  });

  it('refuses an unknown template or sport, an inherited key included', () => {
    expect(parseLadder(form({ nameBg: 'Карате', template: 'toString' }), true)).toEqual({
      ok: false,
      errors: ['template_invalid'],
    });
    expect(parseLadder(form({ nameBg: 'Карате', sport: 'quidditch' }), true)).toEqual({
      ok: false,
      errors: ['sport_invalid'],
    });
    expect(parseLadder(form({ nameBg: 'Карате', sport: 'karate' }), true)).toMatchObject({
      ok: true,
      value: { nameBg: 'Карате', sport: 'karate', template: null },
    });
  });
});

describe('parseRank', () => {
  it('reads a belt from the closed palette and its optional asks', () => {
    expect(
      parseRank(
        form({
          nameBg: 'Син пояс',
          colour: 'blue',
          accent: 'black',
          stripes: '2',
          minAttendances: '40',
          minMonths: '',
        }),
      ),
    ).toEqual({
      ok: true,
      value: {
        nameBg: 'Син пояс',
        nameEn: null,
        colour: 'blue',
        accent: 'black',
        stripes: 2,
        minAttendances: 40,
        minMonths: null,
      },
    });
  });

  it('refuses a typed colour, an accent equal to the belt and out-of-range asks', () => {
    expect(
      parseRank(
        form({
          nameBg: 'Пояс',
          colour: '#ff0000',
          accent: 'pink',
          stripes: '7',
          minAttendances: '0',
          minMonths: '241',
        }),
      ),
    ).toEqual({
      ok: false,
      errors: [
        'colour_invalid',
        'accent_invalid',
        'stripes_invalid',
        'min_attendances_invalid',
        'min_months_invalid',
      ],
    });
    expect(parseRank(form({ nameBg: 'Пояс', colour: 'white', accent: 'white' }))).toEqual({
      ok: false,
      errors: ['accent_invalid'],
    });
    expect(parseRank(form({ colour: 'white' }))).toEqual({
      ok: false,
      errors: ['rank_name_required'],
    });
    // A pasted tab or line break: the name CHECK would refuse it with a 500.
    expect(parseRank(form({ nameBg: 'Син\tпояс', colour: 'blue' }))).toEqual({
      ok: false,
      errors: ['name_control'],
    });
    expect(parseLadder(form({ nameBg: 'Карате', nameEn: 'Kara\nte' }), true)).toEqual({
      ok: false,
      errors: ['name_control'],
    });
  });
});

describe('parseAward', () => {
  const today = '2026-10-30';

  it('defaults to today and an exam; takes a past day', () => {
    expect(parseAward(form({}), today)).toEqual({
      ok: true,
      value: { awardedOn: today, reason: 'exam' },
    });
    expect(parseAward(form({ awardedOn: '2019-05-01', reason: 'prior' }), today)).toEqual({
      ok: true,
      value: { awardedOn: '2019-05-01', reason: 'prior' },
    });
  });

  it('refuses a day in the future, a bad day and an unknown reason', () => {
    expect(parseAward(form({ awardedOn: '2026-10-31' }), today)).toEqual({
      ok: false,
      errors: ['award_date_future'],
    });
    expect(parseAward(form({ awardedOn: '2026-02-30', reason: 'gift' }), today)).toEqual({
      ok: false,
      errors: ['award_date_invalid', 'award_reason_invalid'],
    });
  });
});

describe('parseNextAwardPicks', () => {
  it('reads each tick as a client and the rank the page showed, once per client', () => {
    expect(parseNextAwardPicks(form({ pick: [`${A}.${B}`, `${B}.${A}`, `${A}.${B}`] }))).toEqual({
      ok: true,
      value: [
        { memberId: A, rankId: B },
        { memberId: B, rankId: A },
      ],
    });
  });

  it('refuses nothing ticked and a malformed tick', () => {
    expect(parseNextAwardPicks(form({}))).toEqual({
      ok: false,
      errors: ['ranks_none_selected'],
    });
    expect(parseNextAwardPicks(form({ pick: `${A}.${B}.x` }))).toEqual({
      ok: false,
      errors: ['invalid'],
    });
    expect(parseNextAwardPicks(form({ pick: `${A}` }))).toEqual({
      ok: false,
      errors: ['invalid'],
    });
  });
});
