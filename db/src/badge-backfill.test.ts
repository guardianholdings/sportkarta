import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  badgeEvaluationCandidates,
  evaluateAndRecordBadges,
  recordEarnedBadges,
} from './passport.js';

/**
 * The retroactive backfill must be SILENT (docs/ENGAGEMENT-IMPLEMENTATION.md,
 * phase 3 / A1; operator decision 2026-07-26).
 *
 * Badges are derived and retroactive: the engine folds a member's whole history,
 * so the first evaluation of an account that has been contributing for months
 * earns its entire back catalogue at once. That was invisible while evaluation
 * only ran on a /pasport render — the row simply did not exist until the member
 * looked. Moving evaluation into a job fixes the real bug and creates this one:
 * without a cutoff, every existing member is handed their whole back catalogue
 * as "new" the first time the job runs.
 *
 * The mechanism under test is deliberately NOT a `silent: boolean` flag. A flag
 * makes the backfill and the live path two different code paths, and then the
 * ORDER between them matters — a contribution arriving before the backfill
 * reached that member would still produce the burst. Expressed as a cutoff ("a
 * badge is new only if it was earned just now"), both paths are the same call
 * and the race cannot happen. These tests pin that property, not the flag.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const USER_ID = 'e2e_badge_backfill';
const QUIET_ID = 'e2e_badge_quiet';

interface Runner {
  execute(query: { queryChunks?: unknown }): Promise<{ rows: Record<string, unknown>[] }>;
}

describe.skipIf(!hasDb)('badge backfill (requires running database)', () => {
  let client: pg.Client;
  let db: Runner;
  let facilityId: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const facility = await client.query<{ id: string }>(
      `SELECT id FROM facilities ORDER BY created_at, id LIMIT 1`,
    );
    facilityId = facility.rows[0]?.id ?? '';
    // The db/src helpers take a drizzle-shaped runner; adapt the raw client.
    const { drizzle } = await import('drizzle-orm/node-postgres');
    db = drizzle(client) as unknown as Runner;
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  beforeEach(async () => {
    await cleanup();
    for (const [id, email] of [
      [USER_ID, 'badge-backfill@example.org'],
      [QUIET_ID, 'badge-quiet@example.org'],
    ]) {
      await client.query(`INSERT INTO users (id, display_name, email) VALUES ($1, 'Тест', $2)`, [
        id,
        email,
      ]);
    }
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [[USER_ID, QUIET_ID]]);
  }

  /** An award placed at a chosen instant, so "historical" is real, not mocked. */
  async function award(key: string, at: Date, userId = USER_ID): Promise<void> {
    await client.query(
      `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key, created_at)
       VALUES ($1, 'facility_added', 10, $2::uuid, $3, $4::timestamptz)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [userId, facilityId, key, at.toISOString()],
    );
  }

  async function badgeRows(
    userId = USER_ID,
  ): Promise<{ badge_slug: string; seen_at: Date | null }[]> {
    const result = await client.query<{ badge_slug: string; seen_at: Date | null }>(
      `SELECT badge_slug, seen_at FROM user_badges WHERE user_id = $1 ORDER BY badge_slug`,
      [userId],
    );
    return result.rows;
  }

  it('records a long-standing history as ALREADY SEEN, so nothing lights up', async () => {
    const now = new Date();
    const longAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    await award('backfill:old', longAgo);

    const recorded = await evaluateAndRecordBadges(db as never, USER_ID, {
      now,
      unseenSince: new Date(now.getTime() - 60 * 60 * 1000),
    });

    expect(recorded.length).toBeGreaterThan(0);
    const rows = await badgeRows();
    expect(rows.length).toBe(recorded.length);
    // THE PROPERTY: every historical badge is written already-seen.
    for (const row of rows) {
      expect(row.seen_at, `${row.badge_slug} should not be marked new`).not.toBeNull();
    }
  });

  it('records a badge earned JUST NOW as unseen, so a real award still lights up', async () => {
    const now = new Date();
    await award('backfill:fresh', now);

    await evaluateAndRecordBadges(db as never, USER_ID, {
      now,
      unseenSince: new Date(now.getTime() - 60 * 60 * 1000),
    });

    const rows = await badgeRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.seen_at === null)).toBe(true);
  });

  it('is the SAME call on both paths, so a mid-backfill contribution is not a race', async () => {
    // A member with old history who contributes again right now: the old badges
    // stay silent and only what they just earned is new — regardless of whether
    // the backfill or the live job got there first.
    const now = new Date();
    await award('backfill:mixed-old', new Date(now.getTime() - 200 * 24 * 60 * 60 * 1000));
    const cutoff = new Date(now.getTime() - 60 * 60 * 1000);

    // Live path first, then the backfill sweeps the same member.
    await evaluateAndRecordBadges(db as never, USER_ID, { now, unseenSince: cutoff });
    const afterFirst = await badgeRows();
    await evaluateAndRecordBadges(db as never, USER_ID, { now, unseenSince: cutoff });
    const afterSecond = await badgeRows();

    // ON CONFLICT DO NOTHING: the second pass changes nothing at all.
    expect(afterSecond.length).toBe(afterFirst.length);
    for (const row of afterSecond) expect(row.seen_at).not.toBeNull();
  });

  it('without a cutoff, everything is unseen (the pre-existing /pasport behaviour)', async () => {
    const now = new Date();
    await award('backfill:nocutoff', new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000));

    await evaluateAndRecordBadges(db as never, USER_ID, { now });

    const rows = await badgeRows();
    expect(rows.length).toBeGreaterThan(0);
    // Every row unseen — an interactive passport render still wants this.
    for (const row of rows) expect(row.seen_at).toBeNull();
  });

  it('recordEarnedBadges never resurrects a badge that was already seen', async () => {
    const now = new Date();
    const earned = [{ slug: 'first_contribution', earnedAt: new Date(now.getTime() - 1000) }];
    await recordEarnedBadges(db as never, USER_ID, earned, { unseenSince: now });
    await client.query(`UPDATE user_badges SET seen_at = now() WHERE user_id = $1`, [USER_ID]);
    // A later evaluation must not clear seen_at back to NULL.
    await recordEarnedBadges(db as never, USER_ID, earned, {});
    const rows = await badgeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.seen_at).not.toBeNull();
  });

  it('only enumerates members who could hold a badge at all', async () => {
    await award('backfill:candidate', new Date());
    const candidates = await badgeEvaluationCandidates(db as never);
    expect(candidates).toContain(USER_ID);
    // QUIET_ID has an account but no ledger row, so folding its empty history
    // would be pure cost.
    expect(candidates).not.toContain(QUIET_ID);
  });
});
