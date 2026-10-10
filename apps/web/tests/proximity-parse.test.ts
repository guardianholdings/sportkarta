import { describe, expect, it } from 'vitest';

import { parseCoordinates } from '@/lib/contributions/proximity';

/**
 * «Location off» must stay «no location» (UX audit 2026-10-10). The hidden
 * position fields post '' when no fix was shared, and `Number('')` is 0 — so
 * every such contribution became the point (0, 0), was recorded 1,000 km away
 * and was told so, instead of NULL and «без местоположение».
 */
describe('parseCoordinates', () => {
  it('reads an empty or absent field as no location, never as (0, 0)', () => {
    for (const [lat, lon] of [
      ['', ''],
      ['   ', ' '],
      [null, null],
      [undefined, undefined],
      ['', '23.32'],
      ['42.69', null],
    ] as const) {
      expect(parseCoordinates(lat, lon), `${String(lat)}, ${String(lon)}`).toBeNull();
    }
  });

  it('reads a real fix from the form strings', () => {
    expect(parseCoordinates('42.6977', '23.3219')).toEqual({ lat: 42.6977, lon: 23.3219 });
  });

  it('still refuses nonsense and out-of-range values', () => {
    expect(parseCoordinates('north', '23')).toBeNull();
    expect(parseCoordinates('91', '23')).toBeNull();
    expect(parseCoordinates('42', '181')).toBeNull();
  });
});
