import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { awardKey, isPointsEvent, POINTS_BY_EVENT, POINTS_EVENTS } from './points.js';

const FACILITY = '00000000-0000-4000-8000-000000000001';
const USER = 'user_1';

describe('points model', () => {
  it('prices every event exactly once', () => {
    expect(Object.keys(POINTS_BY_EVENT).sort()).toEqual([...POINTS_EVENTS].sort());
    for (const event of POINTS_EVENTS) {
      expect(POINTS_BY_EVENT[event]).toBeGreaterThan(0);
    }
  });

  it('rejects anything that is not a known event', () => {
    for (const value of ['spend', 'FACILITY_ADDED', '', null, 7, {}]) {
      expect(isPointsEvent(value)).toBe(false);
    }
  });
});

describe('awardKey', () => {
  it('awards a facility addition once per facility, whoever repeats it', () => {
    const first = awardKey({ event: 'facility_added', facilityId: FACILITY, userId: USER });
    const other = awardKey({ event: 'facility_added', facilityId: FACILITY, userId: 'user_2' });
    expect(first).toBe(other);
  });

  it('awards a verification once per person per facility', () => {
    const mine = awardKey({ event: 'facility_verified', facilityId: FACILITY, userId: USER });
    const theirs = awardKey({ event: 'facility_verified', facilityId: FACILITY, userId: 'user_2' });
    const elsewhere = awardKey({ event: 'facility_verified', facilityId: 'other', userId: USER });
    expect(mine).not.toBe(theirs);
    expect(mine).not.toBe(elsewhere);
    // The same person verifying the same facility again is the same key.
    expect(awardKey({ event: 'facility_verified', facilityId: FACILITY, userId: USER })).toBe(mine);
  });

  it('buckets condition reports by Sofia day, not by UTC day', () => {
    const base = { event: 'condition_reported', facilityId: FACILITY, userId: USER } as const;
    // 22:30 UTC is already the next day in Sofia, so these must differ.
    const lateEvening = awardKey({ ...base, now: new Date('2026-07-21T22:30:00Z') });
    const earlier = awardKey({ ...base, now: new Date('2026-07-21T09:00:00Z') });
    expect(lateEvening).not.toBe(earlier);
    expect(lateEvening).toContain('2026-07-22');

    // Two reports inside the same Sofia day share a key (one award).
    const morning = awardKey({ ...base, now: new Date('2026-07-22T05:00:00Z') });
    const evening = awardKey({ ...base, now: new Date('2026-07-22T18:00:00Z') });
    expect(morning).toBe(evening);
  });

  it('never collides across events (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...POINTS_EVENTS),
        fc.constantFrom(...POINTS_EVENTS),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (eventA, eventB, facilityId, userId) => {
          const a = awardKey({ event: eventA, facilityId, userId });
          const b = awardKey({ event: eventB, facilityId, userId });
          if (eventA !== eventB) expect(a).not.toBe(b);
          else expect(a).toBe(b);
        },
      ),
    );
  });

  it('is stable under repetition — the retry property (property)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...POINTS_EVENTS),
        fc.uuid(),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.integer({ min: 2, max: 25 }),
        (event, facilityId, userId, retries) => {
          const now = new Date('2026-07-22T09:00:00Z');
          const keys = Array.from({ length: retries }, () =>
            awardKey({ event, facilityId, userId, now }),
          );
          // However many times the action is retried, it is one key — and the
          // ledger's UNIQUE index turns that into exactly one award.
          expect(new Set(keys).size).toBe(1);
        },
      ),
    );
  });
});
