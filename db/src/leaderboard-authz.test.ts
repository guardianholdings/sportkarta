import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { leaderboard, memberStanding } from './leaderboard.js';

/**
 * The leaderboard's exclusion rule, ATTACKED at the query layer
 * (docs/ROADMAP.md §7, Stage 5.2 — "enforced at the query layer and attacked in
 * tests"; the rule itself was narrowed by migration 0020).
 *
 * THERE IS EXACTLY ONE RULE LEFT AND IT IS CONSENT. Appearing on a ranked
 * public list publishes a name next to an activity level, so it takes the
 * member's own opt-in. These tests give the member who withheld that opt-in the
 * highest score on the board and then try, by every route the schema allows, to
 * get them to appear — a test that only exercised the happy path would pass
 * against an implementation with the predicate in a React component.
 *
 * AGE IS NO LONGER A TERM. Until 0020 a minor was excluded by a legal constant,
 * with 0010's CHECK making a public minor unconstructible as a second layer.
 * The operator removed both on 2026-07-25 (minors are treated as adults), so
 * the MINOR fixture below is PUBLIC and every assertion about them is inverted:
 * they must appear, in every scope, and they must keep their standing when the
 * flag is set. That inversion is the regression test for the change — a
 * reinstated `is_minor` predicate anywhere fails here rather than silently
 * un-publishing somebody.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const CHAMPION = 'e2e_lb_champion';
const MINOR = 'e2e_lb_minor';
const PRIVATE = 'e2e_lb_private';
const RUNNER_UP = 'e2e_lb_runner_up';
const ALL = [CHAMPION, MINOR, PRIVATE, RUNNER_UP];

const HANDLES: Record<string, string> = {
  [CHAMPION]: '1111111111111111111111aa',
  [MINOR]: '2222222222222222222222bb',
  [PRIVATE]: '3333333333333333333333cc',
  [RUNNER_UP]: '4444444444444444444444dd',
};

describe.skipIf(!hasDb)('leaderboard eligibility (requires running database)', () => {
  let client: pg.Client;
  let db: { execute: (q: never) => Promise<{ rows: Record<string, unknown>[] }> };
  let facilityA: string;
  let facilityB: string;
  let municipalityA: number;
  let sportA: string;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    // Adapter matching the SqlRunner the module expects, driven by the same
    // rendered SQL the application sends.
    const { renderSql } = await import('./render-sql.js');
    db = {
      execute: async (query: never) => {
        const rendered = renderSql(query);
        const result = await client.query(rendered.sql, rendered.params);
        return { rows: result.rows as Record<string, unknown>[] };
      },
    };

    // Borrow two real facilities in distinct municipalities, as the moderation
    // authz test does: crowd rows cannot be cleaned up once referenced, and
    // inventing facilities would drift the statistics materialised views.
    const picked = await client.query<{
      id: string;
      municipality_id: number;
      sport_types: string[];
    }>(
      `SELECT DISTINCT ON (municipality_id) id, municipality_id, sport_types
         FROM facilities
        WHERE municipality_id IS NOT NULL AND array_length(sport_types, 1) > 0
        ORDER BY municipality_id, id
        LIMIT 2`,
    );
    const first = picked.rows[0];
    const second = picked.rows[1];
    if (!first || !second) throw new Error('need two facilities in distinct municipalities');
    facilityA = first.id;
    facilityB = second.id;
    municipalityA = first.municipality_id;
    sportA = first.sport_types[0] as string;
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [ALL]);
  }

  /**
   * Everyone public except PRIVATE, who is the one member withholding consent.
   *
   * The minor is created PUBLIC — a row the database refused to hold before
   * 0020 dropped `users_minor_profile_not_public` — and given the top score, so
   * a reinstated age predicate in the view or in a query shows up as a
   * disappearing rank 1 rather than as a subtle omission.
   */
  beforeEach(async () => {
    await cleanup();
    for (const id of ALL) {
      const isMinor = id === MINOR;
      const visibility = id === PRIVATE ? 'private' : 'public';
      await client.query(
        `INSERT INTO users (id, display_name, email, is_minor, profile_visibility, public_handle)
         VALUES ($1, $2, $3, $4, $5::profile_visibility, $6)`,
        [id, `Тест ${id}`, `${id}@example.org`, isMinor, visibility, HANDLES[id]],
      );
    }

    // The minor and the private member out-score everybody, on both facilities:
    // the minor must therefore hold rank 1, and any leak of the private member
    // puts them there too rather than somewhere easy to miss.
    const awards: [string, string, string, number][] = [
      [MINOR, facilityA, 'facility_added', 10],
      [MINOR, facilityB, 'facility_added', 10],
      [PRIVATE, facilityA, 'facility_added', 10],
      [PRIVATE, facilityB, 'facility_added', 10],
      [CHAMPION, facilityA, 'facility_added', 10],
      [CHAMPION, facilityB, 'facility_verified', 3],
      [RUNNER_UP, facilityA, 'facility_verified', 3],
    ];
    for (const [user, facility, event, points] of awards) {
      await client.query(
        `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key)
         VALUES ($1, $2::points_event, $3, $4, $5)`,
        [user, event, points, facility, `e2e_lb:${user}:${facility}:${event}`],
      );
    }
  });

  const scopes = () =>
    [
      { name: 'national', scope: { kind: 'national' } as const },
      { name: 'per city', scope: { kind: 'city', municipalityId: municipalityA } as const },
      { name: 'per sport', scope: { kind: 'sport', sport: sportA } as const },
    ] as const;

  it('ranks eligible members, highest first', async () => {
    const rows = await leaderboard(db as never, { scope: { kind: 'national' }, limit: 50 });
    const ours = rows.filter((row) => Object.values(HANDLES).includes(row.handle));
    // The published minor's 20 points beat the champion's 13. Before 0020 this
    // row could not exist at all.
    expect(ours[0]?.handle).toBe(HANDLES[MINOR]);
    expect(ours[0]?.points).toBe(20);
    expect(ours[1]?.handle).toBe(HANDLES[CHAMPION]);
    expect(ours[1]?.points).toBe(13);
    expect(ours[2]?.handle).toBe(HANDLES[RUNNER_UP]);
  });

  it('lets a minor publish at all — the CHECK that forbade it is gone', async () => {
    // The fixture already inserts the minor as public, so this asserts the
    // schema state directly: the statement 0010 refused now succeeds, straight
    // against Postgres with no application in the picture.
    await client.query(`UPDATE users SET profile_visibility = 'private' WHERE id = $1`, [MINOR]);
    await expect(
      client.query(`UPDATE users SET profile_visibility = 'public' WHERE id = $1`, [MINOR]),
    ).resolves.toBeDefined();
  });

  it('SHOWS a published minor in every scope, at the top of the board', async () => {
    for (const { name, scope } of scopes()) {
      for (const period of ['all_time', 'month'] as const) {
        const rows = await leaderboard(db as never, { scope, period, limit: 200 });
        expect(
          rows.map((row) => row.handle),
          `${name}/${period} dropped a published minor`,
        ).toContain(HANDLES[MINOR]);
      }
    }
  });

  it('NEVER shows a member who has not published their passport', async () => {
    for (const { name, scope } of scopes()) {
      const rows = await leaderboard(db as never, { scope, limit: 200 });
      expect(rows.map((row) => row.handle), `${name} leaked a private member`).not.toContain(
        HANDLES[PRIVATE],
      );
    }
  });

  it('gives a minor their own standing, in every scope', async () => {
    for (const { scope } of scopes()) {
      expect(await memberStanding(db as never, MINOR, { scope })).not.toBeNull();
    }
  });

  it('gives a private member no standing either', async () => {
    expect(await memberStanding(db as never, PRIVATE, {})).toBeNull();
  });

  it('KEEPS a member on the board when they are newly marked a minor', async () => {
    const before = await leaderboard(db as never, { limit: 200 });
    expect(before.map((r) => r.handle)).toContain(HANDLES[CHAMPION]);

    // Exactly what a member entering their date of birth now does — the flag
    // alone, with no demotion (apps/web/lib/profile.ts stopped touching
    // visibility in 0020, because a profile save is not a consent decision).
    await client.query(`UPDATE users SET is_minor = true WHERE id = $1`, [CHAMPION]);

    const after = await leaderboard(db as never, { limit: 200 });
    expect(after.map((r) => r.handle)).toContain(HANDLES[CHAMPION]);
    expect(await memberStanding(db as never, CHAMPION, {})).not.toBeNull();
  });

  it('drops a member the moment they make their passport private again', async () => {
    await client.query(`UPDATE users SET profile_visibility = 'private' WHERE id = $1`, [CHAMPION]);
    const rows = await leaderboard(db as never, { limit: 200 });
    expect(rows.map((r) => r.handle)).not.toContain(HANDLES[CHAMPION]);
  });

  it('the view itself excludes the unconsenting member — no application code in the picture', async () => {
    // The guarantee has to survive somebody writing a new query by hand, so it
    // is asserted against the view directly rather than through the module.
    // PRIVATE is absent; the minor is present.
    const result = await client.query<{ id: string }>(
      `SELECT id FROM leaderboard_eligible_members WHERE id = ANY($1::text[])`,
      [ALL],
    );
    const visible = result.rows.map((row) => row.id).sort();
    expect(visible).toEqual([CHAMPION, RUNNER_UP, MINOR].sort());
  });

  it('a hand-written ranking that joins the view inherits the protection', async () => {
    // The realistic future mistake: a new slice written straight in SQL. As
    // long as it joins the view, forgetting the rule is not possible.
    const result = await client.query<{ id: string }>(
      `SELECT m.id
         FROM points_ledger p
         JOIN leaderboard_eligible_members m ON m.id = p.user_id
        WHERE p.user_id = ANY($1::text[])
        GROUP BY m.id`,
      [ALL],
    );
    expect(result.rows.map((r) => r.id).sort()).toEqual([CHAMPION, RUNNER_UP, MINOR].sort());
  });

  it('a member who never consented is absent however their row is otherwise shaped', async () => {
    // The remaining rule, attacked from the other side: the private member has a
    // handle and every other attribute of an eligible one. Consent is the only
    // thing they lack, and it is the only thing that matters.
    const handles = await client.query<{ public_handle: string }>(
      `SELECT public_handle FROM users WHERE id = $1`,
      [PRIVATE],
    );
    expect(handles.rows[0]?.public_handle).toBe(HANDLES[PRIVATE]);

    const result = await client.query<{ id: string }>(
      `SELECT id FROM leaderboard_eligible_members WHERE id = $1`,
      [PRIVATE],
    );
    expect(result.rows).toHaveLength(0);
  });

  it('scopes actually narrow — a sport-specific board is not the national one', async () => {
    const national = await leaderboard(db as never, { scope: { kind: 'national' }, limit: 200 });
    const city = await leaderboard(db as never, {
      scope: { kind: 'city', municipalityId: municipalityA },
      limit: 200,
    });
    const championNational = national.find((r) => r.handle === HANDLES[CHAMPION]);
    const championCity = city.find((r) => r.handle === HANDLES[CHAMPION]);
    // 13 points nationally (10 + 3), but only the 10 earned in municipality A.
    expect(championNational?.points).toBe(13);
    expect(championCity?.points).toBe(10);
  });

  it('ties share a rank rather than inventing a difference', async () => {
    await client.query(
      `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key)
       VALUES ($1, 'facility_verified'::points_event, 10, $2, $3)`,
      [RUNNER_UP, facilityB, 'e2e_lb:tie'],
    );
    const rows = await leaderboard(db as never, { limit: 200 });
    const champion = rows.find((r) => r.handle === HANDLES[CHAMPION]);
    const runnerUp = rows.find((r) => r.handle === HANDLES[RUNNER_UP]);
    expect(champion?.points).toBe(13);
    expect(runnerUp?.points).toBe(13);
    expect(champion?.rank).toBe(runnerUp?.rank);
  });
});
