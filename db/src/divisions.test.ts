import { DIVISION_MIN_MEMBERS } from '@sportkarta/lib/divisions';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { divisionCandidates, runDivisionRollover, weekBounds, weekStandings } from './divisions.js';

/**
 * Weekly divisions against real Postgres.
 *
 * The properties pinned here are the ones no unit test can reach, because they
 * are properties of the SQL rather than of the fold:
 *
 *  1. CONSENT IS ENFORCED BY THE JOIN. A member who has not published their
 *     passport produces no row, even when they are sitting in the group table.
 *     This is the rule migration 0011's view exists for and that operator
 *     decision 3 of 2026-07-26 chose over anonymous rows.
 *  2. RANKS ARE CONTIGUOUS AFTER THAT JOIN. 1, 2, 3 — never 1, 2, 4, which would
 *     advertise the existence of a hidden competitor and is therefore a
 *     disclosure about somebody who declined to be disclosed.
 *  3. THE WEEK IS A WINDOW. A point earned the minute before Monday 00:00 Sofia
 *     belongs to the previous week and must not score.
 *  4. THE FLOOR WRITES NOTHING. Not "renders nothing" — nothing is written, so
 *     there is no ladder for any surface to decide about.
 *  5. WEEK ONE BOOTSTRAPS ITSELF. There is no seeding job; the first run finds no
 *     history and starts everybody at the entry tier.
 *
 * Integration test; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

/**
 * A Monday FAR in the future, and that is load-bearing.
 *
 * `divisionCandidates` selects every eligible member with points in the four
 * weeks before the week it is assigning — it has no notion of "the fixture's"
 * members, and it must not, because that is the query production runs. A week
 * near today therefore sweeps in whatever the dev database happens to hold, and
 * the exact-count assertions below drift by however many real accounts scored
 * recently. That is not a flaky test; it is a test that was measuring the dev
 * database. `guardEmptyWindow` asserts the isolation instead of assuming it, so
 * a future dev fixture landing in 2028 fails loudly with a reason.
 */
const WEEK = '2028-03-06';
const PREV = '2028-02-28';

interface Runner {
  execute(query: { queryChunks?: unknown }): Promise<{ rows: Record<string, unknown>[] }>;
}

