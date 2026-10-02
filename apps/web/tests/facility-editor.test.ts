import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { feedHref, parseFeedParams } from '@/app/[locale]/admin/(protected)/redakcii/params';
import { formatCoordinate, locationChanged, parseLocation } from '@/lib/facility-editor';

/**
 * The admin editor's new fields and the crowd-edit feed's URL handling
 * (pre-launch audit findings 53 and 62).
 */

describe('parseLocation', () => {
  it('reads a point in Bulgaria and rounds it to the stored precision', () => {
    expect(parseLocation('23.32194444', '42.69777777')).toEqual({ lon: 23.321944, lat: 42.697778 });
  });

  it('accepts a decimal comma, as a Bulgarian keyboard types it', () => {
    expect(parseLocation('23,3219', '42,6977')).toEqual({ lon: 23.3219, lat: 42.6977 });
  });

  it('treats two blank fields as "leave the pin alone"', () => {
    expect(parseLocation('', '  ')).toBeNull();
    expect(parseLocation(null, null)).toBeNull();
  });

  it('refuses half a point, garbage, and anywhere outside Bulgaria', () => {
    expect(parseLocation('23.3', '')).toBe('invalid');
    expect(parseLocation('east', '42.7')).toBe('invalid');
    // Belgrade, and lat/lon swapped — the classic slip.
    expect(parseLocation('20.45', '44.79')).toBe('invalid');
    expect(parseLocation('42.6977', '23.3219')).toBe('invalid');
  });
});

describe('locationChanged', () => {
  it('ignores float noise below the stored precision', () => {
    expect(
      locationChanged({ lon: 23.3219440001, lat: 42.6977 }, { lon: 23.321944, lat: 42.6977 }),
    ).toBe(false);
    expect(locationChanged({ lon: 23.3219, lat: 42.6977 }, { lon: 23.3229, lat: 42.6977 })).toBe(
      true,
    );
  });

  /** What saving the editor without touching the pin submits. */
  function untouched(current: { lon: number; lat: number }) {
    const next = parseLocation(formatCoordinate(current.lon), formatCoordinate(current.lat));
    if (next === null || next === 'invalid') throw new Error('expected a point');
    return next;
  }

  it('is not a move when the untouched form is saved, on half-way OSM coordinates', () => {
    // Seven-decimal OSM centroids. 42.6977085 is shown as 42.697708, where
    // Math.round(v * 1e6) / 1e6 gives 42.697709 — a phantom ~10 cm crowd move
    // on every save, freezing the pin against every future import.
    const osm = { lon: 23.3219335, lat: 42.6977085 };
    expect(formatCoordinate(osm.lat)).toBe('42.697708');
    expect(locationChanged(osm, untouched(osm))).toBe(false);
  });

  it('is not a move for any seven-decimal point saved untouched', () => {
    for (let i = 0; i < 20_000; i += 1) {
      // Deterministic sweep across Bulgaria's extent, in 1e-7 steps.
      const point = {
        lon: Math.round((22.4 + ((i * 7919) % 6_000_000) / 1e7) * 1e7) / 1e7,
        lat: Math.round((41.3 + ((i * 104_729) % 2_800_000) / 1e7) * 1e7) / 1e7,
      };
      expect(locationChanged(point, untouched(point)), JSON.stringify(point)).toBe(false);
    }
  });

  it('is not a move when the full-precision value is pasted back in', () => {
    const osm = { lon: 23.3219335, lat: 42.6977085 };
    const pasted = parseLocation(String(osm.lon), String(osm.lat));
    if (pasted === null || pasted === 'invalid') throw new Error('expected a point');
    expect(locationChanged(osm, pasted)).toBe(false);
  });

  it('is a move at the smallest step the form can express', () => {
    const osm = { lon: 23.3219335, lat: 42.6977085 };
    const moved = parseLocation(formatCoordinate(osm.lon), '42.697709');
    if (moved === null || moved === 'invalid') throw new Error('expected a point');
    expect(locationChanged(osm, moved)).toBe(true);
  });
});

describe('saveFacility — moving a pin', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'app/[locale]/admin/(protected)/facilities/actions.ts'),
    'utf8',
  );

  it('recomputes the municipality from the point, never from the form', () => {
    expect(source).toMatch(/municipality_id = \$\{placed\}/);
    expect(source).toMatch(/ST_Contains\(m\.geom, \$\{point\}\)/);
    expect(source).not.toMatch(/formData\.get\('municipality/);
  });

  it('keeps an ambassador inside their own municipalities, in the statement itself', () => {
    expect(source).toMatch(
      /UPDATE facilities f SET geom = [\s\S]*?WHERE f\.id = \$\{facilityId\} AND \$\{scope\} AND \$\{targetScope\}/,
    );
    expect(source).toMatch(/ambassador_municipalities WHERE user_id = \$\{user\.id\}/);
  });

  it('logs the move the way the importers do, so no import drags the pin back', () => {
    expect(source).toMatch(/'crowd', 'geom'/);
  });
});

describe('crowd-edit feed params', () => {
  it('keeps only well-formed filters', () => {
    expect(parseFeedParams({ akaunt: ' user_1 ', chasa: '24', predi: '123' })).toEqual({
      akaunt: 'user_1',
      chasa: '24',
      predi: '123',
    });
    expect(parseFeedParams({ akaunt: 'x'.repeat(65), chasa: '5', predi: '1; DROP' })).toEqual({});
  });

  it('builds the redirect back to the same filtered view, without the page cursor', () => {
    expect(feedHref({ akaunt: 'user_1', chasa: '24', predi: '9' }, { rezultat: 'reverted' })).toBe(
      '/admin/redakcii?akaunt=user_1&chasa=24&rezultat=reverted',
    );
    expect(feedHref({})).toBe('/admin/redakcii');
  });
});
