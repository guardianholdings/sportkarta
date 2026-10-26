import { describe, expect, it } from 'vitest';

import { AUTO_LOCATE_PARAM, wantsAutoLocate } from '@/lib/map/auto-locate';

/** The search params of an address, the way the explorer reads them. */
function params(search: string) {
  return Object.fromEntries(new URLSearchParams(search).entries());
}

describe('wantsAutoLocate — the sticker QR flag', () => {
  it('is the parameter the printed codes carry', () => {
    expect(AUTO_LOCATE_PARAM).toBe('blizo');
  });

  it('locates on blizo=1', () => {
    expect(wantsAutoLocate(params('?blizo=1'))).toBe(true);
  });

  it('locates on the printed address, campaign tags and all', () => {
    for (const content of ['s1', 's2', 's3']) {
      const search = `?blizo=1&utm_source=sticker&utm_medium=offline&utm_content=${content}`;
      expect(wantsAutoLocate(params(search))).toBe(true);
    }
  });

  it('locates whatever else the address carries (filters, a saved view)', () => {
    expect(wantsAutoLocate(params('?sport=football&blizo=1&z=13&lat=42.69&lng=23.32'))).toBe(true);
  });

  it('does not locate when the address selects a facility', () => {
    expect(wantsAutoLocate(params('?blizo=1&selected=some-pitch'))).toBe(false);
    expect(wantsAutoLocate(params('?selected=some-pitch&blizo=1'))).toBe(false);
    expect(wantsAutoLocate({ blizo: '1', selected: ['some-pitch'] })).toBe(false);
  });

  it('locates when `selected` is empty: it names no facility', () => {
    expect(wantsAutoLocate(params('?blizo=1&selected='))).toBe(true);
    expect(wantsAutoLocate({ blizo: '1', selected: [] })).toBe(true);
  });

  it('does not locate on any other value', () => {
    for (const value of ['', '0', '2', '01', '1.0', ' 1', '1 ', 'true', 'yes', 'on']) {
      expect(wantsAutoLocate({ blizo: value })).toBe(false);
    }
    expect(wantsAutoLocate({ blizo: ['1'] })).toBe(false);
  });

  it('does not locate without the flag', () => {
    expect(wantsAutoLocate({})).toBe(false);
    expect(wantsAutoLocate(params('?utm_source=sticker&utm_content=s5'))).toBe(false);
    expect(wantsAutoLocate(params('?BLIZO=1'))).toBe(false);
  });
});