describe.skipIf(!hasDb)('divisions (requires running database)', () => {
  let client: pg.Client;
  let db: Runner;
  let facilityId = '';

  const memberId = (n: number) => `e2e_div_${String(n).padStart(2, '0')}`;
  /** `users_public_handle_shape` pins a handle to exactly 24 hex characters. */
  const handleFor = (n: number) => `deadbeefdeadbeef${String(n).padStart(8, '0')}`;

  /** Creates a member; `visible` decides whether the eligibility view sees them. */
  async function member(n: number, visible = true): Promise<string> {
    const id = memberId(n);
    await client.query(
      `INSERT INTO users (id, display_name, email, email_verified, public_handle, profile_visibility)
       VALUES ($1, $2, $3, true, $4, $5)
       ON CONFLICT (id) DO UPDATE SET profile_visibility = EXCLUDED.profile_visibility,
                                      public_handle = EXCLUDED.public_handle`,
      [
        id,
        `Div ${String(n)}`,
        `${id}@example.test`,
        visible ? handleFor(n) : null,
        visible ? 'public' : 'private',
      ],
    );
    return id;
  }

  /** Awards `points` to a member at an instant inside (or outside) a week. */
  async function award(userId: string, at: Date, points: number, seq: number): Promise<void> {
    await client.query(
      `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key, created_at)
       VALUES ($1, 'facility_verified', $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [userId, points, facilityId, `e2e_div_${userId}_${String(seq)}`, at.toISOString()],
    );
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    const { drizzle } = await import('drizzle-orm/node-postgres');
    db = drizzle(client) as unknown as Runner;

    const facility = await client.query(
      `SELECT id::text AS id FROM facilities WHERE status <> 'gone' LIMIT 1`,
    );
    facilityId = String(facility.rows[0]?.id ?? '');
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM division_members WHERE user_id LIKE 'e2e_div_%'`);
    await client.query(`DELETE FROM division_groups WHERE week_start IN ($1::date, $2::date)`, [
      WEEK,
      PREV,
    ]);
    // points_ledger is append-only: `forbid_points_ledger_mutation()` refuses a
    // direct DELETE and permits one only when the owning account is already
    // going. So the fixture leaves through the SAME door a real erasure uses —
    // drop the users and let the cascade take the ledger rows.
    await client.query(`DELETE FROM users WHERE id LIKE 'e2e_div_%'`);
  }

  beforeEach(async () => {
    await cleanup();
  });

  /**
   * Proves the week under test is empty of ambient data BEFORE counting
   * anything. Without this the exact-count assertions silently measure whatever
   * the dev database holds rather than what the fixture put there.
   */
  async function guardEmptyWindow(): Promise<void> {
    const { from } = weekBounds(WEEK);
    const ambient = await divisionCandidates(db, WEEK, { now: from });
    expect(
      ambient,
      'the test week must have no ambient candidates — move WEEK further out',
    ).toEqual([]);
  }

  it('scores only points earned inside the week', async () => {
    const id = await member(1);
    const { from, to } = weekBounds(WEEK);
    await award(id, new Date(from.getTime() - 1000), 10, 1); // one second before Monday
    await award(id, new Date(from.getTime() + 60_000), 3, 2); // inside
    await award(id, to, 7, 3); // the next week's first instant

    const group = await client.query(
      `INSERT INTO division_groups (week_start, tier, ordinal) VALUES ($1::date, 1, 1) RETURNING id`,
      [WEEK],
    );
    const groupId = Number(group.rows[0].id);
    await client.query(
      `INSERT INTO division_members (group_id, user_id, week_start) VALUES ($1, $2, $3::date)`,
      [groupId, id, WEEK],
    );

    const rows = await weekStandings(db, WEEK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.score).toBe(3);
  });

  /**
   * THE TEST THIS FILE EXISTS FOR. A member sitting in the group table who has
   * since made their passport private must vanish from the ladder AND leave no
   * gap behind them.
   */
  it('drops a member who is not eligible, and closes the ranks behind them', async () => {
    const group = await client.query(
      `INSERT INTO division_groups (week_start, tier, ordinal) VALUES ($1::date, 2, 1) RETURNING id`,
      [WEEK],
    );
    const groupId = Number(group.rows[0].id);
    const { from } = weekBounds(WEEK);

    // Three public members and one who has gone private, deliberately given the
    // SECOND-highest score so removing them would leave a hole at rank 2.
    for (const [n, points, visible] of [
      [1, 30, true],
      [2, 20, false],
      [3, 10, true],
      [4, 5, true],
    ] as const) {
      const id = await member(n, visible);
      await award(id, new Date(from.getTime() + 60_000 * n), points, n);
      await client.query(
        `INSERT INTO division_members (group_id, user_id, week_start) VALUES ($1, $2, $3::date)`,
        [groupId, id, WEEK],
      );
    }

    const rows = await weekStandings(db, WEEK);
    expect(rows.map((r) => r.userId)).toEqual([memberId(1), memberId(3), memberId(4)]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    // group_size counts the VISIBLE field, so the relegation band is computed
    // over what the member can actually see.
    expect(rows.every((r) => r.groupSize === 3)).toBe(true);
    // Belt and braces: the private member's handle and name appear nowhere.
    expect(JSON.stringify(rows)).not.toContain(handleFor(2));
    expect(JSON.stringify(rows)).not.toContain('Div 2');
  });

  it('writes nothing below the floor', async () => {
    await guardEmptyWindow();
    const { from } = weekBounds(WEEK);
    for (let n = 1; n < DIVISION_MIN_MEMBERS; n += 1) {
      const id = await member(n);
      await award(id, new Date(from.getTime() - 24 * 3600_000), 5, n);
    }

    const report = await runDivisionRollover(db, WEEK, { now: from });
    expect(report.belowFloor).toBe(true);
    expect(report.members).toBe(0);

    const groups = await client.query(
      `SELECT count(*)::int AS n FROM division_groups WHERE week_start = $1::date`,
      [WEEK],
    );
    expect(Number(groups.rows[0].n)).toBe(0);
  });

  /**
   * Week one is the general case with an empty left-hand side — there is no
   * separate bootstrap job, which is the whole reason this is asserted.
   */
  it('bootstraps week one at the entry tier with no history at all', async () => {
    await guardEmptyWindow();
    const { from } = weekBounds(WEEK);
    for (let n = 1; n <= DIVISION_MIN_MEMBERS; n += 1) {
      const id = await member(n);
      await award(id, new Date(from.getTime() - 24 * 3600_000), 5, n);
    }

    const candidates = await divisionCandidates(db, WEEK, { now: from });
    expect(candidates).toHaveLength(DIVISION_MIN_MEMBERS);
    expect(candidates.every((c) => c.previousTier === null)).toBe(true);

    const report = await runDivisionRollover(db, WEEK, { now: from });
    expect(report.belowFloor).toBe(false);
    expect(report.members).toBe(DIVISION_MIN_MEMBERS);
    expect(report.groups).toBe(1);

    const tiers = await client.query(
      `SELECT DISTINCT g.tier FROM division_groups g WHERE g.week_start = $1::date`,
      [WEEK],
    );
    expect(tiers.rows.map((r) => Number(r.tier))).toEqual([1]);
  });

  it('re-running a week adds nothing and raises nothing', async () => {
    await guardEmptyWindow();
    const { from } = weekBounds(WEEK);
    for (let n = 1; n <= DIVISION_MIN_MEMBERS; n += 1) {
      const id = await member(n);
      await award(id, new Date(from.getTime() - 24 * 3600_000), 5, n);
    }

    const first = await runDivisionRollover(db, WEEK, { now: from });
    const second = await runDivisionRollover(db, WEEK, { now: from });
    expect(second).toEqual(first);

    const rows = await client.query(
      `SELECT count(*)::int AS n FROM division_members WHERE week_start = $1::date`,
      [WEEK],
    );
    expect(Number(rows.rows[0].n)).toBe(DIVISION_MIN_MEMBERS);
  });

  /**
   * A member with no points in the activity window is not assigned at all — a
   * ladder padded with dormant accounts hands every active member a top finish
   * for turning up once.
   */
  it('excludes a member with no recent points', async () => {
    await guardEmptyWindow();
    const { from } = weekBounds(WEEK);
    const dormant = await member(99);
    await award(dormant, new Date(from.getTime() - 400 * 24 * 3600_000), 10, 99);
    for (let n = 1; n <= DIVISION_MIN_MEMBERS; n += 1) {
      const id = await member(n);
      await award(id, new Date(from.getTime() - 24 * 3600_000), 5, n);
    }

    const candidates = await divisionCandidates(db, WEEK, { now: from });
    expect(candidates.map((c) => c.userId)).not.toContain(dormant);
  });
});
