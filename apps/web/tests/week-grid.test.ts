import type { PassportEvent } from '@sportkarta/lib/badges';
import { describe, expect, it } from 'vitest';

import {
  dayIndexInWeek,
  renderWeekGrid,
  weekGrid,
  WEEK_GLYPHS,
} from '../lib/share/week-grid';

/**
 * The Viber-native week grid (C3).
 *
 * The properties that make it safe to hand to every member — including one whose
 * passport is private — are the ones asserted here: it is seven civil Sofia
 * days, it carries no identifier of any kind, and it is emoji plus numbers with
 * no locale baked in.
 */

function event(iso: string, kind: PassportEvent['kind'] = 'facility_verified'): PassportEvent {
  return { kind, at: new Date(iso), facilityId: null, municipalityId: null, sports: [], points: 0 };
}

// Thursday 23 July 2026; its Sofia week starts Monday 20 July.
const NOW = new Date('2026-07-23T12:00:00Z');

describe('weekGrid', () => {
  it('is always seven days, Monday first', () => {
    const grid = weekGrid([], NOW);
    expect(grid.cells).toHaveLength(7);
    expect(grid.weekStart).toBe('2026-07-20');
    expect(grid.activeDays).toBe(0);
  });

  it('marks the days with activity', () => {
    // Monday 20th and Thursday 23rd.
    const grid = weekGrid([event('2026-07-20T09:00:00Z'), event('2026-07-23T09:00:00Z')], NOW);
    expect(grid.cells).toEqual(['active', 'rest', 'rest', 'active', 'rest', 'rest', 'rest']);
    expect(grid.activeDays).toBe(2);
  });

  it('collapses several events on one day into one active day', () => {
    const grid = weekGrid(
      [
        event('2026-07-20T07:00:00Z'),
        event('2026-07-20T12:00:00Z'),
        event('2026-07-20T19:00:00Z'),
      ],
      NOW,
    );
    expect(grid.activeDays).toBe(1);
  });

  it('ignores activity outside the current week', () => {
    const grid = weekGrid([event('2026-07-19T09:00:00Z'), event('2026-07-27T09:00:00Z')], NOW);
    expect(grid.activeDays).toBe(0);
  });

  it('buckets by the SOFIA day, not the UTC one', () => {
    // 21:30Z on Sunday 19 July is already Monday 20 July in Sofia (EEST, +3),
    // so it belongs to THIS week's first cell — not to the week before.
    const grid = weekGrid([event('2026-07-19T21:30:00Z')], NOW);
    expect(grid.cells[0]).toBe('active');
    expect(grid.activeDays).toBe(1);
  });

  it('counts ANY activity, not only sessions', () => {
    // Mapping is showing up. A grid that is empty for everyone who contributes
    // but has not yet played is not worth pasting.
    const grid = weekGrid(
      [event('2026-07-20T09:00:00Z', 'facility_added'), event('2026-07-21T09:00:00Z', 'session_checkin')],
      NOW,
    );
    expect(grid.activeDays).toBe(2);
  });
});

describe('renderWeekGrid', () => {
  it('is exactly seven glyphs and nothing else', () => {
    const text = renderWeekGrid(weekGrid([event('2026-07-20T09:00:00Z')], NOW));
    expect([...text]).toHaveLength(7);
    expect(text.startsWith(WEEK_GLYPHS.active)).toBe(true);
  });

  it('carries no identifier, no name, no date and no locale', () => {
    // The whole reason every member may share it, whatever their passport
    // visibility: there is nothing in here that is about a person.
    const text = renderWeekGrid(weekGrid([event('2026-07-20T09:00:00Z')], NOW));
    expect(text).not.toMatch(/[A-Za-zА-Яа-я0-9]/);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('uses plain glyphs that render everywhere — no ZWJ, no skin tone, no flags', () => {
    // A composed emoji renders as two boxes on older Android and in some
    // desktop clients, which is exactly where this is meant to travel.
    for (const glyph of Object.values(WEEK_GLYPHS)) {
      expect([...glyph]).toHaveLength(1);
      expect(glyph).not.toContain('‍');
      expect(glyph).not.toMatch(/[\u{1F3FB}-\u{1F3FF}]/u);
    }
  });
});

describe('dayIndexInWeek', () => {
  it('is 0 on Monday and 6 on Sunday, in Sofia', () => {
    expect(dayIndexInWeek(new Date('2026-07-20T09:00:00Z'))).toBe(0);
    expect(dayIndexInWeek(new Date('2026-07-26T09:00:00Z'))).toBe(6);
    // Sunday 21:30Z is already Monday in Sofia.
    expect(dayIndexInWeek(new Date('2026-07-26T21:30:00Z'))).toBe(0);
  });
});
