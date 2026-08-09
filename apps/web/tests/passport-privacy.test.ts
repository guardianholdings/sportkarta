import { renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import { newPublicHandle, publicPassport, setPassportVisibility } from '@/lib/passport';

/**
 * The public passport's privacy boundary (Stage 5.1).
 *
 * The rule this file exists to keep true: a public passport carries badges,
 * totals and streak LENGTHS, and never a facility, a day or a time. A public
 * page tying a named person to a place and a moment publishes where they
 * reliably are — a pattern-of-life disclosure, and not something anybody
 * consents to by clicking "make my passport public".
 *
 * The projection is built as a whitelist in lib/passport.ts, so the failure
 * mode this guards against is a future field added to the private shape and
 * carelessly spread into the public one. The assertions are therefore against
 * an EXACT key list, not a "does not contain" — the latter only catches the
 * leaks somebody already thought of.
 */

/** Narrows away the null the resolver may return, with a clear failure. */
function must<T>(value: T | null): T {
  if (value === null) throw new Error('expected a public passport');
  return value;
}

interface Recorded {
  sql: string;
  params: unknown[];
}

/** A database stand-in that records statements and replays canned rows. */
function fakeDb(rowsFor: (sql: string) => Record<string, unknown>[]) {
  const statements: Recorded[] = [];
  return {
    statements,
    execute: async (query: SQL) => {
      const rendered = renderSql(query);
      statements.push({ sql: rendered.sql, params: rendered.params });
      return { rows: rowsFor(rendered.sql) };
    },
  };
}

const OWNER_ROW = {
  id: 'u1',
  display_name: 'Иван',
  home_city: 'София',
  public_show_activity: false,
  created_at: '2026-01-15T08:00:00.000Z',
};

function rowsFor(sql: string): Record<string, unknown>[] {
  if (sql.includes('FROM users') && sql.includes('public_handle =')) return [OWNER_ROW];
  if (sql.includes('points_ledger p')) {
    return [
      {
        kind: 'facility_added',
        at: '2026-02-03T16:30:00.000Z',
        facility_id: 'f1',
        municipality_id: 1,
        sports: ['football'],
        points: 10,
      },
    ];
  }
  if (sql.includes('AS facilities_added')) {
    return [
      {
        points: 10,
        facilities_added: 1,
        facilities_verified: 0,
        conditions_reported: 0,
        checkins: 0,
        member_since: '2026-01-15T08:00:00.000Z',
      },
    ];
  }
  if (sql.includes("date_trunc('month'")) {
    return [{ month: '2026-02', contributions: 1, checkins: 0 }];
  }
  return [];
}

describe('public passport projection', () => {
  it('exposes exactly the agreed fields and no others', async () => {
    const db = fakeDb(rowsFor);
    const passport = must(
      await publicPassport(db, 'a'.repeat(24), new Date('2026-03-01T12:00:00Z')),
    );

    expect(Object.keys(passport).sort()).toEqual([
      'activity',
      'badges',
      'displayName',
      'homeCity',
      'memberSince',
      'streaks',
      'totals',
    ]);
    expect(Object.keys(passport.totals).sort()).toEqual(['checkins', 'contributions', 'points']);
    expect(Object.keys(passport.streaks).sort()).toEqual([
      'currentDays',
      'currentWeeks',
      'longestDays',
      'longestWeeks',
    ]);
  });

  it('carries no facility, no email and no exact timestamp anywhere in the payload', async () => {
    const db = fakeDb(rowsFor);
    const passport = must(
      await publicPassport(db, 'a'.repeat(24), new Date('2026-03-01T12:00:00Z')),
    );
    const serialized = JSON.stringify(passport);

    // The stub's contribution is on facility f1 at 16:30 on 3 February. None of
    // that may survive into the public shape.
    expect(serialized).not.toContain('f1');
    expect(serialized).not.toContain('16:30');
    expect(serialized).not.toContain('2026-02-03');
    expect(serialized).not.toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(serialized).not.toContain('@');
  });

  it('dates badges to the month, never to the day', async () => {
    const db = fakeDb(rowsFor);
    const passport = must(
      await publicPassport(db, 'a'.repeat(24), new Date('2026-03-01T12:00:00Z')),
    );
    expect(passport.badges.length).toBeGreaterThan(0);
    for (const badge of passport.badges) {
      expect(Object.keys(badge).sort()).toEqual(['earnedMonth', 'slug']);
      expect(badge.earnedMonth).toMatch(/^\d{4}-\d{2}$/);
    }
    expect(passport.memberSince).toMatch(/^\d{4}-\d{2}$/);
  });

  it('shows earned badges only — unearned progress is activity data', async () => {
    const db = fakeDb(rowsFor);
    const passport = must(
      await publicPassport(db, 'a'.repeat(24), new Date('2026-03-01T12:00:00Z')),
    );
    // The stub has one contribution: 'first_contribution' is earned, the other
    // nine are not, and none of them appears.
    expect(passport.badges.map((badge) => badge.slug)).toEqual(['first_contribution']);
  });

  it('omits the monthly activity unless the member switched it on', async () => {
    const off = fakeDb(rowsFor);
    const hidden = must(
      await publicPassport(off, 'a'.repeat(24), new Date('2026-03-01T12:00:00Z')),
    );
    expect(hidden.activity).toBeNull();
    // …and never runs the query in that case, so there is nothing to leak.
    expect(off.statements.some((s) => s.sql.includes("date_trunc('month'"))).toBe(false);

    const on = fakeDb((sql) =>
      sql.includes('public_handle =')
        ? [{ ...OWNER_ROW, public_show_activity: true }]
        : rowsFor(sql),
    );
    const shown = must(await publicPassport(on, 'a'.repeat(24), new Date('2026-03-01T12:00:00Z')));
    expect(shown.activity).toEqual([{ month: '2026-02', contributions: 1, checkins: 0 }]);
  });

  it('bucketed activity carries a month and counts, nothing else', async () => {
    const on = fakeDb((sql) =>
      sql.includes('public_handle =')
        ? [{ ...OWNER_ROW, public_show_activity: true }]
        : rowsFor(sql),
    );
    const passport = must(
      await publicPassport(on, 'a'.repeat(24), new Date('2026-03-01T12:00:00Z')),
    );
    for (const month of passport.activity ?? []) {
      expect(Object.keys(month).sort()).toEqual(['checkins', 'contributions', 'month']);
    }
  });
});

describe('public passport resolution', () => {
  it('filters on visibility in SQL, not in the caller', async () => {
    const db = fakeDb(() => []);
    await publicPassport(db, 'a'.repeat(24));
    const lookup = db.statements[0]?.sql ?? '';
    expect(lookup).toContain("profile_visibility = 'public'");
    // Age is NOT a term in the lookup (migration 0020). Asserted as an absence
    // so reinstating the predicate is a failing test rather than a silent
    // un-publishing of members who opted in.
    expect(lookup).not.toContain('is_minor');
  });

  it('returns null for an unknown or private handle without distinguishing them', async () => {
    const db = fakeDb(() => []);
    expect(await publicPassport(db, 'a'.repeat(24))).toBeNull();
    // One statement: it never went on to read anybody's history.
    expect(db.statements).toHaveLength(1);
  });
});

describe('visibility updates', () => {
  it('publishes a minor exactly like anybody else', async () => {
    // The mirror image of the test that stood here until migration 0020: the
    // row says is_minor, and the function publishes it anyway because age is no
    // longer an input to the decision.
    const db = fakeDb(() => [
      {
        profile_visibility: 'private',
        public_handle: null,
        public_show_activity: false,
        is_minor: true,
      },
    ]);
    const handle = await setPassportVisibility(db, 'u1', { isPublic: true, showActivity: false });
    expect(handle).toMatch(/^[0-9a-f]{24}$/);
    expect(db.statements.some((s) => s.sql.includes('UPDATE users'))).toBe(true);
  });

  it('mints a handle on first publish and keeps it afterwards', async () => {
    const fresh = fakeDb(() => [
      {
        profile_visibility: 'private',
        public_handle: null,
        public_show_activity: false,
        is_minor: false,
      },
    ]);
    const minted = await setPassportVisibility(fresh, 'u1', {
      isPublic: true,
      showActivity: false,
    });
    expect(minted).toMatch(/^[0-9a-f]{24}$/);

    const existing = fakeDb(() => [
      {
        profile_visibility: 'private',
        public_handle: 'b'.repeat(24),
        public_show_activity: false,
        is_minor: false,
      },
    ]);
    // Re-publishing must not change the URL somebody has already shared.
    expect(
      await setPassportVisibility(existing, 'u1', { isPublic: true, showActivity: false }),
    ).toBe('b'.repeat(24));
  });

  it('writes no age predicate into the UPDATE', async () => {
    const db = fakeDb(() => [
      {
        profile_visibility: 'private',
        public_handle: null,
        public_show_activity: false,
        is_minor: false,
      },
    ]);
    await setPassportVisibility(db, 'u1', { isPublic: true, showActivity: false });
    const update = db.statements.find((s) => s.sql.includes('UPDATE users'))?.sql ?? '';
    // The belt-and-braces `AND is_minor = false` that guarded this statement
    // went with the CHECK in 0020. Its absence is asserted, not assumed.
    expect(update).not.toContain('is_minor');
  });
});

describe('newPublicHandle', () => {
  it('matches the shape the column CHECK enforces', () => {
    for (let i = 0; i < 50; i += 1) {
      expect(newPublicHandle()).toMatch(/^[0-9a-f]{24}$/);
    }
  });

  it('does not repeat', () => {
    const handles = new Set(Array.from({ length: 500 }, () => newPublicHandle()));
    expect(handles.size).toBe(500);
  });
});
