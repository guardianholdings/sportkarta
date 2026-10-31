import { describe, expect, it } from 'vitest';

import { CLUB_TIERS, CLUB_TRIAL_DAYS } from './access.js';
import { CLUB_CATALOGUE, CLUB_SERVICES } from './catalogue.js';
import { CLUB_FEATURES, isClubFeature } from './features.js';
import { CLUB_TIER_PRICE_CENTS } from './pricing-public.js';

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

  it('prices every tier, none of them free', () => {
    // Every tier is paid (operator decision 2026-10-31), in whole cents.
    for (const tier of CLUB_TIERS) {
      expect(Number.isInteger(CLUB_TIER_PRICE_CENTS[tier])).toBe(true);
      expect(CLUB_TIER_PRICE_CENTS[tier]).toBeGreaterThan(0);
    }
    expect(CLUB_TIER_PRICE_CENTS).toEqual({ community: 4999, standard: 9999, pro: 14999 });
  });

  it('keeps the trial a month long, as the clubs page says «1 месец»', () => {
    // ClubsLanding (assurances, trialNote, vatNote, final) and Home.clubs say
    // «1 месец» / «Първият месец» in words; change those strings with this.
    expect(CLUB_TRIAL_DAYS).toBe(30);
  });
});
