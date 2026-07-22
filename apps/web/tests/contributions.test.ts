import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import { addFacility, normalizeAddFacility } from '@/lib/contributions/add-facility';
import { reportCondition } from '@/lib/contributions/condition-report';
import { ContributionError } from '@/lib/contributions/errors';
import { normalizeChecklist, verifyFacility } from '@/lib/contributions/verify-facility';

/**
 * Contribution flows at the statement level: what gets written, what gets
 * refused, and what the audit trail ends up saying. The DB-backed companions
 * (db/src/points-ledger.test.ts) cover the constraints these rely on.
 */

const USER = 'user_1';
const FACILITY = '00000000-0000-4000-8000-000000000001';
const SOFIA = { lon: 23.3219, lat: 42.6977 };

/** Records every statement; answers reads from a scripted queue. */
function fakeDb(responses: Record<string, unknown>[][] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  const queue = [...responses];
  const runner = {
    execute(query: SQL) {
      statements.push(renderSql(query));
      return Promise.resolve({ rows: queue.shift() ?? [] });
    },
  };
  return {
    statements,
    ...runner,
    transaction<T>(callback: (tx: typeof runner) => Promise<T>): Promise<T> {
      return callback(runner);
    },
    text(): string {
      return statements.map((s) => `${s.sql} ${JSON.stringify(s.params)}`).join('\n');
    },
  };
}

describe('normalizeAddFacility', () => {
  const base = { name: 'Игрище', quarter: 'Лозенец', sportTypes: ['basketball'], access: 'free' };

  it('accepts a well-formed submission and rounds coordinates', () => {
    const result = normalizeAddFacility({ ...base, lon: 23.32194444, lat: 42.69777777 });
    expect(result.lon).toBe(23.321944);
    expect(result.lat).toBe(42.697778);
    expect(result.sportTypes).toEqual(['basketball']);
  });

  it('refuses a pin outside Bulgaria before any database work', () => {
    // Belgrade — plausible-looking, definitely not ours.
    expect(() => normalizeAddFacility({ ...base, lon: 20.45, lat: 44.79 })).toThrow(
      ContributionError,
    );
    expect(() => normalizeAddFacility({ ...base, lon: Number.NaN, lat: 42.7 })).toThrow(
      ContributionError,
    );
  });

  it('requires at least one sport, and only known ones', () => {
    expect(() => normalizeAddFacility({ ...base, ...SOFIA, sportTypes: [] })).toThrow(
      ContributionError,
    );
    expect(() => normalizeAddFacility({ ...base, ...SOFIA, sportTypes: ['quidditch'] })).toThrow(
      ContributionError,
    );
  });

  it('rejects an unknown access value rather than defaulting one', () => {
    expect(() => normalizeAddFacility({ ...base, ...SOFIA, access: 'members_only' })).toThrow(
      ContributionError,
    );
  });

  it('treats an empty name and quarter as absent', () => {
    const result = normalizeAddFacility({ ...base, ...SOFIA, name: '   ', quarter: '' });
    expect(result.name).toBeNull();
    expect(result.quarter).toBeNull();
  });
});

