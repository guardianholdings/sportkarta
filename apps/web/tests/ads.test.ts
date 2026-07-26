import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import { activeAd, adAlt, buildAdPlacementInput, AdPlacementError, AD_SLOTS } from '@/lib/ads';

/**
 * The ad-slot gate (docs/MONETISATION.md S5, phase M4).
 *
 * Two properties are asserted here that no database test can see:
 *
 *  1. THE FORM CANNOT INVENT A SLOT. `AD_SLOTS` is a closed list agreed with the
 *     `ad_placements_slot_known` CHECK and the surface table in §S5; a posted
 *     value outside it is refused before any database work.
 *  2. THE READ IS CONTEXTUAL, NOT BEHAVIOURAL. The statement `activeAd` builds
 *     is inspected for the four conditions it must carry — and, more
 *     importantly, for the absence of anything about the viewer. An ad selected
 *     by anything other than the slot would silently turn a cookieless site
 *     into one that needs a consent banner (§S5, AD-2).
 */

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

const VALID = {
  partnerId: '7',
  slot: 'facility_page',
  url: 'https://example.org/offer',
  altBg: 'Спортни обувки от Пример',
  startsOn: '2026-08-01',
  endsOn: '2026-08-31',
};

function fakeDb(rows: Record<string, unknown>[] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  return {
    statements,
    execute: async (query: SQL) => {
      statements.push(renderSql(query));
      return { rows };
    },
  };
}

describe('buildAdPlacementInput', () => {
  it('accepts a valid placement', () => {
    expect(buildAdPlacementInput(form(VALID))).toEqual({
      partnerId: 7,
      slot: 'facility_page',
      url: 'https://example.org/offer',
      altBg: 'Спортни обувки от Пример',
      altEn: null,
      startsOn: '2026-08-01',
      endsOn: '2026-08-31',
    });
  });

  it('refuses a slot outside the closed list', () => {
    for (const bad of ['homepage', 'map_canvas', 'passport', '']) {
      expect(() => buildAdPlacementInput(form({ ...VALID, slot: bad }))).toThrowError(
        new AdPlacementError('bad_slot'),
      );
    }
    // …and accepts every slot that IS in it, so the list cannot drift from the
    // constant without this failing.
    for (const slot of AD_SLOTS) {
      expect(buildAdPlacementInput(form({ ...VALID, slot })).slot).toBe(slot);
    }
  });

  it('requires alt text — a paid image with no alt is announced as nothing', () => {
    expect(() => buildAdPlacementInput(form({ ...VALID, altBg: '   ' }))).toThrowError(
      new AdPlacementError('alt_required'),
    );
    expect(() =>
      buildAdPlacementInput(form({ ...VALID, altBg: 'x'.repeat(201) })),
    ).toThrowError(new AdPlacementError('alt_too_long'));
  });

  it('requires an http(s) advertiser URL', () => {
    for (const bad of ['example.org', 'javascript:alert(1)', 'ftp://example.org']) {
      expect(() => buildAdPlacementInput(form({ ...VALID, url: bad }))).toThrowError(
        new AdPlacementError('bad_url'),
      );
    }
  });

  it('requires both ends of the window, in order', () => {
    expect(() => buildAdPlacementInput(form({ ...VALID, endsOn: '' }))).toThrowError(
      new AdPlacementError('bad_date'),
    );
    expect(() =>
      buildAdPlacementInput(form({ ...VALID, startsOn: '2026-08-31', endsOn: '2026-08-01' })),
    ).toThrowError(new AdPlacementError('window_order'));
    // Same day is a one-day placement, not an error.
    expect(
      buildAdPlacementInput(form({ ...VALID, startsOn: '2026-08-01', endsOn: '2026-08-01' }))
        .endsOn,
    ).toBe('2026-08-01');
  });

  it('refuses a non-numeric partner', () => {
    expect(() => buildAdPlacementInput(form({ ...VALID, partnerId: 'abc' }))).toThrowError(
      new AdPlacementError('bad_partner'),
    );
  });
});

describe('activeAd', () => {
  it('asks for all four conditions in SQL, not in the caller', async () => {
    const db = fakeDb();
    await activeAd(db, 'city_page');
    const statement = db.statements[0]?.sql ?? '';
    expect(statement).toContain('a.visible');
    expect(statement).toContain('a.starts_on <=');
    expect(statement).toContain('a.ends_on >=');
    // The partner condition is the one that is easy to forget and the one that
    // matters most: hiding an advertiser on the partners screen must pull their
    // creative off all four public surfaces.
    expect(statement).toContain('p.visible');
    expect(db.statements[0]?.params).toContain('city_page');
  });

  it('selects nothing about the viewer — the slot is the only input', async () => {
    const db = fakeDb();
    await activeAd(db, 'facility_page');
    const statement = (db.statements[0]?.sql ?? '').toLowerCase();
    for (const forbidden of ['user', 'session', 'ip_address', 'cookie', 'referer']) {
      expect(statement, `activeAd looked at ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('returns null for an unsold slot without reading anything else', async () => {
    const db = fakeDb([]);
    expect(await activeAd(db, 'weekly_page')).toBeNull();
    expect(db.statements).toHaveLength(1);
  });

  it('projects only what a page needs to render', async () => {
    const db = fakeDb([
      { id: 3, url: 'https://example.org', alt_bg: 'Реклама на Пример', alt_en: null },
    ]);
    const ad = await activeAd(db, 'map_panel');
    // No partner id, slug or tier: the surface renders a labelled creative, not
    // a sponsor relationship.
    expect(Object.keys(ad ?? {}).sort()).toEqual(['altBg', 'altEn', 'id', 'url']);
  });
});

describe('adAlt', () => {
  it('falls back to Bulgarian when there is no English alt', () => {
    expect(adAlt('БГ', null, 'en')).toBe('БГ');
    expect(adAlt('БГ', 'EN', 'en')).toBe('EN');
    expect(adAlt('БГ', 'EN', 'bg')).toBe('БГ');
  });
});
