import { describe, expect, it } from 'vitest';

import {
  CITY_BOARD_MIN_MEMBERS,
  MAX_EVENT_WEIGHT,
  validateCampaignRules,
  validateCampaignScope,
  validateCampaignSlug,
} from './rules.js';

/**
 * The campaign rules grammar (docs/ROADMAP.md §7, Stage 5.3).
 *
 * This document arrives from a form, is stored as JSONB — which the database
 * cannot type-check — and is later compiled into SQL that decides who wins a
 * prize. So the tests here are mostly about what is REFUSED: the compiler in
 * db/ is written on the assumption that anything reaching it has been through
 * this function, and that assumption is what keeps the SQL builder small
 * enough to audit.
 */

const ok = { events: [{ kind: 'facility_added', weight: 10 }] };

describe('validateCampaignRules', () => {
  it('accepts a minimal document', () => {
    expect(validateCampaignRules(ok)).toEqual({
      events: [{ kind: 'facility_added', weight: 10 }],
    });
  });

  it('normalises event order so two admins ticking the same boxes store the same JSONB', () => {
    const a = validateCampaignRules({
      events: [
        { kind: 'session_checkin', weight: 3 },
        { kind: 'facility_added', weight: 10 },
      ],
    });
    const b = validateCampaignRules({
      events: [
        { kind: 'facility_added', weight: 10 },
        { kind: 'session_checkin', weight: 3 },
      ],
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Canonical order is PASSPORT_EVENT_KINDS order, not input order.
    expect(a.events.map((e) => e.kind)).toEqual(['facility_added', 'session_checkin']);
  });

  it('normalises the sports filter the same way, and de-duplicates', () => {
    const rules = validateCampaignRules({
      ...ok,
      sports: ['tennis', 'basketball', 'tennis'],
    });
    expect(rules.sports).toEqual(['basketball', 'tennis']);
  });

  it('refuses a document with no events — it would score nothing forever', () => {
    expect(() => validateCampaignRules({ events: [] })).toThrow(/rules_no_events/);
    expect(() => validateCampaignRules({})).toThrow(/rules_no_events/);
  });

  it('refuses an unknown event kind', () => {
    expect(() =>
      validateCampaignRules({ events: [{ kind: 'facility_deleted', weight: 1 }] }),
    ).toThrow(/rules_unknown_event/);
  });

  it('refuses a repeated event kind rather than silently keeping one weight', () => {
    expect(() =>
      validateCampaignRules({
        events: [
          { kind: 'facility_added', weight: 10 },
          { kind: 'facility_added', weight: 50 },
        ],
      }),
    ).toThrow(/rules_duplicate_event/);
  });

  it('refuses weights that are not positive integers, or are absurd', () => {
    for (const weight of [0, -5, 1.5, Number.NaN, '10', null, Number.POSITIVE_INFINITY]) {
      expect(() =>
        validateCampaignRules({ events: [{ kind: 'facility_added', weight }] }),
      ).toThrow(/rules_bad_weight/);
    }
    expect(() =>
      validateCampaignRules({ events: [{ kind: 'facility_added', weight: MAX_EVENT_WEIGHT + 1 }] }),
    ).toThrow(/rules_bad_weight/);
  });

  it('refuses an unknown sport', () => {
    expect(() => validateCampaignRules({ ...ok, sports: ['quidditch'] })).toThrow(
      /rules_unknown_sport/,
    );
  });

  it('refuses an empty sports filter — absent and "none" are different', () => {
    // Absent means "any sport". An empty array would compile to a predicate
    // nothing satisfies, i.e. a campaign that silently scores zero.
    expect(() => validateCampaignRules({ ...ok, sports: [] })).toThrow(/rules_bad_sports/);
    expect(validateCampaignRules(ok).sports).toBeUndefined();
  });

  it('accepts a per-day cap and keeps it', () => {
    expect(validateCampaignRules({ ...ok, perDayCap: 30 }).perDayCap).toBe(30);
  });

  it('refuses a cap below the heaviest event — always a units mistake, never a policy', () => {
    // The admin meant "three actions a day" and wrote 3, while an add is 10.
    expect(() => validateCampaignRules({ ...ok, perDayCap: 3 })).toThrow(
      /rules_cap_below_weight/,
    );
    // Exactly equal is fine: one full action a day.
    expect(validateCampaignRules({ ...ok, perDayCap: 10 }).perDayCap).toBe(10);
  });

  it('refuses a non-object document', () => {
    for (const input of [null, 'rules', 42, [], undefined]) {
      expect(() => validateCampaignRules(input)).toThrow(/rules_not_an_object|rules_no_events/);
    }
  });
});

describe('validateCampaignScope', () => {
  it('accepts a national scope with no other input', () => {
    expect(validateCampaignScope('national', null, null)).toEqual({ kind: 'national' });
  });

  it('accepts a city scope and coerces a form string id', () => {
    expect(validateCampaignScope('city', '7', null)).toEqual({ kind: 'city', municipalityId: 7 });
  });

  it('accepts a quarter scope and normalises whitespace', () => {
    expect(validateCampaignScope('quarter', 7, '  Овча   купел  ')).toEqual({
      kind: 'quarter',
      municipalityId: 7,
      quarter: 'Овча купел',
    });
  });

  it('refuses a city or quarter scope with no municipality', () => {
    expect(() => validateCampaignScope('city', null, null)).toThrow(/scope_needs_municipality/);
    expect(() => validateCampaignScope('quarter', '', 'Лозенец')).toThrow(
      /scope_needs_municipality/,
    );
  });

  it('refuses a quarter scope with no quarter', () => {
    expect(() => validateCampaignScope('quarter', 7, '   ')).toThrow(/scope_needs_quarter/);
  });

  it('refuses an unknown scope kind', () => {
    expect(() => validateCampaignScope('galaxy', 7, null)).toThrow(/scope_unknown/);
  });
});

describe('validateCampaignSlug', () => {
  it('accepts kebab-case latin slugs', () => {
    expect(validateCampaignSlug('avgust-2026')).toBe('avgust-2026');
    expect(validateCampaignSlug('  SOFIA-SPRINT  ')).toBe('sofia-sprint');
  });

  it('refuses anything that would not survive a printed flyer', () => {
    for (const bad of ['', '-leading', 'trailing-', 'double--dash', 'кирилица', 'has space', 'a'.repeat(61)]) {
      expect(() => validateCampaignSlug(bad), bad).toThrow(/slug_invalid/);
    }
  });
});

describe('aggregate board privacy floor', () => {
  it('is at least 2, or an aggregate row could be one person', () => {
    // The whole justification for counting minors in a city board is that no
    // individual is named. A city row with one contributor breaks that.
    expect(CITY_BOARD_MIN_MEMBERS).toBeGreaterThanOrEqual(2);
  });
});
