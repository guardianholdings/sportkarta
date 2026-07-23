import { describe, expect, it } from 'vitest';

import { offsetAt, SOFIA_TZ } from '../recurrence/index.js';

import {
  campaignPhase,
  campaignWindowInstants,
  daysRemaining,
  MAX_CAMPAIGN_DAYS,
  validateCampaignWindow,
} from './window.js';

/**
 * Campaign windows in civil time (docs/ROADMAP.md §7, Stage 5.3).
 *
 * Two failure modes are worth more than the rest combined:
 *
 *  1. The off-by-one that drops the last day. "Ends 31 August" is inclusive as
 *     authored and exclusive as compiled, and the busiest day of any campaign
 *     is the last one — people rush.
 *  2. Building the exclusive end by adding 86 400 000 ms to an instant, which
 *     lands an hour out on the two DST days and clips or extends the final day
 *     of any campaign ending on the last Sunday of March or October.
 *
 * The DST transitions are discovered from the tz database rather than
 * hardcoded, matching the recurrence and streak suites.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Every Europe/Sofia offset change in [from, to), by daily scan then bisection. */
function findTransitions(fromYear: number, toYear: number): { atMs: number; deltaMs: number }[] {
  const out: { atMs: number; deltaMs: number }[] = [];
  let cursor = Date.UTC(fromYear, 0, 1);
  const end = Date.UTC(toYear, 0, 1);
  let previous = offsetAt(cursor, SOFIA_TZ);
  while (cursor < end) {
    const next = cursor + DAY_MS;
    const offset = offsetAt(next, SOFIA_TZ);
    if (offset !== previous) {
      let lo = cursor;
      let hi = next;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000;
        if (mid === lo) break;
        if (offsetAt(mid, SOFIA_TZ) === previous) lo = mid;
        else hi = mid;
      }
      out.push({ atMs: hi, deltaMs: offset - previous });
      previous = offset;
    }
    cursor = next;
  }
  return out;
}

const TRANSITIONS = findTransitions(2020, 2036);

function civilDate(instant: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SOFIA_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(instant));
}

describe('validateCampaignWindow', () => {
  it('accepts a well-formed window', () => {
    expect(validateCampaignWindow('2026-08-01', '2026-08-31')).toEqual({
      startsOn: '2026-08-01',
      endsOn: '2026-08-31',
    });
  });

  it('accepts a single-day campaign', () => {
    expect(validateCampaignWindow('2026-08-01', '2026-08-01').endsOn).toBe('2026-08-01');
  });

  it('refuses an end before the start', () => {
    expect(() => validateCampaignWindow('2026-08-31', '2026-08-01')).toThrow(
      /window_ends_before_start/,
    );
  });

  it('refuses dates that are not real calendar days', () => {
    for (const bad of ['2026-02-30', '2026-13-01', '26-08-01', 'tomorrow', '']) {
      expect(() => validateCampaignWindow(bad, '2026-08-31'), bad).toThrow(/window_bad_date/);
    }
  });

  it('refuses a campaign longer than the cap — an endless campaign is a feature', () => {
    expect(() => validateCampaignWindow('2026-01-01', '2027-12-31')).toThrow(/window_too_long/);
    expect(MAX_CAMPAIGN_DAYS).toBeLessThanOrEqual(366);
  });
});