describe('addFacility', () => {
  const input = {
    name: 'Ново игрище',
    quarter: 'Лозенец',
    sportTypes: ['basketball'],
    access: 'free',
    ...SOFIA,
  };

  it('rejects a duplicate within the guard radius and writes nothing', async () => {
    const db = fakeDb([[{ slug: 'sasedno-igrishte', id: FACILITY }]]);
    await expect(
      addFacility(db, { userId: USER, input, photoStoragePath: 'facilities/x.webp' }),
    ).rejects.toMatchObject({ code: 'duplicate_nearby', conflictSlug: 'sasedno-igrishte' });
    // Only the lookup ran — no INSERT was attempted.
    expect(db.text()).not.toMatch(/INSERT/i);
  });

  it('lands as needs_verification/crowd with photo, audit row and award', async () => {
    const db = fakeDb([
      [], // duplicate check: nothing nearby
      [{ id: FACILITY }], // facility insert
      [], // slug candidates
      [], // slug update
      [], // photo insert
      [], // audit insert
      [{ id: 1 }], // award
    ]);
    const result = await addFacility(db, {
      userId: USER,
      input,
      photoStoragePath: 'facilities/2026/07/x.webp',
    });

    expect(result.facilityId).toBe(FACILITY);
    expect(result.awarded).toBe(true);

    const text = db.text();
    // Provenance and moderation state are not negotiable.
    expect(text).toMatch(/'needs_verification'/);
    expect(text).toMatch(/'crowd'/);
    expect(text).toMatch(/INSERT INTO facility_photos/i);
    expect(text).toMatch(/'pending'/);
    // The audit row is attributed to the account, not to a name.
    expect(text).toMatch(/INSERT INTO facility_edits/i);
    expect(text).toContain(USER);
    // The award is idempotent by construction.
    expect(text).toMatch(/ON CONFLICT \(idempotency_key\) DO NOTHING/i);
  });

  it('refuses to write without a photo', async () => {
    const db = fakeDb([[]]);
    await expect(
      addFacility(db, { userId: USER, input, photoStoragePath: '' }),
    ).rejects.toMatchObject({ code: 'photo_required' });
    expect(db.text()).not.toMatch(/INSERT/i);
  });
});

describe('normalizeChecklist', () => {
  it('keeps lighting tri-state — null is "unknown", not "no"', () => {
    expect(normalizeChecklist({ exists: true, lighting: null })).toEqual({ lighting: null });
    expect(normalizeChecklist({ exists: true, lighting: false })).toEqual({ lighting: false });
  });

  it('rejects values outside the shared vocabulary', () => {
    expect(() => normalizeChecklist({ exists: true, surface: 'lava' })).toThrow(ContributionError);
    expect(() => normalizeChecklist({ exists: true, access: 'vip' })).toThrow(ContributionError);
    expect(() => normalizeChecklist({ exists: true, sportTypes: ['quidditch'] })).toThrow(
      ContributionError,
    );
  });

  it('ignores fields the member did not touch', () => {
    expect(normalizeChecklist({ exists: true })).toEqual({});
  });
});

