import { describe, expect, it } from 'vitest';

import {
  CLUB_CATALOGUE,
  CLUB_FEATURES,
  CLUB_SERVICES,
  type ClubService,
  lowestTierWith,
} from '@sportkarta/lib/clubs';

import { serviceFor } from '../lib/clubs/features';
import { PRICING_INCLUDED, platformFeeFree, rowState } from '../lib/clubs/landing';
import bg from '../messages/bg.json';

/**
 * The clubs page (/za-klubove) must not sell what is not there: a row behind
 * an outside service the operator has not switched on says «скоро», a row
 * above the free tier names its tier, the fee line exists only while the fee
 * is zero — and every row in the catalogue has its words.
 */
const OFF = () => false;
const ON = () => true;
const rows = CLUB_CATALOGUE.flatMap((area) => area.rows.map((r) => ({ area: area.key, ...r })));

describe('catalogue row state', () => {
  it('marks «скоро» exactly the rows that depend on a switched-off service', () => {
    for (const r of rows) {
      const state = rowState(r, OFF);
      const dependsOnService =
        r.service !== undefined || (r.feature !== undefined && serviceFor(r.feature) !== undefined);
      expect(state.soon, `${r.area}.${r.key}`).toBe(dependsOnService);
      expect(rowState(r, ON).soon, `${r.area}.${r.key}`).toBe(false);
    }
  });

  it('names the cheapest tier above Общност, and no tier for the base rows', () => {
    for (const r of rows) {
      const { tier } = rowState(r, ON);
      if (r.feature === undefined) expect(tier, `${r.area}.${r.key}`).toBeNull();
      else expect(tier, `${r.area}.${r.key}`).toBe(lowestTierWith(r.feature));
    }
  });

  it('asks only for services the switches know', () => {
    const asked = new Set<ClubService>();
    for (const r of rows) rowState(r, (s) => (asked.add(s), true));
    for (const s of asked) expect(CLUB_SERVICES).toContain(s);
  });
});

describe('the pricing grid base rows', () => {
  it('marks «скоро» the base rows behind a switched-off service, and only those', () => {
    const soon = PRICING_INCLUDED.filter((row) => rowState(row, OFF).soon).map((r) => r.key);
    expect(soon).toEqual(['push', 'payments']);
    expect(PRICING_INCLUDED.filter((row) => rowState(row, ON).soon)).toEqual([]);
  });

  it('has words for every base row', () => {
    const included = (bg.ClubsLanding as { pricing: { included: Record<string, string> } }).pricing
      .included;
    expect(PRICING_INCLUDED.filter((row) => typeof included[row.key] !== 'string')).toEqual([]);
    expect(Object.keys(included).filter((k) => !PRICING_INCLUDED.some((r) => r.key === k))).toEqual(
      [],
    );
  });
});

describe('the fee line', () => {
  it('shows only while the platform fee is zero', () => {
    expect(platformFeeFree(undefined)).toBe(true);
    expect(platformFeeFree('')).toBe(true);
    expect(platformFeeFree('0')).toBe(true);
    expect(platformFeeFree('abc')).toBe(true);
    expect(platformFeeFree('1')).toBe(false);
    expect(platformFeeFree('150')).toBe(false);
  });
});

describe('the catalogue has its words', () => {
  const landing = bg.ClubsLanding as unknown as {
    catalogue: Record<string, Record<string, unknown>>;
  };

  it('every area has a title and a lead', () => {
    for (const area of CLUB_CATALOGUE) {
      const node = landing.catalogue[area.key];
      expect(typeof node?.title, area.key).toBe('string');
      expect(typeof node?.lead, area.key).toBe('string');
    }
  });

  it('every row has a title and a line, and no words exist for a row that does not', () => {
    for (const area of CLUB_CATALOGUE) {
      const words = (landing.catalogue[area.key]?.rows ?? {}) as Record<
        string,
        { title?: unknown; body?: unknown }
      >;
      for (const r of area.rows) {
        expect(typeof words[r.key]?.title, `${area.key}.${r.key}`).toBe('string');
        expect(typeof words[r.key]?.body, `${area.key}.${r.key}`).toBe('string');
      }
      expect(
        Object.keys(words).filter((k) => !area.rows.some((r) => r.key === k)),
        area.key,
      ).toEqual([]);
    }
  });

  it('labels every tier feature for the pricing grid', () => {
    const feature = bg.Club.feature as Record<string, string>;
    expect(CLUB_FEATURES.filter((f) => typeof feature[f] !== 'string')).toEqual([]);
  });
});
