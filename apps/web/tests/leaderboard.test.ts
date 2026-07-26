import { leaderboard, memberStanding, monthStart, renderSql, type SQL } from '@sportkarta/db';
import { describe, expect, it } from 'vitest';

import { scopeHref } from '@/lib/leaderboard';

/**
 * Leaderboard query shape and scoping (docs/ROADMAP.md §7, Stage 5.2).
 *
 * The adversarial companion to this file is db/src/leaderboard-authz.test.ts,
 * which attacks the consent rule against real Postgres. What is asserted HERE is
 * the thing a DB test cannot see: that the statements the application actually
 * builds join the eligibility view rather than the users table. A query that
 * read `users` directly would pass every DB test written against the view and
 * still publish somebody who never opted in.
 */

/**
 * Strips SQL line comments before matching. A comment that mentions the users
 * table is harmless; a FROM users is the bug. Without this the assertion below
 * would be satisfied by deleting a comment, which is not the property wanted.
 */
function code(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

function fakeDb(rows: Record<string, unknown>[] = []) {
  const statements: { sql: string; params: unknown[] }[] = [];
  return {
    statements,
    execute: async (query: SQL) => {
      const rendered = renderSql(query);
      statements.push(rendered);
      return { rows };
    },
  };
}

const NOW = new Date('2026-07-23T09:00:00Z');

describe('leaderboard query', () => {
  it('ranks through the eligibility view and never through the users table', async () => {
    const db = fakeDb();
    await leaderboard(db, { now: NOW });
    const statement = code(db.statements[0]?.sql ?? '');

    expect(statement).toContain('leaderboard_eligible_members');
    // The whole protection rests on this: no leaderboard statement may read
    // `users`, because the view is where "consented" lives.
    expect(statement).not.toMatch(/\busers\b/);
  });

  it('does the same for a member’s own standing', async () => {
    const db = fakeDb();
    await memberStanding(db, 'u1', { now: NOW });
    const statement = code(db.statements[0]?.sql ?? '');
    expect(statement).toContain('leaderboard_eligible_members');
    expect(statement).not.toMatch(/\busers\b/);
  });

  it('adds no scope predicate for the national board', async () => {
    const db = fakeDb();
    await leaderboard(db, { scope: { kind: 'national' }, now: NOW });
    const statement = code(db.statements[0]?.sql ?? '');
    expect(statement).not.toContain('municipality_id =');
    expect(statement).not.toContain('sport_types');
  });

  it('filters by municipality for a city board', async () => {
    const db = fakeDb();
    await leaderboard(db, { scope: { kind: 'city', municipalityId: 42 }, now: NOW });
    expect(db.statements[0]?.sql).toContain('f.municipality_id =');
    expect(db.statements[0]?.params).toContain(42);
  });

  it('filters by sport membership for a sport board', async () => {
    const db = fakeDb();
    await leaderboard(db, { scope: { kind: 'sport', sport: 'football' }, now: NOW });
    expect(db.statements[0]?.sql).toContain('ANY(f.sport_types)');
    expect(db.statements[0]?.params).toContain('football');
  });

  it('adds no time predicate for the all-time board', async () => {
    const db = fakeDb();
    await leaderboard(db, { period: 'all_time', now: NOW });
    expect(db.statements[0]?.sql).not.toContain('created_at >=');
  });

  it('bounds the month board at the Sofia civil month, not 30 days back', async () => {
    const db = fakeDb();
    await leaderboard(db, { period: 'month', now: NOW });
    expect(db.statements[0]?.sql).toContain('p.created_at >=');
    // 1 July 2026 00:00 in Sofia is 30 June 21:00 UTC (EEST, +3).
    expect(db.statements[0]?.params).toContain('2026-06-30T21:00:00.000Z');
  });

  it('clamps the page size rather than trusting a caller', async () => {
    const huge = fakeDb();
    await leaderboard(huge, { limit: 100_000, now: NOW });
    expect(huge.statements[0]?.params).toContain(200);

    const tiny = fakeDb();
    await leaderboard(tiny, { limit: -5, now: NOW });
    expect(tiny.statements[0]?.params).toContain(1);
  });

  it('shares a rank between ties instead of ordering them arbitrarily', async () => {
    const db = fakeDb();
    await leaderboard(db, { now: NOW });
    const statement = code(db.statements[0]?.sql ?? '');
    expect(statement).toContain('rank() OVER');
    expect(statement).not.toContain('row_number() OVER');
    // Display tie-break: who reached the total first.
    expect(statement).toContain('min(p.created_at)');
  });
});

describe('monthStart', () => {
  it('is the first instant of the Sofia month, across both DST offsets', () => {
    // July: EEST (+3) — 1 July 00:00 local is 30 June 21:00Z.
    expect(monthStart(new Date('2026-07-23T09:00:00Z')).toISOString()).toBe(
      '2026-06-30T21:00:00.000Z',
    );
    // January: EET (+2) — 1 January 00:00 local is 31 December 22:00Z.
    expect(monthStart(new Date('2026-01-15T09:00:00Z')).toISOString()).toBe(
      '2025-12-31T22:00:00.000Z',
    );
  });

  it('uses the Sofia calendar to decide which month it is', () => {
    // 30 June 21:30Z is already 1 July in Sofia, so the month is July.
    expect(monthStart(new Date('2026-06-30T21:30:00Z')).toISOString()).toBe(
      '2026-06-30T21:00:00.000Z',
    );
    // An hour earlier it is still June.
    expect(monthStart(new Date('2026-06-30T20:30:00Z')).toISOString()).toBe(
      '2026-05-31T21:00:00.000Z',
    );
  });
});

describe('scopeHref', () => {
  it('builds the canonical URL for each scope', () => {
    expect(scopeHref({})).toBe('/klasirane');
    expect(scopeHref({ citySlug: 'sofia' })).toBe('/klasirane?grad=sofia');
    expect(scopeHref({ sport: 'football' })).toBe('/klasirane?sport=football');
    expect(scopeHref({ period: 'month' })).toBe('/klasirane?period=mesec');
    expect(scopeHref({ citySlug: 'plovdiv', period: 'month' })).toBe(
      '/klasirane?grad=plovdiv&period=mesec',
    );
  });

  it('never emits both dimensions at once', () => {
    expect(scopeHref({ citySlug: 'sofia', sport: 'football' })).toBe('/klasirane?grad=sofia');
  });

  it('omits the default period rather than pinning it in every link', () => {
    expect(scopeHref({ citySlug: 'sofia', period: 'all_time' })).toBe('/klasirane?grad=sofia');
  });
});
