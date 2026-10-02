import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  adminStandings,
  campaignBySlug,
  campaignQuarters,
  campaignStanding,
  closeCampaign,
  frozenResults,
  publicStandings,
  quarterHasFacilities,
  type CampaignRow,
} from './campaigns.js';
import { renderSql } from './render-sql.js';

/**
 * Campaign scoring against real Postgres (docs/ROADMAP.md §7, Stage 5.3).
 *
 * Three things are attacked here rather than demonstrated:
 *
 *  1. NAMING FOLLOWS CONSENT AND NOTHING ELSE. A member who published their
 *     passport is named on the public individual board whatever their age
 *     (migration 0020 — minors are treated as adults, so the MINOR fixture here
 *     is PUBLIC and expected to appear); a member who did not is counted, is
 *     visible to organisers so a prize can be handed over, and is never named.
 *     The old form of this test asserted the opposite for minors; it is kept in
 *     mirror image rather than deleted, because "counted but not named" is
 *     still the property that can silently break.
 *  2. An aggregate city row backed by too few members must be SUPPRESSED,
 *     because otherwise "nobody is named in an aggregate" stops being true the
 *     moment a municipality has one contributor.
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
/**
 * Enough extra members to clear CITY_BOARD_MIN_MEMBERS on their own, created only
 * by the city-attribution test. Private: a city board counts everyone.
 */
const CITY_MEMBERS = [1, 2, 3, 4, 5].map((n) => `e2e_cmp_city_${String(n)}`);

