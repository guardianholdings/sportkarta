import { describe, expect, it } from 'vitest';

import { AUTO_LOCATE_PARAM, wantsAutoLocate } from '@/lib/map/auto-locate';
import { withView } from '@/lib/map/view';

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

describe('withView — a located position stays out of the address bar', () => {
  const SOFIA = { lng: 23.3219, lat: 42.6977, zoom: 13 };
  const STICKER = 'blizo=1&utm_source=sticker&utm_medium=offline&utm_content=s1';

  it('writes a view moved by hand to the metre, as before', () => {
    const sp = new URLSearchParams(withView(`?${STICKER}`, SOFIA));
    expect(sp.get('z')).toBe('13.00');
    expect(sp.get('lat')).toBe('42.69770');
    expect(sp.get('lng')).toBe('23.32190');
    expect(sp.get('blizo')).toBe('1');
    expect(sp.get('utm_content')).toBe('s1');
  });

  it('replaces a view already in the address', () => {
    expect(withView('?sport=football&z=7.00&lat=43.20000&lng=27.90000', SOFIA)).toBe(
      'sport=football&z=13.00&lat=42.69770&lng=23.32190',
    );
  });

  it('takes the view out after a locate and keeps every other parameter', () => {
    const qs = withView(`?${STICKER}&z=13.00&lat=42.69770&lng=23.32190`, null);
    expect(qs).toBe(STICKER);
    expect(qs).not.toMatch(/\d\.\d{3,}/);
    expect(
      withView('?z=13.00&sport=football&lat=42.69770&selected=some-pitch&lng=23.32190', null),
    ).toBe('sport=football&selected=some-pitch');
  });

  it('leaves an address with no view as it is', () => {
    expect(withView(`?${STICKER}`, null)).toBe(STICKER);
    expect(withView('', null)).toBe('');
  });
});
