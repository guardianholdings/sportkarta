import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { feedHref, parseFeedParams } from '@/app/[locale]/admin/(protected)/redakcii/params';
import { locationChanged, parseLocation } from '@/lib/facility-editor';

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