describe('campaignWindowInstants', () => {
  it('starts at midnight Sofia, not midnight UTC', () => {
    // 1 August 2026 00:00 EEST (+3) is 31 July 21:00Z.
    const { from } = campaignWindowInstants({ startsOn: '2026-08-01', endsOn: '2026-08-31' });
    expect(from.toISOString()).toBe('2026-07-31T21:00:00.000Z');
  });

  it('includes the whole of the final day', () => {
    // Exclusive end is 1 September 00:00 Sofia = 31 August 21:00Z, so an event
    // at 20:00Z on the 31st (23:00 local) still counts.
    const { to } = campaignWindowInstants({ startsOn: '2026-08-01', endsOn: '2026-08-31' });
    expect(to.toISOString()).toBe('2026-08-31T21:00:00.000Z');
    expect(new Date('2026-08-31T20:59:00Z').getTime()).toBeLessThan(to.getTime());
  });

  it('uses the winter offset for a winter window', () => {
    // 1 January 2026 00:00 EET (+2) is 31 December 22:00Z.
    const { from } = campaignWindowInstants({ startsOn: '2026-01-01', endsOn: '2026-01-31' });
    expect(from.toISOString()).toBe('2025-12-31T22:00:00.000Z');
  });

  it('lands the exclusive end on the correct civil day across every DST transition', () => {
    for (const transition of TRANSITIONS) {
      // A campaign whose last day IS the transition day.
      const endsOn = civilDate(transition.atMs + 60_000);
      const { to } = campaignWindowInstants({ startsOn: endsOn, endsOn });
      // The exclusive end must be midnight of the NEXT civil day — one calendar
      // day later, whatever the elapsed hours were (23 or 25).
      const dayAfter = civilDate(to.getTime() + 60_000);
      expect(civilDate(to.getTime() - 60_000)).toBe(endsOn);
      expect(dayAfter).not.toBe(endsOn);
    }
  });

  it('covers 23 or 25 real hours on the transition days, and still one civil day', () => {
    for (const transition of TRANSITIONS) {
      const endsOn = civilDate(transition.atMs + 60_000);
      const { from, to } = campaignWindowInstants({ startsOn: endsOn, endsOn });
      const hours = (to.getTime() - from.getTime()) / HOUR_MS;
      expect([23, 25]).toContain(hours);
    }
  });
});

describe('campaignPhase', () => {
  const window = { startsOn: '2026-08-01', endsOn: '2026-08-31' };

  it('reports draft and cancelled regardless of the dates', () => {
    expect(campaignPhase('draft', window, new Date('2026-08-15T12:00:00Z'))).toBe('draft');
    expect(campaignPhase('cancelled', window, new Date('2026-08-15T12:00:00Z'))).toBe('cancelled');
  });

  it('reports upcoming before the first midnight', () => {
    expect(campaignPhase('published', window, new Date('2026-07-31T20:59:00Z'))).toBe('upcoming');
  });

  it('reports running from the first midnight Sofia', () => {
    expect(campaignPhase('published', window, new Date('2026-07-31T21:00:00Z'))).toBe('running');
    expect(campaignPhase('published', window, new Date('2026-08-31T20:59:00Z'))).toBe('running');
  });

  it('reports awaiting_close once the window has passed but nothing is frozen', () => {
    // A real state, not a gap: the numbers must stop moving before a results
    // page claims a winner, and entries must stop being accepted before that.
    expect(campaignPhase('published', window, new Date('2026-08-31T21:00:00Z'))).toBe(
      'awaiting_close',
    );
  });

  it('reports closed once an admin has frozen it', () => {
    expect(campaignPhase('closed', window, new Date('2026-09-05T12:00:00Z'))).toBe('closed');
  });
});

describe('daysRemaining', () => {
  const window = { startsOn: '2026-08-01', endsOn: '2026-08-31' };

  it('counts the current day as remaining', () => {
    expect(daysRemaining(window, new Date('2026-08-31T06:00:00Z'))).toBe(1);
    expect(daysRemaining(window, new Date('2026-08-30T06:00:00Z'))).toBe(2);
  });

  it('is zero once the window has closed', () => {
    expect(daysRemaining(window, new Date('2026-08-31T21:00:00Z'))).toBe(0);
  });

  it('counts the full span before the campaign starts', () => {
    expect(daysRemaining(window, new Date('2026-07-01T06:00:00Z'))).toBe(31);
  });

  it('ticks exactly once across a DST transition day', () => {
    // October 2026: the transition day is 25 hours long. A countdown built on
    // elapsed time would tick 1.04 times and eventually drift a whole day.
    const october = { startsOn: '2026-10-20', endsOn: '2026-11-05' };
    const before = daysRemaining(october, new Date('2026-10-24T10:00:00Z'));
    const after = daysRemaining(october, new Date('2026-10-25T10:00:00Z'));
    expect(before - after).toBe(1);
  });
});
