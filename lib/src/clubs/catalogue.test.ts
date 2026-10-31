import { describe, expect, it } from 'vitest';

import { CLUB_TIERS } from './access.js';
import { CLUB_CATALOGUE, CLUB_SERVICES } from './catalogue.js';
import { CLUB_FEATURES, isClubFeature } from './features.js';
import { CLUB_TIER_PRICE_EUR } from './pricing-public.js';

/**
 * The catalogue the clubs page renders is complete by construction: a feature
 * the tier matrix gates must be told about somewhere on the page, and a row
 * must name only gates that exist.
 */
describe('the clubs catalogue', () => {
  const rows = CLUB_CATALOGUE.flatMap((area) => area.rows.map((r) => ({ area: area.key, ...r })));

  it('names every tier-gated feature at least once', () => {
    const named = new Set(rows.flatMap((r) => (r.feature ? [r.feature] : [])));
    expect(CLUB_FEATURES.filter((feature) => !named.has(feature))).toEqual([]);
  });

  it('names only features and services that exist', () => {
    for (const r of rows) {
      if (r.feature !== undefined)
        expect(isClubFeature(r.feature), `${r.area}.${r.key}`).toBe(true);
      if (r.service !== undefined) expect(CLUB_SERVICES).toContain(r.service);
      // A feature's service comes from the feature's own mapping, never twice.
      expect(r.feature !== undefined && r.service !== undefined, `${r.area}.${r.key}`).toBe(false);
    }
  });

  it('keeps area keys and row keys unique within their area', () => {
    const areas = CLUB_CATALOGUE.map((a) => a.key);
    expect(new Set(areas).size).toBe(areas.length);
    for (const area of CLUB_CATALOGUE) {
      const keys = area.rows.map((r) => r.key);
      expect(new Set(keys).size, area.key).toBe(keys.length);
      expect(keys.length, area.key).toBeGreaterThan(0);
    }
  });

  it('prices every tier, the free one at zero', () => {
    for (const tier of CLUB_TIERS) expect(CLUB_TIER_PRICE_EUR[tier]).toBeGreaterThanOrEqual(0);
    expect(CLUB_TIER_PRICE_EUR.community).toBe(0);
    expect(CLUB_TIER_PRICE_EUR.standard).toBeLessThan(CLUB_TIER_PRICE_EUR.pro);
  });
});
