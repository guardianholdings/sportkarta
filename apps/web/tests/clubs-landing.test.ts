import { describe, expect, it } from 'vitest';

import {
  CLUB_CATALOGUE,
  CLUB_FEATURES,
  CLUB_SERVICES,
  type ClubService,
  lowestTierWith,
} from '@sportkarta/lib/clubs';

import { serviceFor } from '../lib/clubs/features';
import { PRICING_INCLUDED, audienceFigures, platformFeeFree, rowState } from '../lib/clubs/landing';
import bg from '../messages/bg.json';
import en from '../messages/en.json';

/**
 * The clubs page (/za-klubove) must not sell what is not there: a row behind
 * an outside service the operator has not switched on says «скоро», a row
 * above the entry tier names its tier, the fee line exists only while the fee
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

describe('the audience band figures', () => {
  // «0 игри тази седмица» on a page that sells the audience reads as an empty
  // platform, so the games figure shows only while there are games this week
  // (operator, 2026-11-01).
  it('leaves out the games figure while there are none this week', () => {
    expect(audienceFigures(100, 20, 0).map((f) => f.key)).toEqual(['places', 'municipalities']);
    expect(audienceFigures(100, 20, null).map((f) => f.key)).toEqual(['places', 'municipalities']);
  });

  it('shows it, with its count, once there is a game', () => {
    expect(audienceFigures(100, 20, 4)).toEqual([
      { key: 'places', value: 100 },
      { key: 'municipalities', value: 20 },
      { key: 'games', value: 4 },
    ]);
  });

  it('leaves out a figure it has no number for', () => {
    expect(audienceFigures(null, null, 4)).toEqual([{ key: 'games', value: 4 }]);
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

describe('the trial length is never typed into the copy', () => {
  // CLUB_TRIAL_DAYS is the one number (operator, 2026-10-31: «30 дни»); every
  // string that states it says {days}, so the copy cannot drift from the system.
  const TYPED = /\b30[- ]?(дни|дневн)|месец е безплатен|\b1 месец|пробен месец|пробният месец/i;
  const sources: [string, unknown][] = [
    ['ClubsLanding', bg.ClubsLanding],
    ['Home.clubs', bg.Home.clubs],
    ['ClubPublic.applyBody', bg.ClubPublic.applyBody],
    ['ClubPublic.emptyCatalogBody', bg.ClubPublic.emptyCatalogBody],
    ['ClubApply', bg.ClubApply],
    ['AdminClubs.approveConfirm', bg.AdminClubs.approveConfirm],
  ];
  function strings(node: unknown, at: string): [string, string][] {
    if (typeof node === 'string') return [[at, node]];
    if (node === null || typeof node !== 'object') return [];
    return Object.entries(node).flatMap(([key, child]) => strings(child, `${at}.${key}`));
  }

  it.each(sources)('%s', (at, node) => {
    expect(strings(node, at).filter(([, text]) => TYPED.test(text))).toEqual([]);
  });
});

describe('the contract term is never typed into the copy', () => {
  // CLUB_CONTRACT_MONTHS and CLUB_CONTRACT_NOTICE_MONTHS (lib/src/clubs/contract.ts)
  // are the contract's numbers (operator, 2026-10-31): every string that states
  // them says {months} / {notice}, so the page, the settings and the mails agree.
  // \b sees only ASCII word characters, so Cyrillic words are bounded by \p{L}.
  const TYPED =
    /(?<![\p{L}\d])12[- ]?(месец|month)|(?<![\p{L}\d])(една|1) година|\b(one|1)[- ]year|едногодиш/iu;
  const sources: [string, unknown][] = [
    ['ClubsLanding', bg.ClubsLanding],
    ['ClubApply', bg.ClubApply],
    ['ClubSettings.contract', bg.ClubSettings.contract],
    ['ClubSettings.closeHint', bg.ClubSettings.closeHint],
    ['AdminClubs.contractNote', bg.AdminClubs.contractNote],
    ['ClubEmail.lead', bg.ClubEmail.lead],
    ['Terms.service', bg.Terms.service],
    ['en.ClubsLanding', en.ClubsLanding],
    ['en.Terms.service', en.Terms.service],
  ];
  function strings(node: unknown, at: string): [string, string][] {
    if (typeof node === 'string') return [[at, node]];
    if (node === null || typeof node !== 'object') return [];
    return Object.entries(node).flatMap(([key, child]) => strings(child, `${at}.${key}`));
  }

  it.each(sources)('%s', (at, node) => {
    expect(strings(node, at).filter(([, text]) => TYPED.test(text))).toEqual([]);
  });

  it('catches the typed forms it is meant to', () => {
    for (const text of ['договор за една година', 'за 12 месеца', 'a 12-month term', 'one year']) {
      expect(TYPED.test(text), text).toBe(true);
    }
  });

  it('states the contract wherever the page used to promise no lock-in', () => {
    const landing = JSON.stringify(bg.ClubsLanding);
    expect(landing).not.toMatch(/обвързващ|без предизвестие|без договор|по всяко време\?/);
    expect(bg.ClubsLanding.assurances.contract).toContain('{months}');
    expect(bg.ClubsLanding.faq.cancel.a).toContain('{notice');
  });
});
