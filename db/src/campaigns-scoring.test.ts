import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  adminStandings,
  campaignBySlug,
  campaignStanding,
  closeCampaign,
  frozenResults,
  publicStandings,
  type CampaignRow,
} from './campaigns.js';
import { renderSql } from './render-sql.js';

/**
 * Campaign scoring against real Postgres (docs/ROADMAP.md §7, Stage 5.3).
 *
 * Three things are attacked here rather than demonstrated:
 *
 *  1. A minor must never be NAMED on a public individual board, while still
 *     being counted — a campaign that silently excludes under-18s from
 *     competing is the wrong product for a youth-sport NGO, and one that names
 *     them publicly breaks a binding legal constant.
 *  2. An aggregate city row backed by too few members must be SUPPRESSED,
 *     because otherwise "counting minors is safe, nobody is named" stops being
 *     true the moment a municipality has one contributor.
 *  3. Closing must FREEZE. New events after the close must not move a published
 *     result, and a second close must not renumber the winners.
 *
 * Integration test against the dev/CI database; skips without DATABASE_URL.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

const ADULT_PUBLIC = 'e2e_cmp_public';
const ADULT_PRIVATE = 'e2e_cmp_private';
const MINOR = 'e2e_cmp_minor';
const RUNNER_UP = 'e2e_cmp_runner';
const MEMBERS = [ADULT_PUBLIC, ADULT_PRIVATE, MINOR, RUNNER_UP];

const HANDLES: Record<string, string> = {
  [ADULT_PUBLIC]: 'aaaa1111bbbb2222cccc3333',
  [RUNNER_UP]: 'dddd4444eeee5555ffff6666',
};

const SLUG = 'e2e-test-campaign';

describe.skipIf(!hasDb)('campaign scoring (requires running database)', () => {
  let client: pg.Client;
  let db: {
    execute: (q: never) => Promise<{ rows: Record<string, unknown>[] }>;
    transaction: <T>(fn: (tx: never) => Promise<T>) => Promise<T>;
  };
  let facilities: { id: string; municipalityId: number; sport: string; quarter: string | null }[];

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    const runner = {
      execute: async (query: never) => {
        const rendered = renderSql(query);
        const result = await client.query(rendered.sql, rendered.params);
        return { rows: result.rows as Record<string, unknown>[] };
      },
    };
    db = {
      ...runner,
      transaction: async <T>(fn: (tx: never) => Promise<T>): Promise<T> => {
        await client.query('BEGIN');
        try {
          const out = await fn(runner as never);
          await client.query('COMMIT');
          return out;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      },
    };

    const picked = await client.query<{
      id: string;
      municipality_id: number;
      sport_types: string[];
      quarter: string | null;
    }>(
      `SELECT id, municipality_id, sport_types, quarter
         FROM facilities
        WHERE municipality_id IS NOT NULL AND array_length(sport_types, 1) > 0
        ORDER BY municipality_id, id
        LIMIT 6`,
    );
    facilities = picked.rows.map((row) => ({
      id: row.id,
      municipalityId: row.municipality_id,
      sport: row.sport_types[0] as string,
      quarter: row.quarter,
    }));
    if (facilities.length < 3) throw new Error('need at least three facilities');
  });

  afterAll(async () => {
    await cleanup();
    await client.end();
  });

  async function cleanup(): Promise<void> {
    await client.query(`DELETE FROM campaigns WHERE slug = $1`, [SLUG]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [MEMBERS]);
  }

  /**
   * The campaign window is a FIXED RANGE IN THE PAST that no real data
   * occupies. The dev database is shared and full of genuine ledger rows, and a
   * campaign covering "today" would score all of them — so the assertions here
   * would depend on whatever else happens to be in the database, which is how a
   * suite becomes flaky and then ignored. Scoring is window-bounded, so a 2019
   * window plus 2019 fixtures is complete isolation without deleting or
   * mutating anything shared.
   */
  const WINDOW_START = '2019-03-01';
  const WINDOW_END = '2019-03-10';

  async function makeCampaign(overrides: {
    scopeKind?: string;
    municipalityId?: number | null;
    quarter?: string | null;
    leaderboardType?: string;
    rules?: unknown;
  } = {}): Promise<CampaignRow> {
    await client.query(`DELETE FROM campaigns WHERE slug = $1`, [SLUG]);
    await client.query(
      `INSERT INTO campaigns (slug, status, scope_kind, municipality_id, quarter,
                              starts_on, ends_on, leaderboard_type, template, rules, title_bg)
       VALUES ($1, 'published', $2::campaign_scope_kind, $3, $4,
               $7::date, $8::date,
               $5::campaign_leaderboard_type, 'standard', $6::jsonb, 'Тестова кампания')`,
      [
        SLUG,
        overrides.scopeKind ?? 'national',
        overrides.municipalityId ?? null,
        overrides.quarter ?? null,
        overrides.leaderboardType ?? 'individual',
        JSON.stringify(
          overrides.rules ?? {
            events: [
              { kind: 'facility_added', weight: 10 },
              { kind: 'facility_verified', weight: 3 },
            ],
          },
        ),
        WINDOW_START,
        WINDOW_END,
      ],
    );
    const campaign = await campaignBySlug(db as never, SLUG);
    if (!campaign) throw new Error('campaign not created');
    return campaign;
  }

  /**
   * An award on a given civil day, at midday Sofia so it is unambiguously
   * inside that day whichever offset applies.
   */
  async function award(
    userId: string,
    facilityIndex: number,
    event: string,
    day = '2019-03-02',
    tag = '',
  ): Promise<void> {
    const facility = facilities[facilityIndex];
    if (!facility) throw new Error('no such facility');
    const points = event === 'facility_added' ? 10 : 3;
    await client.query(
      `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key, created_at)
       VALUES ($1, $2::points_event, $3, $4, $5, ($6 || ' 12:00')::timestamp AT TIME ZONE 'Europe/Sofia')`,
      [userId, event, points, facility.id, `e2e_cmp:${userId}:${facility.id}:${event}:${tag}`, day],
    );
  }

  beforeEach(async () => {
    await cleanup();
    for (const id of MEMBERS) {
      const isMinor = id === MINOR;
      const handle = HANDLES[id] ?? null;
      await client.query(
        `INSERT INTO users (id, display_name, email, is_minor, profile_visibility, public_handle)
         VALUES ($1, $2, $3, $4, $5::profile_visibility, $6)`,
        [
          id,
          `Тест ${id}`,
          `${id}@example.org`,
          isMinor,
          handle ? 'public' : 'private',
          handle,
        ],
      );
    }
  });

  it('scores weighted event counts, not the ledger’s own points', async () => {
    const campaign = await makeCampaign();
    // One add (10) + one verify (3) = 13 under these weights.
    await award(ADULT_PUBLIC, 0, 'facility_added');
    await award(ADULT_PUBLIC, 1, 'facility_verified');
    const rows = await publicStandings(db as never, campaign);
    expect(rows.find((r) => r.handle === HANDLES[ADULT_PUBLIC])?.score).toBe(13);
  });

  it('applies different weights than the global points economy', async () => {
    // A verify is worth 3 points globally but 50 in this campaign.
    const campaign = await makeCampaign({
      rules: { events: [{ kind: 'facility_verified', weight: 50 }] },
    });
    await award(ADULT_PUBLIC, 0, 'facility_verified');
    const rows = await publicStandings(db as never, campaign);
    expect(rows[0]?.score).toBe(50);
  });

  it('ignores events outside the civil window', async () => {
    const campaign = await makeCampaign();
    await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', 'inside');
    // Two days before the window opens.
    await award(ADULT_PUBLIC, 1, 'facility_added', '2019-02-27', 'outside');
    const rows = await publicStandings(db as never, campaign);
    expect(rows.find((r) => r.handle === HANDLES[ADULT_PUBLIC])?.score).toBe(10);
  });

  it('ignores events outside a city scope', async () => {
    const home = facilities[0];
    const away = facilities.find((f) => f.municipalityId !== home?.municipalityId);
    if (!home || !away) return; // dev db has a single municipality; nothing to prove
    const campaign = await makeCampaign({
      scopeKind: 'city',
      municipalityId: home.municipalityId,
    });
    await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', 'home');
    await award(ADULT_PUBLIC, facilities.indexOf(away), 'facility_added', '2019-03-02', 'away');
    const rows = await publicStandings(db as never, campaign);
    expect(rows.find((r) => r.handle === HANDLES[ADULT_PUBLIC])?.score).toBe(10);
  });

  /**
   * The cap is two tests rather than one, because the ledger is append-only:
   * there is no way to clear a member's rows mid-test (the trigger refuses,
   * correctly — they leave only with the account), so each half needs the fresh
   * fixture that beforeEach provides.
   */
  const cappedRules = { events: [{ kind: 'facility_added', weight: 10 }], perDayCap: 10 };

  it('caps a member’s score within one Sofia civil day', async () => {
    const campaign = await makeCampaign({ rules: cappedRules });
    // Three adds on the SAME day: 30 uncapped, 10 capped.
    await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', 'a');
    await award(ADULT_PUBLIC, 1, 'facility_added', '2019-03-02', 'b');
    await award(ADULT_PUBLIC, 2, 'facility_added', '2019-03-02', 'c');
    const rows = await publicStandings(db as never, campaign);
    expect(rows.find((r) => r.handle === HANDLES[ADULT_PUBLIC])?.score).toBe(10);
  });

  it('applies the cap per day, so spreading the same work scores more', async () => {
    const campaign = await makeCampaign({ rules: cappedRules });
    await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', 'd1');
    await award(ADULT_PUBLIC, 1, 'facility_added', '2019-03-03', 'd2');
    const rows = await publicStandings(db as never, campaign);
    expect(rows.find((r) => r.handle === HANDLES[ADULT_PUBLIC])?.score).toBe(20);
  });

  it('restricts scoring to the campaign’s sports when one is set', async () => {
    const sport = facilities[0]?.sport as string;
    const other = facilities.find((f) => f.sport !== sport);
    const campaign = await makeCampaign({
      rules: { events: [{ kind: 'facility_added', weight: 10 }], sports: [sport] },
    });
    await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', 'matching');
    const rows = await publicStandings(db as never, campaign);
    expect(rows.find((r) => r.handle === HANDLES[ADULT_PUBLIC])?.score).toBe(10);
    if (other) {
      // A facility not carrying the campaign sport contributes nothing.
      await award(ADULT_PRIVATE, facilities.indexOf(other), 'facility_added', '2019-03-02', 'other');
      const admin = await adminStandings(db as never, campaign);
      expect(admin.find((r) => r.userId === ADULT_PRIVATE)).toBeUndefined();
    }
  });

  describe('who is named', () => {
    it('counts a minor but NEVER names them on a public individual board', async () => {
      const campaign = await makeCampaign();
      // The minor out-scores everyone.
      await award(MINOR, 0, 'facility_added', '2019-03-02', 'm1');
      await award(MINOR, 1, 'facility_added', '2019-03-03', 'm2');
      await award(ADULT_PUBLIC, 2, 'facility_added', '2019-03-02', 'a1');

      const publicBoard = await publicStandings(db as never, campaign);
      expect(publicBoard.map((r) => r.displayName)).not.toContain(`Тест ${MINOR}`);
      expect(publicBoard.map((r) => r.handle)).not.toContain(null);

      // …but they ARE scored, and the organisers can see them to award a prize.
      const admin = await adminStandings(db as never, campaign);
      const minorRow = admin.find((r) => r.userId === MINOR);
      expect(minorRow?.score).toBe(20);
      expect(minorRow?.rank).toBe(1);
      expect(minorRow?.isMinor).toBe(true);
    });

    it('lets a minor see their own standing', async () => {
      const campaign = await makeCampaign();
      await award(MINOR, 0, 'facility_added');
      const standing = await campaignStanding(db as never, campaign, MINOR);
      expect(standing?.score).toBe(10);
    });

    it('counts an unpublished member but does not name them publicly', async () => {
      const campaign = await makeCampaign();
      await award(ADULT_PRIVATE, 0, 'facility_added', '2019-03-02', 'p1');
      await award(ADULT_PRIVATE, 1, 'facility_added', '2019-03-03', 'p2');

      const publicBoard = await publicStandings(db as never, campaign);
      expect(publicBoard.find((r) => r.displayName === `Тест ${ADULT_PRIVATE}`)).toBeUndefined();

      const admin = await adminStandings(db as never, campaign);
      expect(admin.find((r) => r.userId === ADULT_PRIVATE)?.score).toBe(20);
      expect(admin.find((r) => r.userId === ADULT_PRIVATE)?.isPublic).toBe(false);
    });

    it('numbers the public board 1,2,3 without gaps advertising hidden competitors', async () => {
      const campaign = await makeCampaign();
      await award(MINOR, 0, 'facility_added', '2019-03-02', 'top');
      await award(ADULT_PUBLIC, 1, 'facility_added', '2019-03-02', 'second');
      await award(RUNNER_UP, 2, 'facility_verified', '2019-03-02', 'third');

      const publicBoard = await publicStandings(db as never, campaign);
      expect(publicBoard.map((r) => r.rank)).toEqual([1, 2]);
    });
  });

  describe('aggregate city board', () => {
    it('suppresses a municipality with too few contributing members', async () => {
      const campaign = await makeCampaign({ leaderboardType: 'city' });
      // Two members only — below CITY_BOARD_MIN_MEMBERS.
      await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', 'c1');
      await award(MINOR, 1, 'facility_added', '2019-03-02', 'c2');
      const rows = await publicStandings(db as never, campaign);
      expect(rows).toHaveLength(0);
    });

    it('names no individual, so a minor may be counted in it', async () => {
      const campaign = await makeCampaign({ leaderboardType: 'city' });
      await award(MINOR, 0, 'facility_added', '2019-03-02', 'x');
      const rows = await publicStandings(db as never, campaign);
      for (const row of rows) {
        expect(row.displayName).toBeNull();
        expect(row.handle).toBeNull();
      }
    });
  });

  describe('closing freezes the standings', () => {
    it('writes a snapshot and marks the campaign closed', async () => {
      const campaign = await makeCampaign();
      await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', 'f1');
      await award(RUNNER_UP, 1, 'facility_verified', '2019-03-02', 'f2');

      const report = await closeCampaign(db as never, campaign);
      expect(report.alreadyClosed).toBe(false);
      expect(report.frozenRows).toBe(2);

      const reloaded = await campaignBySlug(db as never, SLUG);
      expect(reloaded?.status).toBe('closed');
      expect(reloaded?.closedAt).not.toBeNull();
    });

    it('does NOT move when new events arrive afterwards', async () => {
      const campaign = await makeCampaign();
      await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', 'g1');
      await closeCampaign(db as never, campaign);
      const before = await frozenResults(db as never, campaign.id);

      // A latecomer who would have won, arriving after the close.
      await award(RUNNER_UP, 1, 'facility_added', '2019-03-02', 'late1');
      await award(RUNNER_UP, 2, 'facility_added', '2019-03-02', 'late2');

      const after = await frozenResults(db as never, campaign.id);
      expect(after).toEqual(before);
      expect(after.map((r) => r.handle)).not.toContain(HANDLES[RUNNER_UP]);
    });

    it('refuses a second close rather than renumbering the winners', async () => {
      const campaign = await makeCampaign();
      await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', 'h1');
      await closeCampaign(db as never, campaign);

      const reloaded = await campaignBySlug(db as never, SLUG);
      const second = await closeCampaign(db as never, reloaded as CampaignRow);
      expect(second.alreadyClosed).toBe(true);
      expect(second.frozenRows).toBe(0);
      expect(await frozenResults(db as never, campaign.id)).toHaveLength(1);
    });

    it('freezes members who cannot be named, so placings are not renumbered', async () => {
      const campaign = await makeCampaign();
      await award(MINOR, 0, 'facility_added', '2019-03-02', 'i1');
      await award(ADULT_PUBLIC, 1, 'facility_verified', '2019-03-02', 'i2');
      await closeCampaign(db as never, campaign);

      const frozen = await frozenResults(db as never, campaign.id);
      // Two rows: the minor's placing is real and first, just not nameable.
      expect(frozen).toHaveLength(2);
      expect(frozen[0]?.rank).toBe(1);
      expect(frozen[0]?.handle).toBeNull();
      expect(frozen[0]?.withheld).toBe(true);
      expect(frozen[1]?.handle).toBe(HANDLES[ADULT_PUBLIC]);
    });

    it('withdraws a name but keeps the placing when a member goes private', async () => {
      const campaign = await makeCampaign();
      await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', 'j1');
      await closeCampaign(db as never, campaign);
      expect((await frozenResults(db as never, campaign.id))[0]?.displayName).toBe(
        `Тест ${ADULT_PUBLIC}`,
      );

      await client.query(`UPDATE users SET profile_visibility = 'private' WHERE id = $1`, [
        ADULT_PUBLIC,
      ]);
      const after = await frozenResults(db as never, campaign.id);
      expect(after[0]?.rank).toBe(1);
      expect(after[0]?.score).toBe(10);
      expect(after[0]?.displayName).toBeNull();
      expect(after[0]?.withheld).toBe(true);
    });

    it('survives the erasure of a frozen member without blocking the delete', async () => {
      const campaign = await makeCampaign();
      await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', 'k1');
      await closeCampaign(db as never, campaign);

      // The 0009 trap: campaign_results.user_id is ON DELETE SET NULL, so a
      // stricter "exactly one subject" CHECK would abort this forever.
      await expect(
        client.query(`DELETE FROM users WHERE id = $1`, [ADULT_PUBLIC]),
      ).resolves.toBeDefined();

      const after = await frozenResults(db as never, campaign.id);
      expect(after).toHaveLength(1);
      expect(after[0]?.rank).toBe(1);
      expect(after[0]?.score).toBe(10);
      expect(after[0]?.displayName).toBeNull();
    });
  });
});