describe('verifyFacility', () => {
  const current = [
    {
      access: 'free',
      surface: 'asphalt',
      lighting: null,
      covered: false,
      sport_types: ['basketball'],
      status: 'needs_verification',
    },
  ];

  it('records a confirmation even when nothing changed', async () => {
    const db = fakeDb([current, [], [], [], [], [{ id: 1 }]]);
    const result = await verifyFacility(db, {
      userId: USER,
      facilityId: FACILITY,
      checklist: {
        exists: true,
        access: 'free',
        surface: 'asphalt',
        lighting: null,
        covered: false,
      },
    });

    expect(result.changedFields).toEqual([]);
    expect(result.activated).toBe(true);
    // The commonest contribution of all must still leave a trace.
    expect(db.text()).toMatch(/'verified'/);
    expect(db.text()).toMatch(/status = 'active'/);
  });

  it('writes one audit row per corrected field, attributed to the account', async () => {
    const db = fakeDb([current, [], [], [], [], [], [], [{ id: 1 }]]);
    const result = await verifyFacility(db, {
      userId: USER,
      facilityId: FACILITY,
      checklist: { exists: true, access: 'restricted', lighting: true },
    });

    expect(result.changedFields.sort()).toEqual(['access', 'lighting']);
    const text = db.text();
    expect(text).toMatch(/UPDATE facilities SET/i);
    expect(text).toMatch(/INSERT INTO facility_edits/i);
    expect(text).toContain(USER);
    expect(text).toMatch(/'crowd'/);
  });

  it('files a moderation report instead of deleting when told it is gone', async () => {
    const db = fakeDb([current, [], [], []]);
    const result = await verifyFacility(db, {
      userId: USER,
      facilityId: FACILITY,
      checklist: { exists: false },
    });

    expect(result.reportedMissing).toBe(true);
    // No award: claiming a facility is gone must not be profitable.
    expect(result.awarded).toBe(false);
    const text = db.text();
    expect(text).toMatch(/INSERT INTO facility_reports/i);
    expect(text).toMatch(/does_not_exist/);
    // The facility itself is untouched — one voice does not erase a place.
    expect(text).not.toMatch(/status = 'gone'/);
    expect(text).not.toMatch(/DELETE FROM facilities/i);
    expect(text).not.toMatch(/points_ledger/i);
  });

  it('refuses to let the author verify their own facility', async () => {
    // The author check returns a row: this account filed the 'created' edit.
    const db = fakeDb([current, [{ '?column?': 1 }]]);
    await expect(
      verifyFacility(db, {
        userId: USER,
        facilityId: FACILITY,
        checklist: { exists: true, access: 'free' },
      }),
    ).rejects.toMatchObject({ code: 'own_facility' });
    // Nothing was written — no status flip, no audit row, no award.
    const text = db.text();
    expect(text).not.toMatch(/UPDATE facilities/i);
    expect(text).not.toMatch(/INSERT INTO facility_edits/i);
    expect(text).not.toMatch(/points_ledger/i);
  });

  it('names the sports audit field the way the merge policy expects', async () => {
    const db = fakeDb([current, [], [], [], [], [], [], [{ id: 1 }]]);
    const result = await verifyFacility(db, {
      userId: USER,
      facilityId: FACILITY,
      checklist: { exists: true, sportTypes: ['tennis'] },
    });

    // scripts/import-osm MANAGED_FIELDS freezes by 'sport_types'. A camelCase
    // field here would make crowd corrections invisible to the merge policy,
    // and the next import would silently overwrite them.
    expect(result.changedFields).toEqual(['sport_types']);
    expect(db.text()).toContain('sport_types');
    expect(db.text()).not.toContain('sportTypes');
  });

  it('refuses to verify a facility that does not exist', async () => {
    const db = fakeDb([[]]);
    await expect(
      verifyFacility(db, { userId: USER, facilityId: FACILITY, checklist: { exists: true } }),
    ).rejects.toMatchObject({ code: 'facility_not_found' });
  });
});

describe('reportCondition', () => {
  it('stores the report, updates the facility and audits the change', async () => {
    const db = fakeDb([
      [{ condition: 'good' }], // current condition
      [{ id: 'report-1' }], // report insert
      [], // facility update
      [], // audit row
      [{ id: 1 }], // award
    ]);
    const result = await reportCondition(db, {
      userId: USER,
      facilityId: FACILITY,
      input: { state: 'poor', tags: ['litter', 'litter', 'nonsense'] },
    });

    expect(result.state).toBe('poor');
    expect(result.previousState).toBe('good');
    // Tags are de-duplicated and filtered against the closed vocabulary.
    expect(result.tags).toEqual(['litter']);

    const text = db.text();
    expect(text).toMatch(/INSERT INTO facility_condition_reports/i);
    expect(text).toMatch(/SET condition = /i);
    expect(text).toMatch(/'condition'/);
  });

  it('skips the audit row when the state is unchanged but still records the report', async () => {
    const db = fakeDb([[{ condition: 'poor' }], [{ id: 'report-2' }], [], [{ id: 1 }]]);
    const result = await reportCondition(db, {
      userId: USER,
      facilityId: FACILITY,
      input: { state: 'poor', tags: [] },
    });

    expect(result.previousState).toBe('poor');
    expect(db.text()).toMatch(/INSERT INTO facility_condition_reports/i);
    expect(db.text()).not.toMatch(/INSERT INTO facility_edits/i);
  });

  it('rejects a state outside the vocabulary', async () => {
    const db = fakeDb([]);
    await expect(
      reportCondition(db, {
        userId: USER,
        facilityId: FACILITY,
        input: { state: 'катастрофално', tags: [] },
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    expect(db.statements).toEqual([]);
  });
});