const HANDLES: Record<string, string> = {
  [ADULT_PUBLIC]: 'aaaa1111bbbb2222cccc3333',
  [RUNNER_UP]: 'dddd4444eeee5555ffff6666',
  // A minor WITH a handle — i.e. published, and therefore nameable. Before 0020
  // this row was unconstructible (users_minor_profile_not_public). The
  // unnameable role in these tests belongs to ADULT_PRIVATE, who withheld
  // consent, which is now the only reason anybody is unnameable.
  [MINOR]: '9999777788886666555544cc',
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
    // Fixture sessions go before their organiser: erasing the organiser only
    // NULLs organizer_id (and cancels the series), leaving the rows behind.
    await client.query(`DELETE FROM play_sessions WHERE organizer_id = ANY($1::text[])`, [MEMBERS]);
    await client.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [
      [...MEMBERS, ...CITY_MEMBERS],
    ]);
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

  async function makeCampaign(
    overrides: {
      scopeKind?: string;
      municipalityId?: number | null;
      quarter?: string | null;
      leaderboardType?: string;
      rules?: unknown;
      status?: string;
    } = {},
  ): Promise<CampaignRow> {
    await client.query(`DELETE FROM campaigns WHERE slug = $1`, [SLUG]);
    await client.query(
      `INSERT INTO campaigns (slug, status, scope_kind, municipality_id, quarter,
                              starts_on, ends_on, leaderboard_type, template, rules, title_bg)
       VALUES ($1, $9::campaign_status, $2::campaign_scope_kind, $3, $4,
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
        overrides.status ?? 'published',
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
    await awardAt(userId, facility.id, event, day, tag);
  }

  /** `award`, for a facility that is not one of the six picked in beforeAll. */
  async function awardAt(
    userId: string,
    facilityId: string,
    event: string,
    day: string,
    tag: string,
  ): Promise<void> {
    const points = event === 'facility_added' ? 10 : 3;
    await client.query(
      `INSERT INTO points_ledger (user_id, event, points, facility_id, idempotency_key, created_at)
       VALUES ($1, $2::points_event, $3, $4, $5, ($6 || ' 12:00')::timestamp AT TIME ZONE 'Europe/Sofia')`,
      [userId, event, points, facilityId, `e2e_cmp:${userId}:${facilityId}:${event}:${tag}`, day],
    );
  }

  /** A one-off series on a facility, organised by a fixture member so cleanup finds it. */
  async function playSession(facilityId: string, sport: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO play_sessions
         (facility_id, sport, organizer_id, title, starts_at_local, duration_minutes)
       VALUES ($1::uuid, $2, $3, 'Тестова игра', '2019-03-02T12:00:00'::timestamp, 90)
       RETURNING id`,
      [facilityId, sport, RUNNER_UP],
    );
    return result.rows[0]?.id ?? '';
  }

  /**
   * A QR check-in at midday Sofia on `day`, in that day's occurrence of the
   * series (created on first use). starts_at_local is derived by Postgres, so the
   * 0008 verify-local-clock trigger agrees with it whatever the offset.
   */
  async function qrCheckin(userId: string, sessionId: string, day: string): Promise<void> {
    const occurrence = await client.query<{ id: string }>(
      `INSERT INTO play_session_occurrences (session_id, starts_at, ends_at, starts_at_local)
       SELECT $1::uuid, x.t, x.t + interval '90 minutes', x.t AT TIME ZONE 'Europe/Sofia'
       FROM (SELECT ($2 || ' 12:00')::timestamp AT TIME ZONE 'Europe/Sofia' AS t) x
       ON CONFLICT (session_id, starts_at) DO UPDATE SET ends_at = EXCLUDED.ends_at
       RETURNING id`,
      [sessionId, day],
    );
    await client.query(
      `INSERT INTO play_session_checkins (occurrence_id, user_id, method, checked_in_at)
       VALUES ($1::uuid, $2, 'qr', ($3 || ' 12:30')::timestamp AT TIME ZONE 'Europe/Sofia')`,
      [occurrence.rows[0]?.id, userId, day],
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
        [id, `Тест ${id}`, `${id}@example.org`, isMinor, handle ? 'public' : 'private', handle],
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
      await award(
        ADULT_PRIVATE,
        facilities.indexOf(other),
        'facility_added',
        '2019-03-02',
        'other',
      );
      const admin = await adminStandings(db as never, campaign);
      expect(admin.find((r) => r.userId === ADULT_PRIVATE)).toBeUndefined();
    }
  });

  it('filters ATTENDANCE by the sport played, not by the facility’s sport list', async () => {
    // The audit's reproduction: a sport campaign, and a facility that carries
    // the campaign sport. Somebody playing a DIFFERENT sport on that same
    // facility used to score, because the filter read f.sport_types — so a
    // footballer on a pitch with a hoop led a "basketball month".
    const facility = facilities[0];
    if (!facility) throw new Error('no facility');
    const sport = facility.sport;
    const other = sport === 'volleyball' ? 'tennis' : 'volleyball';
    const campaign = await makeCampaign({
      rules: { events: [{ kind: 'session_checkin', weight: 1 }], sports: [sport] },
    });
    const played = await playSession(facility.id, sport);
    const elsewhere = await playSession(facility.id, other);

    await qrCheckin(RUNNER_UP, played, '2019-03-02');
    await qrCheckin(RUNNER_UP, played, '2019-03-03');
    for (const day of ['2019-03-02', '2019-03-03', '2019-03-04']) {
      await qrCheckin(ADULT_PUBLIC, elsewhere, day);
    }

    const admin = await adminStandings(db as never, campaign);
    expect(admin.find((r) => r.userId === RUNNER_UP)?.score).toBe(2);
    expect(admin.find((r) => r.userId === ADULT_PUBLIC)).toBeUndefined();
  });

  describe('who is named', () => {
    it('names a minor who published their passport, exactly like anyone else', async () => {
      const campaign = await makeCampaign();
      // The minor out-scores everyone — a leak in either direction lands at
      // rank 1 rather than somewhere easy to miss.
      await award(MINOR, 0, 'facility_added', '2019-03-02', 'm1');
      await award(MINOR, 1, 'facility_added', '2019-03-03', 'm2');
      await award(ADULT_PUBLIC, 2, 'facility_added', '2019-03-02', 'a1');

      const publicBoard = await publicStandings(db as never, campaign);
      const minorRow = publicBoard.find((r) => r.handle === HANDLES[MINOR]);
      expect(minorRow?.displayName).toBe(`Тест ${MINOR}`);
      expect(minorRow?.rank).toBe(1);
      expect(minorRow?.score).toBe(20);
      // Still no nameless row on a board that names people.
      expect(publicBoard.map((r) => r.handle)).not.toContain(null);

      // The admin board carries the same score and NO age datum at all —
      // adminStandings deliberately stopped selecting is_minor in 0020.
      const admin = await adminStandings(db as never, campaign);
      const adminRow = admin.find((r) => r.userId === MINOR);
      expect(adminRow?.score).toBe(20);
      expect(adminRow?.rank).toBe(1);
      expect(adminRow).not.toHaveProperty('isMinor');
    });

    it('lets a minor see their own standing', async () => {
      const campaign = await makeCampaign();
      await award(MINOR, 0, 'facility_added');
      const standing = await campaignStanding(db as never, campaign, MINOR);
      expect(standing?.score).toBe(10);
    });

    it('gives a member their score but no rank that could contradict the board', async () => {
      // One public member behind two unpublished ones: the public board lists
      // them 1st, the frozen placing will say 3rd. The own-score card used to
      // print the 3rd beside the 1st; it now carries no rank at all.
      const campaign = await makeCampaign();
      await award(ADULT_PRIVATE, 0, 'facility_added', '2019-03-02', 'r1');
      await award(ADULT_PRIVATE, 1, 'facility_added', '2019-03-03', 'r2');
      await award(RUNNER_UP, 2, 'facility_added', '2019-03-02', 'r3');
      await client.query(`UPDATE users SET profile_visibility = 'private' WHERE id = $1`, [
        RUNNER_UP,
      ]);
      await award(ADULT_PUBLIC, 0, 'facility_verified', '2019-03-02', 'r4');

      const board = await publicStandings(db as never, campaign);
      expect(board.map((r) => [r.handle, r.rank])).toEqual([[HANDLES[ADULT_PUBLIC], 1]]);

      const standing = await campaignStanding(db as never, campaign, ADULT_PUBLIC);
      expect(standing).toEqual({ score: 3, events: 1 });
      expect(standing).not.toHaveProperty('rank');
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
      // The hidden top scorer is the member who withheld consent — since 0020
      // that is the only kind of hidden competitor there is.
      await award(ADULT_PRIVATE, 0, 'facility_added', '2019-03-02', 'top');
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

    it('credits a member to where they were most active, not to their busiest day', async () => {
      // The audit's reproduction. Each of five members reports on three quiet
      // days at home and on one busier day away. Home is where their campaign
      // happened; the old rule (the municipality of the single best DAY, itself
      // the highest id touched that day) moved every point away and dropped
      // home off the board entirely.
      const places = await client.query<{ id: string; municipality_id: number }>(
        `SELECT DISTINCT ON (municipality_id) id, municipality_id
           FROM facilities
          WHERE municipality_id IS NOT NULL
          ORDER BY municipality_id, id
          LIMIT 2`,
      );
      const [home, away] = places.rows;
      if (!home || !away) return; // a single-municipality dev db has nothing to prove

      const campaign = await makeCampaign({
        leaderboardType: 'city',
        rules: { events: [{ kind: 'condition_reported', weight: 1 }] },
      });
      for (const id of CITY_MEMBERS) {
        await client.query(`INSERT INTO users (id, display_name, email) VALUES ($1, $2, $3)`, [
          id,
          `Тест ${id}`,
          `${id}@example.org`,
        ]);
        for (const day of ['2019-03-02', '2019-03-03', '2019-03-04']) {
          await awardAt(id, home.id, 'condition_reported', day, `home-${day}`);
        }
        await awardAt(id, away.id, 'condition_reported', '2019-03-05', 'away-1');
        await awardAt(id, away.id, 'condition_reported', '2019-03-05', 'away-2');
      }

      const live = await publicStandings(db as never, campaign);
      expect(live.map((r) => [r.municipalityId, r.score, r.memberCount])).toEqual([
        [home.municipality_id, 25, 5],
      ]);

      // The close-out snapshot reads the same totals, so it attributes the same way.
      await closeCampaign(db as never, campaign);
      const frozen = await frozenResults(db as never, campaign.id);
      expect(frozen.map((r) => [r.municipalityId, r.score, r.memberCount])).toEqual([
        [home.municipality_id, 25, 5],
      ]);
    });

    it('names no individual at all, whoever contributed to the row', async () => {
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
    it('refuses to close while the window is still open', async () => {
      const campaign = await makeCampaign();
      await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', 'open1');

      // 22:00 Sofia on the LAST day (EET, +2): still running, so still refused.
      const early = await closeCampaign(db as never, campaign, {
        now: new Date('2019-03-10T20:00:00Z'),
      });
      expect(early).toEqual({ frozenRows: 0, alreadyClosed: false, notClosable: true });
      expect((await campaignBySlug(db as never, SLUG))?.status).toBe('published');
      expect(await frozenResults(db as never, campaign.id)).toHaveLength(0);

      // 00:30 Sofia the next day — the window is over and closing is allowed.
      const onTime = await closeCampaign(db as never, campaign, {
        now: new Date('2019-03-10T22:30:00Z'),
      });
      expect(onTime.notClosable).toBe(false);
      expect(onTime.frozenRows).toBe(1);
    });

    it('refuses to close a draft or a cancelled campaign', async () => {
      for (const status of ['draft', 'cancelled']) {
        const campaign = await makeCampaign({ status });
        await award(ADULT_PUBLIC, 0, 'facility_added', '2019-03-02', `st-${status}`);
        const report = await closeCampaign(db as never, campaign);
        expect(report).toEqual({ frozenRows: 0, alreadyClosed: false, notClosable: true });
        expect((await campaignBySlug(db as never, SLUG))?.status).toBe(status);
      }
    });

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
      await award(ADULT_PRIVATE, 0, 'facility_added', '2019-03-02', 'i1');
      await award(ADULT_PUBLIC, 1, 'facility_verified', '2019-03-02', 'i2');
      await closeCampaign(db as never, campaign);

      const frozen = await frozenResults(db as never, campaign.id);
      // Two rows: the unpublished member's placing is real and first, just not
      // nameable.
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

  describe('quarter scope', () => {
    /**
     * The quarter scope is an exact match against facilities.quarter, which is
     * sparse. The form now offers only campaignQuarters(), and the action refuses
     * anything quarterHasFacilities() cannot find. Read-only against the shared
     * facility corpus: nothing here writes a quarter onto a real facility.
     */
    it('offers only quarters a facility actually carries', async () => {
      const options = await campaignQuarters(db as never);
      for (const option of options.slice(0, 10)) {
        expect(option.facilities).toBeGreaterThan(0);
        expect(await quarterHasFacilities(db as never, option.municipalityId, option.quarter)).toBe(
          true,
        );
      }
    });

    it('knows when a quarter matches nothing', async () => {
      const municipalityId = facilities[0]?.municipalityId ?? 1;
      expect(
        await quarterHasFacilities(db as never, municipalityId, 'e2e-няма-такъв-квартал'),
      ).toBe(false);
    });

    it('scores a quarter campaign at a facility in that quarter', async () => {
      const [option] = await campaignQuarters(db as never);
      if (!option) return; // no quarter data in this database; nothing to score
      const facility = await client.query<{ id: string }>(
        `SELECT id FROM facilities WHERE municipality_id = $1 AND quarter = $2 ORDER BY id LIMIT 1`,
        [option.municipalityId, option.quarter],
      );
      const campaign = await makeCampaign({
        scopeKind: 'quarter',
        municipalityId: option.municipalityId,
        quarter: option.quarter,
      });
      await awardAt(ADULT_PUBLIC, facility.rows[0]?.id ?? '', 'facility_added', '2019-03-02', 'q');
      const rows = await publicStandings(db as never, campaign);
      expect(rows.find((r) => r.handle === HANDLES[ADULT_PUBLIC])?.score).toBe(10);
    });
  });
});

describe('campaign scoring counts VERIFIED attendance only (Stage 5.4)', () => {
  /**
   * A campaign is the one place in the product where gaming attendance wins a
   * real PRIZE, so a self-attested tap — a button somebody pressed at home —
   * must not count towards one. Stage 5.4's `only_qr_scores` CHECK governs
   * points_ledger; campaign scoring reads play_session_checkins DIRECTLY and so
   * needs its own filter, which is exactly the kind of second reader that gets
   * forgotten.
   *
   * Asserted on the compiled SQL rather than end-to-end: the surrounding suite
   * already runs these queries against real Postgres, so what is at risk is not
   * whether the SQL is valid but whether the predicate is still in it.
   */
  function compiledFor(
    kinds: { kind: string; weight: number }[],
    extra: { sports?: string[]; leaderboardType?: CampaignRow['leaderboardType'] } = {},
  ): string {
    const captured: string[] = [];
    const recorder = {
      execute: (query: never) => {
        captured.push(renderSql(query).sql);
        return Promise.resolve({ rows: [] });
      },
    };
    const campaign: CampaignRow = {
      id: '00000000-0000-4000-8000-0000000000c1',
      slug: 'test',
      status: 'published',
      scope: { kind: 'national' },
      window: { startsOn: '2026-07-01', endsOn: '2026-07-31' },
      leaderboardType: extra.leaderboardType ?? 'individual',
      template: 'standard',
      rules: {
        events: kinds,
        ...(extra.sports ? { sports: extra.sports } : {}),
      } as CampaignRow['rules'],
      titleBg: 'Тест',
      titleEn: null,
      blurbBg: null,
      blurbEn: null,
      prizeBg: null,
      prizeEn: null,
      partnerId: null,
      closedAt: null,
    };
    void campaignStanding(recorder as never, campaign, 'member_1');
    return captured.join('\n');
  }

  it('filters check-ins to the QR method', () => {
    const sqlText = compiledFor([{ kind: 'session_checkin', weight: 3 }]);
    expect(sqlText).toContain('play_session_checkins');
    expect(sqlText).toMatch(/c\.method\s*=\s*'qr'/);
  });

  it('does not filter on the scored flag — a capped attendance still counts', () => {
    // Someone who hit the daily points cap, or declined the location prompt,
    // still turned up. A campaign counts turning up, not being paid.
    const sqlText = compiledFor([{ kind: 'session_checkin', weight: 3 }]);
    expect(sqlText).not.toMatch(/c\.scored/);
  });

  it('filters attendance by the SESSION sport and contributions by the facility', () => {
    // Asserted on the SQL as well as end-to-end above, because this suite runs
    // without a database: the check-in branch must read s.sport, and the
    // facility's sport list must stay confined to the ledger branch.
    const sqlText = compiledFor(
      [
        { kind: 'facility_added', weight: 5 },
        { kind: 'session_checkin', weight: 1 },
      ],
      { sports: ['basketball'] },
    );
    const [ledgerBranch, checkinBranch] = sqlText.split('UNION ALL');
    expect(ledgerBranch).toMatch(/f\.sport_types\s*&&/);
    expect(checkinBranch).toMatch(/s\.sport\s*=\s*ANY\(/);
    expect(checkinBranch).not.toMatch(/f\.sport_types/);
  });

  it('chooses a member’s city by their whole campaign, not by one day', () => {
    // The home municipality is ranked over per-municipality totals; a
    // max(municipality_id) per day, or an ORDER BY day_score, is the old
    // best-day rule coming back.
    const sqlText = compiledFor([{ kind: 'condition_reported', weight: 1 }], {
      leaderboardType: 'city',
    });
    expect(sqlText).toMatch(/DISTINCT ON \(p\.user_id\)/);
    expect(sqlText).not.toMatch(/max\(e\.municipality_id\)/);
    expect(sqlText).not.toMatch(/ORDER BY d\.day_score/);
  });
});
