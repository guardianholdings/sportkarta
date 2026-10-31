import { describe, expect, it } from 'vitest';

import { ADD_FROM_VIEW_MIN_ZOOM, addFacilityHref, logTrainingHref } from '@/lib/map/add-from-view';

/**
 * «Добави съоръжение» opened over the map starts the pin picker where the map
 * is looking — as a VIEW, which /dobavi does not treat as a placed pin
 * (`izgled=1`, dobavi/page.tsx), and only from street zoom.
 */
describe('addFacilityHref', () => {
  it('starts from the map view at street zoom, as a view and not a pin', () => {
    expect(addFacilityHref(`?z=${String(ADD_FROM_VIEW_MIN_ZOOM)}&lat=42.6977&lng=23.3219`)).toBe(
      '/dobavi?lon=23.321900&lat=42.697700&izgled=1',
    );
    expect(addFacilityHref('?blizo=1&z=16.40&lat=43.20412&lng=27.91003&selected=x')).toBe(
      '/dobavi?lon=27.910030&lat=43.204120&izgled=1',
    );
  });

  it('starts nowhere in particular from a country or region view, or with no view', () => {
    expect(addFacilityHref('?z=7&lat=42.7&lng=25.3')).toBe('/dobavi');
    expect(addFacilityHref('?z=12.99&lat=42.7&lng=25.3')).toBe('/dobavi');
    expect(addFacilityHref('')).toBe('/dobavi');
  });

  it('ignores a view outside Bulgaria', () => {
    expect(addFacilityHref('?z=15&lat=44.79&lng=20.45')).toBe('/dobavi');
  });
});

describe('logTrainingHref', () => {
  it('opens the form with the places around a street-zoom view', () => {
    expect(logTrainingHref('?z=15&lat=42.69770&lng=23.32190')).toBe(
      '/trenirovki?nova=1&lon=23.32190&lat=42.69770',
    );
  });

  it('opens the bare form otherwise', () => {
    expect(logTrainingHref('?z=8&lat=42.7&lng=25.3')).toBe('/trenirovki?nova=1');
    expect(logTrainingHref('')).toBe('/trenirovki?nova=1');
  });
});
